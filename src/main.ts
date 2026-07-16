import { InstanceBase, InstanceStatus, runEntrypoint } from '@companion-module/base'
import {
	SETTINGS,
	getConfigFields,
	getInteractivityProfile,
	normalizeInteractivity,
	type ModuleConfig,
} from './config.js'
import { UpgradeScripts } from './upgrades.js'
import { getActionDefinitions } from './actions.js'
import { bindActionClient } from './action-client.js'
import { getFeedbackDefinitions, gainKey } from './feedbacks.js'
import { getVariableDefinitions } from './variables.js'
import { getPresetDefinitions } from './presets.js'
import { parseSnapshotDatabase } from './snapshots.js'
import { formatBufferDiagnostic, formatStructuredDiagnostic } from './diagnostics.js'
import { NewtonTcpClient, isQueueRejection } from './protocol/tcp-client.js'
import { presetAudioReadOptions } from './preset-audio.js'
import {
	parseClockSelected,
	parseClockStateResponse,
	parseImportDescriptionResponse,
	isFirmwareAtLeast,
	isLegacyAckResponse,
	isLegacyErrResponse,
	parseImportFirmwareResponse,
	parseImportSerialResponse,
	parseLegacyResponse,
	parsePriorityListResponse,
	parsePriorityPatchState,
	type PriorityPatchState,
} from './protocol/command-parser.js'
import {
	buildGetClockCommand,
	buildImportAudioPresetCommand,
	buildImportDescriptionCommand,
	buildImportFirmwareCommand,
	buildImportSerialCommand,
	buildReadPriorityListCommand,
	buildSnapshotGetDatabase,
} from './protocol/command-builder.js'
import {
	CLOCK_TYPE_COUNT,
	ChannelType,
	MIN_SNAPSHOT_FIRMWARE,
	SIGNALS_AUX_MIXER_PRIORITY_COUNT,
	SIGNALS_INPUT_DSP_PRIORITY_COUNT,
	SnapshotCmd,
} from './protocol/constants.js'
import { VuListener } from './protocol/vu-listener.js'
import type { GainReadState, NewtonActionResult, NewtonState, SPRResponse, SnapshotInfo } from './protocol/types.js'

// Must match the vu_in_N / vu_out_N variable counts defined in variables.ts.
const VU_INPUT_CHANNEL_COUNT = 16
const VU_OUTPUT_CHANNEL_COUNT = 16

// Every feedback that renders H2L priority state and must refresh together.
const PRIORITY_FEEDBACK_IDS = ['input_patch_monitor'] as const
// Feedbacks that render processing-clock state.
const CLOCK_FEEDBACK_IDS = ['clock_monitor'] as const

function createInitialNewtonState(): NewtonState {
	return {
		connected: false,
		deviceName: '',
		firmwareVersion: '',
		serialNumber: '',
		lastError: '',
		lastCommand: '',
		lastResponseHex: '',
		lastActionName: '',
		lastActionStatus: 'unknown',
		lastActionResponseHex: '',
		lastActionResults: new Map(),
		lastPriorityUpdate: '',
		lastVuUpdate: '',
		snapshotCount: 0,
		lastSnapshotResponse: '',
		lastAppliedSnapshot: '',
		priorityInputDsp: new Array(SIGNALS_INPUT_DSP_PRIORITY_COUNT).fill(-1),
		priorityAuxMixer: new Array(SIGNALS_AUX_MIXER_PRIORITY_COUNT).fill(-1),
		priorityLists: new Array(SIGNALS_INPUT_DSP_PRIORITY_COUNT).fill(null),
		priorityListsUnsupported: false,
		vuInputDsp: [],
		vuOutputDsp: [],
		vuInputDspRms: [],
		vuOutputDspRms: [],
		gainReads: new Map(),
		clockSelected: new Array(CLOCK_TYPE_COUNT).fill(-1),
		clockLists: new Array(CLOCK_TYPE_COUNT).fill(null),
		clockListsUnsupported: false,
		snapshotList: [],
		snapshotDatabaseLoaded: false,
		snapshotsUnsupported: false,
		vu: {
			selected: 'N/A',
			selectedPeak: 'N/A',
			selectedClip: 'N/A',
			rawLength: 0,
			rawFirstHex: '',
			format: 'No VU packets',
		},
	}
}

class NewtonInstance extends InstanceBase<ModuleConfig> {
	private client: NewtonTcpClient | null = null
	private vuListener: VuListener | null = null
	private pollTimer: ReturnType<typeof setInterval> | null = null
	private priorityPollTimer: ReturnType<typeof setInterval> | null = null
	/** One pending retry of the connect-time snapshot database read after queue backpressure. */
	private snapshotDbRetryTimer: ReturnType<typeof setTimeout> | null = null
	private vuPublishTimer: ReturnType<typeof setTimeout> | null = null
	private lastVuPublish = 0
	private config: ModuleConfig = { host: '', interactivity: 'medium' }
	private destroyed = false
	// A reconnect can be the same IP hosting a replacement Newton. Keep the
	// previous labels visible while retrying, but re-read them before trusting
	// them for the new TCP session.
	private identityRefreshPending = true
	// Per-field one-shot success markers. Guards must key on read SUCCESS, not
	// on the value: an empty-but-valid field (unprovisioned serial, blank
	// device name) stored as '' would otherwise re-poll forever.
	private identityRead = { description: false, firmware: false, serial: false }
	// Per-control references let paired Success/Error feedbacks share one
	// stored outcome without retaining results for controls that no longer use
	// the feedback.
	private lastActionFeedbackRefs = new Map<string, number>()

	// Single source of truth for variables and feedbacks. Protocol handlers
	// update this object first, then publish the small subset Companion needs.
	private state: NewtonState = createInitialNewtonState()

	// controlId -> input number, written by the rearm label feedback and read
	// by the 'rearm_this_input' action so one option drives the whole button.
	private rearmTargets = new Map<string, number>()

	// feedback-instance id -> channel shown on Levels & Mute buttons. The set
	// determines whether the full preset-audio refresh is needed at all.
	private gainSubs = new Map<string, { channelType: number; channelIndex: number }>()
	// Read-modify-write gain/mute actions retain this lock across definition
	// refreshes, so snapshot/config updates cannot reopen a same-channel race.
	private gainMutationQueues = new Map<string, Promise<void>>()

	// controlId -> clock type, written by the clock rearm label feedback and
	// read by the 'rearm_this_clock' action.
	private clockRearmTargets = new Map<string, number>()

	// controlId -> snapshot uuid, written by the snapshot label feedback and
	// read by the 'apply_this_snapshot' action.
	private snapshotTargets = new Map<string, string>()

	// controlId -> channel, written by the channel-mute feedback and read by
	// the 'mute_this_channel' action.
	private muteTargets = new Map<string, { channelType: number; channelIndex: number }>()

	async init(config: ModuleConfig): Promise<void> {
		this.destroyed = false
		this.config = { host: config.host ?? '', interactivity: normalizeInteractivity(config.interactivity) }
		this.updateStatus(InstanceStatus.Disconnected)

		if (this.config.host) {
			this.connectToDevice()
		} else {
			this.updateStatus(InstanceStatus.BadConfig, 'No host configured')
		}
		// Definitions capture the newly created TCP client. If there is no host,
		// the offline binding returns a clear action failure until one is saved.
		this.setupDefinitions()

		if (this.config.host) this.startVuListener()
	}

	async destroy(): Promise<void> {
		this.destroyed = true
		this.stopPolling()
		this.stopPriorityPolling()
		this.stopPresetAudioPolling()
		this.clearSnapshotDatabaseRetry()
		this.stopVuListener()
		this.destroyClient()
	}

	async configUpdated(config: ModuleConfig): Promise<void> {
		const nextHost = config.host ?? ''
		const nextInteractivity = normalizeInteractivity(config.interactivity)
		const targetChanged = this.config.host !== nextHost
		const interactivityChanged = this.config.interactivity !== nextInteractivity

		// Saving an unchanged configuration must not abort a command currently in
		// flight. A profile-only update changes just the two cadence-dependent
		// paths: UDP status and the large 0x21 preset-audio poll.
		if (!targetChanged && !interactivityChanged) return

		this.config = { host: nextHost, interactivity: nextInteractivity }

		if (targetChanged) {
			this.stopPolling()
			this.stopPriorityPolling()
			this.stopPresetAudioPolling()
			this.stopVuListener()
			this.destroyClient()
			this.resetDeviceState()
			if (this.config.host) {
				this.connectToDevice()
				this.startVuListener()
			} else {
				this.updateStatus(InstanceStatus.BadConfig, 'No host configured')
			}
			// Snapshot choices are device-specific. Rebuild definitions only after
			// the replacement client exists, so old callbacks cannot resolve it.
			this.setupDefinitions()
		} else {
			this.lastVuPublish = 0
			this.stopPresetAudioPolling()
			if (this.config.host) {
				// VuListener fixes its interval at construction time, so recreate it
				// for the selected profile without touching TCP.
				this.startVuListener()
				if (!this.client) this.connectToDevice()
				else if (this.client.isConnected) this.startPresetAudioPolling()
			}
		}

		this.updateVariables()
		this.checkFeedbacks(
			...PRIORITY_FEEDBACK_IDS,
			...CLOCK_FEEDBACK_IDS,
			'connection_status',
			'connection_monitor',
			'channel_gain',
			'channel_mute',
			'snapshot_apply_label',
			'last_action_success',
			'last_action_error',
		)
	}

	private resetDeviceState(): void {
		this.state = createInitialNewtonState()
		this.lastVuPublish = 0
		this.identityRefreshPending = true
		this.identityRead = { description: false, firmware: false, serial: false }
		this.clearSnapshotDatabaseRetry()
	}

	private destroyClient(): void {
		const client = this.client
		this.client = null
		client?.destroy()
	}

	private isCurrentClient(client: NewtonTcpClient): boolean {
		return !this.destroyed && this.client === client
	}

	// Called on connection loss: a stale green/orange monitor button would be
	// worse than no indication at all, so priority state falls back to unknown.
	private clearPriorityState(): void {
		this.state.priorityInputDsp = new Array(SIGNALS_INPUT_DSP_PRIORITY_COUNT).fill(-1)
		this.state.priorityAuxMixer = new Array(SIGNALS_AUX_MIXER_PRIORITY_COUNT).fill(-1)
		this.state.priorityLists = new Array(SIGNALS_INPUT_DSP_PRIORITY_COUNT).fill(null)
		// Drop stale gain/mute reads so buttons show "--" instead of a frozen value.
		this.state.gainReads.clear()
		this.state.clockSelected = new Array(CLOCK_TYPE_COUNT).fill(-1)
		this.state.clockLists = new Array(CLOCK_TYPE_COUNT).fill(null)
	}

	getConfigFields() {
		return getConfigFields()
	}

	private setupDefinitions(): void {
		const actionClient = bindActionClient(this.client, SETTINGS.commandTimeoutMs, SETTINGS.actionQueueTtlMs)
		const actionLogger = {
			log: this.log.bind(this),
			reportActionResult: (result: NewtonActionResult) => this.handleActionResult(result),
			// A level action just changed a gain: refresh gain/mute buttons at
			// once instead of waiting for the next poll rotation.
			reportGainRead: (channelType: number, channelIndex: number, read: GainReadState) => {
				this.state.gainReads.set(gainKey(channelType, channelIndex), read)
				this.checkFeedbacks('channel_gain', 'channel_mute')
			},
		}

		this.setActionDefinitions(
			getActionDefinitions(
				actionClient,
				actionLogger,
				this.rearmTargets,
				this.clockRearmTargets,
				this.state.snapshotList,
				this.snapshotTargets,
				this.muteTargets,
				(channelType, channelIndex) => this.state.gainReads.get(gainKey(channelType, channelIndex)),
				() => this.state.snapshotsUnsupported,
				() => this.state.snapshotDatabaseLoaded,
				this.gainMutationQueues,
			),
		)
		this.setFeedbackDefinitions(
			getFeedbackDefinitions(
				() => this.state,
				this.rearmTargets,
				this.gainSubs,
				this.clockRearmTargets,
				this.snapshotTargets,
				this.state.snapshotList,
				this.muteTargets,
				this.lastActionFeedbackRefs,
			),
		)
		this.setVariableDefinitions(getVariableDefinitions())
		this.setPresetDefinitions(getPresetDefinitions())

		this.updateVariables()
		this.updateVuVariables()
	}

	private handleActionResult(result: NewtonActionResult): void {
		this.state.lastActionName = result.name
		this.state.lastActionStatus = result.success ? 'success' : 'error'
		this.state.lastActionResponseHex = result.responseHex
		if (result.controlId && this.lastActionFeedbackRefs.has(result.controlId)) {
			this.state.lastActionResults.set(result.controlId, result)
		}
		if (!result.success) this.state.lastError = result.error ?? `${result.name} failed`
		this.updateVariables()
		this.checkFeedbacks('last_action_success', 'last_action_error')
	}

	private connectToDevice(): void {
		if (this.destroyed || !this.config.host) return
		this.updateStatus(InstanceStatus.Connecting)

		const client = new NewtonTcpClient(this.config.host, SETTINGS.port)
		this.client = client

		client.on('connected', () => {
			if (!this.isCurrentClient(client)) return
			this.state.connected = true
			this.identityRefreshPending = true
			// A fresh connection may be a different device or firmware: give the
			// optional 0x91/0x81 list polling and the snapshot support detection
			// another chance.
			this.state.priorityListsUnsupported = false
			this.state.clockListsUnsupported = false
			this.state.snapshotsUnsupported = false
			// The snapshot set may have changed while we were away: mark the
			// database as unconfirmed (labels show a loading state for unknown
			// uuids) while keeping the last list as best-known dropdown content
			// until the re-read lands.
			this.state.snapshotDatabaseLoaded = false
			this.clearSnapshotDatabaseRetry()
			// Same address may host a replacement device: re-read the identity.
			this.identityRead = { description: false, firmware: false, serial: false }
			this.updateStatus(InstanceStatus.Ok)
			this.updateVariables()
			this.checkFeedbacks('connection_status', 'connection_monitor', 'snapshot_apply_label')
			this.log('info', `Connected to Newton at ${this.config.host}:${SETTINGS.port}`)

			void this.pollDeviceState()
			this.startPolling()
			// Check whether this firmware has snapshots, then populate the
			// snapshot-by-name dropdown.
			void this.initSnapshotSupport()
			// Firmware 0.98 rejects Get Gain (0x01); the documented live state
			// available on this hardware is the full preset-audio import (0x21).
			void this.pollPresetAudio()
			this.startPresetAudioPolling()

			if (SETTINGS.enablePriorityPolling) {
				void this.pollPriorityMetadata()
				this.startPriorityPolling()
			}
			if (!this.vuListener) this.startVuListener()
		})

		client.on('disconnected', () => {
			if (!this.isCurrentClient(client)) return
			this.state.connected = false
			this.clearPriorityState()
			this.updateStatus(InstanceStatus.Disconnected)
			this.updateVariables()
			this.checkFeedbacks(
				'connection_status',
				'connection_monitor',
				'channel_gain',
				'channel_mute',
				...PRIORITY_FEEDBACK_IDS,
				...CLOCK_FEEDBACK_IDS,
			)
			this.stopPolling()
			this.stopPriorityPolling()
			this.stopPresetAudioPolling()
			this.clearSnapshotDatabaseRetry()
			// The meter/status stream has its own UDP socket. Keep listening when
			// the command channel reconnects so live meter feedback remains
			// independent of the TCP session.
			this.log('warn', 'Disconnected from Newton device')
		})

		client.on('error', (err) => {
			if (!this.isCurrentClient(client)) return
			this.log('error', `Connection error: ${err.message}`)
			this.state.connected = false
			this.clearPriorityState()
			this.updateStatus(InstanceStatus.ConnectionFailure, err.message)
			this.updateVariables()
			this.checkFeedbacks(
				'connection_status',
				'connection_monitor',
				'channel_gain',
				'channel_mute',
				...PRIORITY_FEEDBACK_IDS,
				...CLOCK_FEEDBACK_IDS,
			)
		})

		client.on('statusChange', (status, message) => {
			if (!this.isCurrentClient(client)) return
			this.updateStatus(status, message ?? undefined)
		})

		client.on('rawData', (direction, data) => {
			if (!this.isCurrentClient(client)) return
			if (SETTINGS.debugLevel === 'verbose') {
				this.log('debug', `${direction}: [${formatBufferDiagnostic(data)}] (${data.length} bytes)`)
			}
		})

		client.on('commandResult', (result) => {
			if (!this.isCurrentClient(client)) return
			this.state.lastCommand = result.name
			this.state.lastResponseHex = formatBufferDiagnostic(result.rx)
			// A success clears the diagnostics variable, so one transient failure
			// cannot stay latched for the whole session (and triggers keyed on
			// last_error release). Operator-facing action errors stay visible in
			// last_action_* and the per-button feedbacks, which background
			// polling never touches.
			this.state.lastError = result.success ? '' : (result.error ?? 'Unknown command error')
			if (!result.success && SETTINGS.debugLevel !== 'off') {
				this.log('warn', `${result.name}: ${this.state.lastError} RX [${this.state.lastResponseHex}]`)
			}
			this.updateVariables()
		})

		client.on('commandError', (name, err) => {
			if (!this.isCurrentClient(client)) return
			// Queue governance (TTL expiry, poll eviction) is the design working
			// under load, not a device error: keep it out of last_error and
			// alarm-level logs so operator triggers cannot false-fire.
			if (isQueueRejection(err)) {
				if (SETTINGS.debugLevel === 'verbose') this.log('debug', `${name}: ${err.message}`)
				return
			}
			this.state.lastCommand = name
			this.state.lastError = err.message
			if (SETTINGS.debugLevel !== 'off') this.log('error', `${name}: ${err.message}`)
			this.updateVariables()
		})

		client.on('legacyResponse', (data) => {
			if (!this.isCurrentClient(client)) return
			this.handleLegacyResponse(data)
		})

		client.on('sprResponse', (response) => {
			if (!this.isCurrentClient(client)) return
			this.handleSPRResponse(response)
		})

		client.connect()
	}

	private handleLegacyResponse(data: Buffer): void {
		// The client emits every fixed-length legacy read here for diagnostics.
		// H2L (6 bytes), clock (19 bytes), identity and 0x2B replies are raw
		// payloads, not [0x33/0x66, 0x00] acknowledgements. Treat only a bare
		// documented ACK/ERR as a legacy status so valid polling never produces
		// a false "Newton ERR response" warning.
		if (!isLegacyAckResponse(data)) return
		// Past the guard the payload is exactly the 2-byte 3300/6600 status.
		const hex = data.toString('hex')
		const response = parseLegacyResponse(data)
		if (!response.success && SETTINGS.debugLevel !== 'off') {
			this.log('warn', `Newton ERR response: [${hex}]`)
		} else if (SETTINGS.debugLevel === 'verbose') {
			this.log('debug', `Newton OK response: [${hex}]`)
		}
	}

	private handleSPRResponse(response: SPRResponse): void {
		if (!response.success) {
			if (SETTINGS.debugLevel !== 'off') {
				this.log('warn', `SPR error for command 0x${response.command.toString(16).padStart(4, '0')}`)
			}
			return
		}
		if (SETTINGS.debugLevel === 'verbose') {
			this.log('debug', `SPR response for command 0x${response.command.toString(16).padStart(4, '0')}`)
		}
		this.updateSnapshotState(response)
	}

	private updateSnapshotState(response: SPRResponse): void {
		const command = Number(response.command)
		if (command === Number(SnapshotCmd.GetDatabase)) {
			const snapshots = parseSnapshotDatabase(response.payload)
			if (!snapshots) {
				this.markSnapshotDatabaseMalformed()
				return
			}
			this.state.lastSnapshotResponse = formatStructuredDiagnostic(response.payload)
			this.storeSnapshotList(snapshots)
			this.updateVariables()
			return
		}

		if (command === Number(SnapshotCmd.Apply)) {
			this.state.lastAppliedSnapshot = formatStructuredDiagnostic(response.payload)
			this.state.lastSnapshotResponse = 'Apply OK'
			this.updateVariables()
			return
		}

		if (
			command === Number(SnapshotCmd.Store) ||
			command === Number(SnapshotCmd.Delete) ||
			command === Number(SnapshotCmd.RecallSafeGet) ||
			command === Number(SnapshotCmd.RecallSafeSet)
		) {
			this.state.lastSnapshotResponse = formatStructuredDiagnostic(response.payload ?? { ok: true })
			this.updateVariables()
			// Store/Delete change the database: refresh the by-name dropdown.
			if (command === Number(SnapshotCmd.Store) || command === Number(SnapshotCmd.Delete)) {
				this.requestSnapshotDatabase()
			}
		}
	}

	// The payload has already been validated by parseSnapshotDatabase().
	// Re-register the action definitions when the list changed so the
	// snapshot-by-name dropdown reflects the device.
	private storeSnapshotList(list: SnapshotInfo[]): void {
		const wasLoaded = this.state.snapshotDatabaseLoaded
		this.state.snapshotCount = list.length
		this.state.snapshotDatabaseLoaded = true
		const key = JSON.stringify(list)
		if (wasLoaded && key === JSON.stringify(this.state.snapshotList)) return
		this.state.snapshotList = list
		this.setupDefinitions()
		// Re-evaluate existing label feedbacks immediately so a UUID deleted from
		// the device loses its action target instead of remaining applicable.
		this.checkFeedbacks('snapshot_apply_label')
	}

	private markSnapshotDatabaseMalformed(): void {
		this.state.snapshotDatabaseLoaded = false
		this.state.snapshotCount = 0
		this.state.lastSnapshotResponse = 'Invalid snapshot database response'
		this.state.lastError = 'Snapshot database response is malformed'
		if (SETTINGS.debugLevel !== 'off') this.log('warn', this.state.lastError)
		this.updateVariables()
		this.checkFeedbacks('snapshot_apply_label')
	}

	// Snapshots exist only from firmware 0.98: older firmware answers the SPC
	// database read with a legacy [0x66, 0x00]. Read the version first and skip
	// the read outright on old firmware; when the version is unknown, probe and
	// let the rejection mark the feature unsupported.
	private async initSnapshotSupport(): Promise<void> {
		const client = this.client
		if (!client?.isConnected) return
		const firmwareRead = await this.readFirmwareVersion(client)
		if (!this.isCurrentClient(client)) return
		// If the new connection did not yield a version yet, do not make a
		// support decision from a previous device at the same address. Probe the
		// database instead and let the device's response decide.
		const fw = firmwareRead ? this.state.firmwareVersion : ''
		const supported = fw ? isFirmwareAtLeast(fw, MIN_SNAPSHOT_FIRMWARE) : null
		if (supported === false) {
			this.markSnapshotsUnsupported(
				`Snapshots require firmware ${MIN_SNAPSHOT_FIRMWARE} or later (device reports ${fw}); snapshot actions are disabled`,
			)
			return
		}
		this.requestSnapshotDatabase(client)
	}

	// Read the firmware version (0x40). Called on every connect — the firmware
	// may have been updated between reconnects — and by the slow poll fallback.
	private async readFirmwareVersion(client: NewtonTcpClient | null = this.client): Promise<boolean> {
		if (!client?.isConnected) return false
		try {
			const r = await client.sendCommandExpect(buildImportFirmwareCommand(), {
				name: 'Read Firmware Version',
				timeoutMs: SETTINGS.commandTimeoutMs,
				expectedLength: 10,
				priority: 'poll',
			})
			if (!this.isCurrentClient(client) || !r.success) return false
			const fw = parseImportFirmwareResponse(r.rx)
			// Same policy as the other identity fields: empty is a valid read,
			// and a known version is never clobbered by a transient empty reply.
			if (fw === null) return false
			if (fw && fw !== this.state.firmwareVersion) {
				this.state.firmwareVersion = fw
				this.updateVariables()
			}
			this.identityRead.firmware = true
			return true
		} catch {
			// The version stays unknown; snapshot support falls back to probing.
			return false
		}
	}

	private markSnapshotsUnsupported(reason: string): void {
		if (this.state.snapshotsUnsupported) return
		this.state.snapshotsUnsupported = true
		this.state.lastError = reason
		this.log('warn', reason)
		// Re-register definitions so the snapshot dropdowns explain the
		// situation instead of showing an empty device list.
		this.setupDefinitions()
		this.checkFeedbacks('snapshot_apply_label')
	}

	// Fire-and-forget read of the snapshot database; the SPR handler above
	// stores the result whenever the reply arrives. A legacy [0x66, 0x00] in
	// place of an SPR frame is the old-firmware rejection: mark the feature
	// unsupported so actions fail fast instead of re-asking forever.
	private requestSnapshotDatabase(client: NewtonTcpClient | null = this.client): void {
		if (this.state.snapshotsUnsupported) return
		if (!client?.isConnected) return
		client
			.sendCommandExpect(buildSnapshotGetDatabase(), {
				name: 'Snapshot Get Database',
				timeoutMs: SETTINGS.commandTimeoutMs,
				// Must be able to outlive one full preset transfer holding the
				// queue at connect time instead of expiring after 3 s.
				queueTtlMs: SETTINGS.actionQueueTtlMs,
				priority: 'poll',
			})
			.then((r) => {
				if (!this.isCurrentClient(client)) return
				if (!r.success && isLegacyErrResponse(r.rx)) {
					this.markSnapshotsUnsupported(
						`Snapshots require firmware ${MIN_SNAPSHOT_FIRMWARE} or later (device rejected the snapshot database read); snapshot actions are disabled`,
					)
				}
			})
			.catch((err) => {
				if (!this.isCurrentClient(client)) return
				// A queue-expired read must not leave the dropdown empty for the
				// whole session: retry once the queue has had time to drain.
				// Transport errors are handled by the connection lifecycle instead.
				if (isQueueRejection(err)) this.scheduleSnapshotDatabaseRetry(client)
			})
	}

	private scheduleSnapshotDatabaseRetry(client: NewtonTcpClient | null): void {
		if (this.snapshotDbRetryTimer || this.state.snapshotDatabaseLoaded || this.state.snapshotsUnsupported) return
		this.snapshotDbRetryTimer = setTimeout(() => {
			this.snapshotDbRetryTimer = null
			if (!client || !this.isCurrentClient(client) || this.state.snapshotDatabaseLoaded) return
			this.requestSnapshotDatabase(client)
		}, SETTINGS.snapshotDbRetryMs)
	}

	private clearSnapshotDatabaseRetry(): void {
		if (!this.snapshotDbRetryTimer) return
		clearTimeout(this.snapshotDbRetryTimer)
		this.snapshotDbRetryTimer = null
	}

	// ===== Slow polling (device description / firmware / serial) =====

	private startPolling(): void {
		this.stopPolling()
		if (SETTINGS.pollInterval > 0) {
			this.pollTimer = setInterval(() => {
				void this.pollDeviceState()
			}, SETTINGS.pollInterval)
		}
	}

	private stopPolling(): void {
		if (this.pollTimer) {
			clearInterval(this.pollTimer)
			this.pollTimer = null
		}
		this.polling = false
	}

	private polling = false

	private async pollDeviceState(): Promise<void> {
		const client = this.client
		if (!client?.isConnected) return
		if (this.polling) return
		this.polling = true
		const refreshIdentity = this.identityRefreshPending
		let identityComplete = true

		try {
			// Gain/mute state is read from the complete 0x21 audio-preset payload
			// in pollPresetAudio().
			// Values are re-read once on every connection: the same address can now
			// host a replacement Newton. If one read fails, keep retrying on the
			// slow cadence instead of declaring the old identity authoritative.
			if (refreshIdentity || !this.identityRead.description) {
				const success = await this.readDeviceDescription(client)
				identityComplete = success && identityComplete
			}
			if (!this.isCurrentClient(client)) return
			if (refreshIdentity || !this.identityRead.firmware) {
				const success = await this.readFirmwareVersion(client)
				identityComplete = success && identityComplete
			}
			if (!this.isCurrentClient(client)) return
			if (refreshIdentity || !this.identityRead.serial) {
				const success = await this.readSerialNumber(client)
				identityComplete = success && identityComplete
			}
			if (this.isCurrentClient(client) && refreshIdentity && identityComplete) {
				this.identityRefreshPending = false
			}
		} finally {
			if (this.isCurrentClient(client)) this.polling = false
		}
	}

	private async readDeviceDescription(client: NewtonTcpClient): Promise<boolean> {
		try {
			const r = await client.sendCommandExpect(buildImportDescriptionCommand(), {
				name: 'Read Device Description',
				timeoutMs: SETTINGS.commandTimeoutMs,
				expectedLength: 18,
				priority: 'poll',
			})
			if (!this.isCurrentClient(client) || !r.success) return false
			const name = parseImportDescriptionResponse(r.rx)
			// An empty-but-valid field is a successful read (rendered "Unknown");
			// never overwrite a known value with a transient zero-filled reply.
			if (name === null) return false
			if (name && name !== this.state.deviceName) {
				this.state.deviceName = name
				this.updateVariables()
			}
			this.identityRead.description = true
			return true
		} catch {
			return false
		}
	}

	private async readSerialNumber(client: NewtonTcpClient): Promise<boolean> {
		try {
			const r = await client.sendCommandExpect(buildImportSerialCommand(), {
				name: 'Read Serial Number',
				timeoutMs: SETTINGS.commandTimeoutMs,
				expectedLength: 18,
				priority: 'poll',
			})
			if (!this.isCurrentClient(client) || !r.success) return false
			const serial = parseImportSerialResponse(r.rx)
			// Some Newton units return a correctly framed, zero-filled serial
			// field when no serial has been provisioned. An empty string is still
			// a successful identity response; variables render it as "Unknown".
			// A known serial is never clobbered by a transient empty reply.
			if (serial === null) return false
			if (serial && serial !== this.state.serialNumber) {
				this.state.serialNumber = serial
				this.updateVariables()
			}
			this.identityRead.serial = true
			return true
		} catch {
			return false
		}
	}

	// ===== Priority metadata polling =====
	// Active priority and selected clocks come from the UDP meter/status poll.
	// The low-frequency TCP work here is only the H2L/clock configuration lists.

	private startPriorityPolling(): void {
		this.stopPriorityPolling()
		this.priorityPollTimer = setInterval(() => {
			void this.pollPriorityMetadata()
		}, SETTINGS.priorityMetadataPollInterval)
	}

	private stopPriorityPolling(): void {
		if (this.priorityPollTimer) {
			clearInterval(this.priorityPollTimer)
			this.priorityPollTimer = null
		}
		this.priorityPolling = false
	}

	private priorityPolling = false

	private async pollPriorityMetadata(): Promise<void> {
		const client = this.client
		if (!client?.isConnected) return
		if (this.priorityPolling) return
		this.priorityPolling = true

		try {
			await this.pollNextPriorityList(client)
			if (this.isCurrentClient(client)) await this.pollNextClockList(client)
		} catch {
			// ignore – next tick will retry
		} finally {
			if (this.isCurrentClient(client)) this.priorityPolling = false
		}
	}

	// ===== Preset-audio polling (0x21, Gain/Mute refresh) =====
	// Newton firmware 0.98 rejects the otherwise documented Get Gain request.
	// The full preset-audio response is therefore the compatibility source for
	// channel gain/mute state. It is requested only while a level feedback is
	// subscribed, and its cadence follows the selected interactivity profile.
	private presetAudioPollTimer: ReturnType<typeof setInterval> | null = null
	private presetAudioPolling = false
	private presetAudioFailures = 0

	private startPresetAudioPolling(): void {
		this.stopPresetAudioPolling()
		this.presetAudioPollTimer = setInterval(() => {
			void this.pollPresetAudio()
		}, getInteractivityProfile(this.config.interactivity).presetAudioPollInterval)
	}

	private stopPresetAudioPolling(): void {
		if (this.presetAudioPollTimer) {
			clearInterval(this.presetAudioPollTimer)
			this.presetAudioPollTimer = null
		}
		this.presetAudioPolling = false
		this.presetAudioFailures = 0
	}

	private async pollPresetAudio(): Promise<void> {
		const client = this.client
		if (!client?.isConnected || this.presetAudioPolling || this.gainSubs.size === 0) return
		if (this.presetAudioFailures >= 2) return

		this.presetAudioPolling = true
		try {
			const r = await client.sendCommandExpect(buildImportAudioPresetCommand(), {
				...presetAudioReadOptions(),
				priority: 'poll',
			})
			if (!this.isCurrentClient(client)) return
			if (!r.success || !r.parsed) {
				this.registerPresetAudioFailure(r.error ?? 'invalid audio preset response')
				return
			}

			this.presetAudioFailures = 0
			let changed = false
			const apply = (channelType: number, entries: (GainReadState | null)[]): void => {
				entries.forEach((entry, channelIndex) => {
					if (!entry) return
					const key = gainKey(channelType, channelIndex)
					const previous = this.state.gainReads.get(key)
					if (!previous || previous.gainDb !== entry.gainDb || previous.muted !== entry.muted) {
						this.state.gainReads.set(key, entry)
						changed = true
					}
				})
			}
			apply(Number(ChannelType.InputDsp), r.parsed.inputDsp)
			apply(Number(ChannelType.OutputDsp), r.parsed.outputDsp)
			if (changed) this.checkFeedbacks('channel_gain', 'channel_mute')
		} catch (err) {
			// A poll evicted or expired behind other work is backpressure, not a
			// device failure: it must not count towards disabling the poll.
			if (this.isCurrentClient(client) && !isQueueRejection(err)) {
				this.registerPresetAudioFailure(err instanceof Error ? err.message : String(err))
			}
		} finally {
			if (this.isCurrentClient(client)) this.presetAudioPolling = false
		}
	}

	private registerPresetAudioFailure(reason: string): void {
		this.presetAudioFailures++
		if (this.presetAudioFailures === 2) {
			// A disabled poll must not leave stale values available to a later
			// read-modify-write action. Feedbacks become unknown until a reconnect
			// re-establishes a fresh 0x21 read.
			this.state.gainReads.clear()
			this.checkFeedbacks('channel_gain', 'channel_mute')
			this.log('warn', `Preset-audio polling disabled until reconnect: ${reason}`)
		}
	}

	// The active source (0x2B blob) changes fast and is polled every tick; the
	// channel lists (0x91) change rarely, so one channel is refreshed per tick
	// round-robin — a full sweep of the 16 inputs every ~16 seconds.
	private nextPriorityListChannel = 0

	private async pollNextPriorityList(client: NewtonTcpClient | null = this.client): Promise<void> {
		if (!client?.isConnected || this.state.priorityListsUnsupported) return

		const channelIndex = this.nextPriorityListChannel
		this.nextPriorityListChannel = (this.nextPriorityListChannel + 1) % SIGNALS_INPUT_DSP_PRIORITY_COUNT
		try {
			const r = await client.sendCommandExpect(buildReadPriorityListCommand(channelIndex), {
				name: 'Read Priority List',
				timeoutMs: SETTINGS.commandTimeoutMs,
				expectedLength: 6,
				isSuccess: (data) => data.length === 6,
				parser: parsePriorityListResponse,
				priority: 'poll',
			})
			if (!this.isCurrentClient(client)) return
			if (!r.success) {
				this.markPriorityListsUnsupported('Read Priority List unsupported or rejected by firmware')
				return
			}
			const parsed = r.parsed
			if (parsed) {
				const prev = this.state.priorityLists[channelIndex]
				this.state.priorityLists[channelIndex] = parsed
				const changed = !prev || prev.sources[0] !== parsed.sources[0] || prev.isForced !== parsed.isForced
				this.updateVariables()
				if (changed) {
					this.checkFeedbacks(...PRIORITY_FEEDBACK_IDS)
				}
			}
		} catch (err) {
			if (!this.isCurrentClient(client)) return
			// Queue backpressure (expired/evicted behind a long preset transfer)
			// is not a device rejection: leave polling armed and retry next tick.
			if (isQueueRejection(err)) return
			// Transport failures still stop optional polling until reconnect. A
			// normal legacy [0x66, 0x00] rejection resolves without a timeout.
			this.markPriorityListsUnsupported(err instanceof Error ? err.message : String(err))
		}
	}

	// Clock priority lists (0x81) change rarely: one clock type per tick
	// round-robin, full sweep of the 3 types every ~300 ms.
	private nextClockType = 0

	private async pollNextClockList(client: NewtonTcpClient | null = this.client): Promise<void> {
		if (!client?.isConnected || this.state.clockListsUnsupported) return

		const clockType = this.nextClockType
		this.nextClockType = (this.nextClockType + 1) % CLOCK_TYPE_COUNT
		try {
			const r = await client.sendCommandExpect(buildGetClockCommand(clockType), {
				name: 'Get Processing Clock',
				timeoutMs: SETTINGS.commandTimeoutMs,
				expectedLength: 19,
				isSuccess: (data) => data.length === 19,
				parser: parseClockStateResponse,
				priority: 'poll',
			})
			if (!this.isCurrentClient(client)) return
			if (!r.success) {
				this.markClockListsUnsupported('Get Processing Clock unsupported or rejected by firmware')
				return
			}
			const parsed = r.parsed
			if (parsed) {
				const prev = this.state.clockLists[clockType]
				this.state.clockLists[clockType] = parsed
				if (!prev || prev.list[0] !== parsed.list[0] || prev.isForced !== parsed.isForced) {
					this.checkFeedbacks(...CLOCK_FEEDBACK_IDS)
				}
			}
		} catch (err) {
			if (!this.isCurrentClient(client)) return
			// See 0x91 above: queue backpressure is transient, not "unsupported".
			if (isQueueRejection(err)) return
			this.markClockListsUnsupported(err instanceof Error ? err.message : String(err))
		}
	}

	private markClockListsUnsupported(reason: string): void {
		this.state.clockListsUnsupported = true
		this.state.clockLists = new Array(CLOCK_TYPE_COUNT).fill(null)
		this.state.lastError = reason
		this.updateVariables()
		this.checkFeedbacks(...CLOCK_FEEDBACK_IDS)
	}

	private markPriorityListsUnsupported(reason: string): void {
		this.state.priorityListsUnsupported = true
		this.state.priorityLists = new Array(SIGNALS_INPUT_DSP_PRIORITY_COUNT).fill(null)
		this.state.lastError = reason
		this.updateVariables()
		this.checkFeedbacks(...PRIORITY_FEEDBACK_IDS)
	}

	// ===== VU polling (UDP 0x2B status) =====

	// One warning per loss event: set when the UDP status stream dies, cleared
	// by the next packet.
	private udpStreamLost = false

	private startVuListener(): void {
		this.stopVuListener()
		if (this.destroyed || !this.config.host) return
		this.udpStreamLost = false
		const listener = new VuListener(
			this.config.host,
			SETTINGS.vuPort,
			getInteractivityProfile(this.config.interactivity).meterPollInterval,
		)
		this.vuListener = listener
		let loggedFirstPacket = false

		listener.on('vuLevels', (levels) => {
			if (this.destroyed || this.vuListener !== listener) return
			if (this.udpStreamLost) {
				this.udpStreamLost = false
				this.log('info', `UDP status stream from ${this.config.host}:${SETTINGS.vuPort} recovered`)
			}
			this.updatePriorityStateFromUdp(levels.raw)
			this.state.vuInputDsp = levels.inputDsp
			this.state.vuOutputDsp = levels.outputDsp
			this.state.vuInputDspRms = levels.inputDspRms
			this.state.vuOutputDspRms = levels.outputDspRms
			this.state.vu.format = levels.format
			this.state.vu.rawLength = levels.raw.length
			this.state.vu.rawFirstHex = levels.raw.subarray(0, 32).toString('hex')
			this.state.lastVuUpdate = new Date().toISOString()
			if (!loggedFirstPacket && SETTINGS.debugLevel === 'verbose') {
				loggedFirstPacket = true
				this.log('debug', `VU first status: ${levels.raw.length} bytes [${levels.raw.subarray(0, 32).toString('hex')}]`)
			}
			this.updateVuVariables()
		})

		listener.on('expired', () => {
			if (this.destroyed || this.vuListener !== listener) return
			this.handleVuStreamLoss('No VU packets')
		})
		listener.on('error', (err) => {
			if (this.destroyed || this.vuListener !== listener) return
			this.handleVuStreamLoss(`UDP error: ${err.message}`)
		})

		listener.start()
		this.log('info', `VU UDP polling started at ${this.config.host}:${SETTINGS.vuPort}`)
	}

	private updatePriorityStateFromUdp(data: Buffer): void {
		// The UDP stream deliberately survives a TCP loss so the meters stay
		// live, but priority/clock are control state: while the command channel
		// is down they stay cleared instead of looking alive on a dead device.
		if (!this.state.connected) return
		const clockSelected = parseClockSelected(data)
		if (clockSelected && !arraysEqual(clockSelected, this.state.clockSelected)) {
			this.state.clockSelected = clockSelected
			this.checkFeedbacks(...CLOCK_FEEDBACK_IDS)
		}

		const state: PriorityPatchState | null = parsePriorityPatchState(data)
		if (!state) return
		const changed =
			!arraysEqual(state.inputDsp, this.state.priorityInputDsp) ||
			!arraysEqual(state.auxMixer, this.state.priorityAuxMixer)

		this.state.priorityInputDsp = state.inputDsp
		this.state.priorityAuxMixer = state.auxMixer
		// Packets arrive at the meter cadence (up to ~12.5/s): republishing the
		// full variable set on every one would flood Companion's subscribers,
		// so publish only when a priority actually changed.
		if (changed) {
			this.state.lastPriorityUpdate = new Date().toISOString()
			this.updateVariables()
			this.checkFeedbacks(...PRIORITY_FEEDBACK_IDS)
		}
	}

	// The UDP stream is the only source of meters, active priority sources and
	// the selected clock. When it dies, unknown is safer than a frozen last
	// value — and say why once, loudly: on segmented show networks a blocked
	// UDP port is the usual culprit while TCP control keeps working.
	private handleVuStreamLoss(reason: string): void {
		if (this.udpStreamLost) return
		this.udpStreamLost = true
		this.clearVuState(reason)
		this.clearUdpPriorityState()
		this.log(
			'warn',
			`No UDP status from ${this.config.host}:${SETTINGS.vuPort} (${reason}). Meters and priority/clock monitors stay N/A until the stream returns; TCP control is unaffected. Queries go to Newton UDP port ${SETTINGS.vuPort}; replies return to the OS-assigned local UDP port. Check that both directions are allowed.`,
		)
	}

	// Reset only the UDP-derived state: the 0x91/0x81 lists arrive over TCP
	// and remain valid.
	private clearUdpPriorityState(): void {
		this.state.priorityInputDsp = new Array(SIGNALS_INPUT_DSP_PRIORITY_COUNT).fill(-1)
		this.state.priorityAuxMixer = new Array(SIGNALS_AUX_MIXER_PRIORITY_COUNT).fill(-1)
		this.state.clockSelected = new Array(CLOCK_TYPE_COUNT).fill(-1)
		this.updateVariables()
		this.checkFeedbacks(...PRIORITY_FEEDBACK_IDS, ...CLOCK_FEEDBACK_IDS)
	}

	private stopVuListener(): void {
		if (this.vuPublishTimer) {
			clearTimeout(this.vuPublishTimer)
			this.vuPublishTimer = null
		}
		if (this.vuListener) {
			this.vuListener.stop()
			this.vuListener = null
		}
		this.clearVuState('No VU packets')
	}

	private clearVuState(format: string): void {
		this.state.vuInputDsp = []
		this.state.vuOutputDsp = []
		this.state.vuInputDspRms = []
		this.state.vuOutputDspRms = []
		this.state.vu = {
			selected: 'N/A',
			selectedPeak: 'N/A',
			selectedClip: 'N/A',
			rawLength: 0,
			rawFirstHex: '',
			format,
		}
		this.state.lastVuUpdate = ''
		this.publishVuVariablesNow()
	}

	// ===== Variable updates =====

	private updateVariables(): void {
		const vars: Record<string, string | number | undefined> = {
			connection_state: this.state.connected ? 'Connected' : 'Disconnected',
			device_name: this.state.deviceName || 'Unknown',
			firmware_version: this.state.firmwareVersion || 'Unknown',
			serial_number: this.state.serialNumber || 'Unknown',
			last_error: this.state.lastError || '',
			last_command: this.state.lastCommand || '',
			last_response_hex: this.state.lastResponseHex || '',
			last_action_name: this.state.lastActionName || '',
			last_action_status: this.state.lastActionStatus,
			last_action_response_hex: this.state.lastActionResponseHex || '',
			last_priority_update: this.state.lastPriorityUpdate || 'Never',
			last_vu_update: this.state.lastVuUpdate || 'Never',
			snapshot_count: this.state.snapshotCount,
			last_snapshot_response: this.state.lastSnapshotResponse || '',
			last_applied_snapshot: this.state.lastAppliedSnapshot || '',
		}

		// The legacy 1-based IDs (as published by 1.0.0) and the preferred
		// *_input_N aliases carry the same values, so existing Companion
		// configurations keep their meaning.
		for (let i = 0; i < SIGNALS_INPUT_DSP_PRIORITY_COUNT; i++) {
			const v = this.state.priorityInputDsp[i]
			const value = v !== undefined && v >= 0 ? v : 'N/A'
			vars[`priority_in_${i + 1}`] = value
			vars[`priority_input_${i + 1}`] = value
		}
		for (let i = 0; i < SIGNALS_AUX_MIXER_PRIORITY_COUNT; i++) {
			const v = this.state.priorityAuxMixer[i]
			const value = v !== undefined && v >= 0 ? v : 'N/A'
			vars[`priority_aux_${i + 1}`] = value
			vars[`priority_aux_input_${i + 1}`] = value
		}

		const monitorIndex = SETTINGS.priorityMonitorChannelIndex
		const selectedPriority = this.state.priorityInputDsp[monitorIndex] ?? -1
		const selectedList = this.state.priorityLists[monitorIndex] ?? null
		const selectedHighest = selectedList?.sources[0]
		vars.priority_selected_active = selectedPriority >= 0 ? selectedPriority : 'N/A'
		// A fixed fallback would turn an unavailable 0x91 list into a seemingly
		// healthy "no" override. Only report a highest source when the device has
		// actually supplied one for this patch.
		vars.priority_selected_highest = selectedHighest ?? 'N/A'
		vars.priority_selected_forced = selectedList
			? selectedList.isForced
				? 'yes'
				: 'no'
			: this.state.priorityListsUnsupported
				? 'unsupported'
				: 'unknown'
		vars.priority_selected_forced_channel = selectedList?.forcedChannel ?? 'N/A'
		vars.priority_selected_overridden =
			selectedPriority < 0 || selectedHighest === undefined
				? 'unknown'
				: selectedPriority !== selectedHighest
					? 'yes'
					: 'no'
		vars.priority_read_list_status = this.state.priorityListsUnsupported
			? 'Unsupported by firmware'
			: selectedList
				? 'OK'
				: 'Unknown'
		vars.snapshot_support = this.state.snapshotsUnsupported
			? 'Unsupported by firmware'
			: this.state.snapshotDatabaseLoaded
				? 'OK'
				: 'Unknown'

		vars.vu_selected = this.state.vu.selected
		vars.vu_selected_peak = this.state.vu.selectedPeak
		vars.vu_selected_clip = this.state.vu.selectedClip
		vars.vu_raw_length = this.state.vu.rawLength
		vars.vu_raw_first_hex = this.state.vu.rawFirstHex
		vars.vu_format = this.state.vu.format

		this.setVariableValues(vars)
	}

	private buildVuVariables(): Record<string, string | number> {
		const vars: Record<string, string | number> = {}
		// Publish the legacy 1-based IDs (as in 1.0.0) and the preferred aliases.
		if (this.state.vuInputDsp.length === 0 && this.state.vuOutputDsp.length === 0) {
			// Unknown/undecoded packet format: publish N/A rather than leaving the
			// last-known per-channel values frozen on screen.
			for (let i = 0; i < VU_INPUT_CHANNEL_COUNT; i++) {
				vars[`vu_in_${i + 1}`] = 'N/A'
				vars[`vu_input_${i + 1}`] = 'N/A'
			}
			for (let i = 0; i < VU_OUTPUT_CHANNEL_COUNT; i++) {
				vars[`vu_out_${i + 1}`] = 'N/A'
				vars[`vu_output_${i + 1}`] = 'N/A'
			}
		} else {
			for (let i = 0; i < VU_INPUT_CHANNEL_COUNT; i++) {
				const value = this.state.vuInputDsp[i]?.toFixed(2) ?? 'N/A'
				vars[`vu_in_${i + 1}`] = value
				vars[`vu_input_${i + 1}`] = value
			}
			for (let i = 0; i < VU_OUTPUT_CHANNEL_COUNT; i++) {
				const value = this.state.vuOutputDsp[i]?.toFixed(2) ?? 'N/A'
				vars[`vu_out_${i + 1}`] = value
				vars[`vu_output_${i + 1}`] = value
			}
		}
		this.updateSelectedVuState()
		vars.vu_selected = this.state.vu.selected
		vars.vu_selected_peak = this.state.vu.selectedPeak
		vars.vu_selected_clip = this.state.vu.selectedClip
		vars.vu_raw_length = this.state.vu.rawLength
		vars.vu_raw_first_hex = this.state.vu.rawFirstHex
		vars.vu_format = this.state.vu.format
		vars.last_vu_update = this.state.lastVuUpdate || 'Never'
		return vars
	}

	// VU data can arrive at 20-50 Hz; publish immediately if we haven't
	// published recently, otherwise coalesce into a single trailing publish at
	// the cadence of the selected interactivity profile.
	private updateVuVariables(): void {
		if (this.destroyed) return
		const interval = getInteractivityProfile(this.config.interactivity).meterPollInterval
		const now = Date.now()
		const elapsed = now - this.lastVuPublish
		if (elapsed >= interval) {
			this.lastVuPublish = now
			this.setVariableValues(this.buildVuVariables())
			this.checkFeedbacks('meter')
			return
		}
		if (this.vuPublishTimer) return
		this.vuPublishTimer = setTimeout(() => {
			this.vuPublishTimer = null
			if (this.destroyed) return
			this.lastVuPublish = Date.now()
			this.setVariableValues(this.buildVuVariables())
			this.checkFeedbacks('meter')
		}, interval - elapsed)
	}

	private publishVuVariablesNow(): void {
		if (this.destroyed) return
		if (this.vuPublishTimer) {
			clearTimeout(this.vuPublishTimer)
			this.vuPublishTimer = null
		}
		this.lastVuPublish = Date.now()
		this.setVariableValues(this.buildVuVariables())
		this.checkFeedbacks('meter')
	}

	private updateSelectedVuState(): void {
		const arr = SETTINGS.vuMonitorChannelType === ChannelType.OutputDsp ? this.state.vuOutputDsp : this.state.vuInputDsp
		const value = arr[SETTINGS.vuMonitorChannelIndex]
		if (value === undefined) {
			this.state.vu.selected = 'N/A'
			this.state.vu.selectedPeak = 'N/A'
			this.state.vu.selectedClip = 'N/A'
			return
		}
		this.state.vu.selected = value.toFixed(2)
		this.state.vu.selectedPeak = value.toFixed(2)
		// The documented 0x2B meter data has no clip flag. Do not invent one
		// from dB values: 0 dB is a valid peak, not a clipping indicator.
		this.state.vu.selectedClip = 'N/A'
	}
}

function arraysEqual(a: number[], b: number[]): boolean {
	if (a.length !== b.length) return false
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return false
	}
	return true
}

runEntrypoint(NewtonInstance, UpgradeScripts)
