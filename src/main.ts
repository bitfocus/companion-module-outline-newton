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
import { getFeedbackDefinitions, gainKey } from './feedbacks.js'
import { getVariableDefinitions } from './variables.js'
import { getPresetDefinitions } from './presets.js'
import { NewtonTcpClient } from './protocol/tcp-client.js'
import {
	PRESET_AUDIO_RESPONSE_LENGTH,
	parseClockSelected,
	parseClockStateResponse,
	parseImportDescriptionResponse,
	isFirmwareAtLeast,
	parseImportFirmwareResponse,
	parseImportSerialResponse,
	parseLegacyResponse,
	parsePresetAudioGains,
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
	REPLY_ERR,
	SIGNALS_AUX_MIXER_PRIORITY_COUNT,
	SIGNALS_INPUT_DSP_PRIORITY_COUNT,
	SnapshotCmd,
} from './protocol/constants.js'
import { VuListener } from './protocol/vu-listener.js'
import type { GainReadState, NewtonActionResult, NewtonState, SPRResponse } from './protocol/types.js'

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
	private vuPublishTimer: ReturnType<typeof setTimeout> | null = null
	private lastVuPublish = 0
	private config: ModuleConfig = { host: '', interactivity: 'medium' }

	// Single source of truth for variables and feedbacks. Protocol handlers
	// update this object first, then publish the small subset Companion needs.
	private state: NewtonState = createInitialNewtonState()

	// controlId -> input number, written by the rearm label feedback and read
	// by the 'rearm_this_input' action so one option drives the whole button.
	private rearmTargets = new Map<string, number>()

	// feedback-instance id -> channel shown on Levels & Mute buttons. The set
	// determines whether the full preset-audio refresh is needed at all.
	private gainSubs = new Map<string, { channelType: number; channelIndex: number }>()

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
		this.config = { host: config.host ?? '', interactivity: normalizeInteractivity(config.interactivity) }
		this.updateStatus(InstanceStatus.Disconnected)

		// Register actions/feedbacks/variables before connecting so Companion can
		// render the instance immediately, even while the socket is still offline.
		this.setupDefinitions()

		if (this.config.host) {
			this.connectToDevice()
		} else {
			this.updateStatus(InstanceStatus.BadConfig, 'No host configured')
		}

		if (this.config.host) this.startVuListener()
	}

	async destroy(): Promise<void> {
		this.stopPolling()
		this.stopPriorityPolling()
		this.stopPresetAudioPolling()
		this.stopVuListener()
		if (this.client) {
			this.client.destroy()
			this.client = null
		}
	}

	async configUpdated(config: ModuleConfig): Promise<void> {
		const nextHost = config.host ?? ''
		const nextInteractivity = normalizeInteractivity(config.interactivity)
		const targetChanged = this.config.host !== nextHost
		const interactivityChanged = this.config.interactivity !== nextInteractivity

		this.stopPolling()
		this.stopPriorityPolling()
		this.stopPresetAudioPolling()
		if (this.client) {
			this.client.destroy()
			this.client = null
		}
		// The UDP poll interval is fixed when VuListener is constructed. Rebuild
		// its socket whenever the profile changes so the new cadence takes effect.
		if (targetChanged || interactivityChanged) this.stopVuListener()

		this.config = { host: nextHost, interactivity: nextInteractivity }
		this.lastVuPublish = 0
		if (targetChanged) {
			this.resetDeviceState()
		}
		// Re-applying the configuration is an explicit operator retry for optional
		// H2L/clock support, even when the target did not change.
		this.state.priorityListsUnsupported = false
		this.state.clockListsUnsupported = false
		// destroy() emits no 'disconnected'; clear the flag ourselves so the
		// variables/feedbacks published below don't claim a stale connection
		// while the new client is still connecting.
		this.state.connected = false

		if (this.config.host) {
			this.connectToDevice()
		} else {
			this.updateStatus(InstanceStatus.BadConfig, 'No host configured')
		}

		if (this.config.host) {
			if (targetChanged || interactivityChanged || !this.vuListener) this.startVuListener()
		} else {
			this.stopVuListener()
		}
		this.updateVariables()
		this.checkFeedbacks(
			...PRIORITY_FEEDBACK_IDS,
			'connection_status',
			'connection_monitor',
			'last_action_success',
			'last_action_error',
		)
	}

	private resetDeviceState(): void {
		this.state = createInitialNewtonState()
		this.lastVuPublish = 0
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
		const clientProxy = this.getClientProxy()
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
				clientProxy,
				actionLogger,
				this.rearmTargets,
				this.clockRearmTargets,
				this.state.snapshotList,
				this.snapshotTargets,
				this.muteTargets,
				(channelType, channelIndex) => this.state.gainReads.get(gainKey(channelType, channelIndex)),
				() => this.state.snapshotsUnsupported,
				() => this.state.snapshotDatabaseLoaded,
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
		if (result.controlId) this.state.lastActionResults.set(result.controlId, result)
		if (!result.success) this.state.lastError = result.error ?? `${result.name} failed`
		this.updateVariables()
		this.checkFeedbacks('last_action_success', 'last_action_error')
	}

	private getClientProxy(): NewtonTcpClient {
		const getClient = () => this.client
		const getTimeout = () => SETTINGS.commandTimeoutMs
		// Actions are defined once, but the real client can be replaced after a
		// config update. This proxy resolves the current client at call time.
		return {
			get isConnected() {
				return getClient()?.isConnected ?? false
			},
			async sendCommand(cmd: Buffer) {
				const client = getClient()
				if (!client) return Promise.reject(new Error('Not connected'))
				return client.sendCommand(cmd)
			},
			async sendCommandExpect(cmd: Buffer, options: Parameters<NewtonTcpClient['sendCommandExpect']>[1]) {
				const client = getClient()
				if (!client) return Promise.reject(new Error('Not connected'))
				return client.sendCommandExpect(cmd, {
					timeoutMs: getTimeout(),
					...options,
				})
			},
			sendCommandNoWait(cmd: Buffer) {
				const client = getClient()
				if (!client) return
				client.sendCommandNoWait(cmd)
			},
		} as NewtonTcpClient
	}

	private connectToDevice(): void {
		this.updateStatus(InstanceStatus.Connecting)

		this.client = new NewtonTcpClient(this.config.host, SETTINGS.port)

		this.client.on('connected', () => {
			this.state.connected = true
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
			this.updateStatus(InstanceStatus.Ok)
			this.updateVariables()
			this.checkFeedbacks('connection_status', 'connection_monitor')
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

		this.client.on('disconnected', () => {
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
			// The meter/status stream has its own UDP socket. Keep listening when
			// the command channel reconnects so live meter feedback remains
			// independent of the TCP session.
			this.log('warn', 'Disconnected from Newton device')
		})

		this.client.on('error', (err) => {
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

		this.client.on('statusChange', (status, message) => {
			this.updateStatus(status, message ?? undefined)
		})

		this.client.on('rawData', (direction, data) => {
			if (SETTINGS.debugLevel === 'verbose') {
				this.log('debug', `${direction}: [${Buffer.from(data).toString('hex')}] (${data.length} bytes)`)
			}
		})

		this.client.on('commandResult', (result) => {
			this.state.lastCommand = result.name
			this.state.lastResponseHex = result.rx.toString('hex')
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

		this.client.on('commandError', (name, err) => {
			this.state.lastCommand = name
			this.state.lastError = err.message
			if (SETTINGS.debugLevel !== 'off') this.log('error', `${name}: ${err.message}`)
			this.updateVariables()
		})

		this.client.on('legacyResponse', (data) => {
			this.handleLegacyResponse(data)
		})

		this.client.on('sprResponse', (response) => {
			this.handleSPRResponse(response)
		})

		this.client.connect()
	}

	private handleLegacyResponse(data: Buffer): void {
		// 0x2B ImportSignals is a raw 1024-byte status blob, not a legacy
		// [0x33/0x66, 0x00] reply. Its first byte is arbitrary and must not be
		// interpreted as an error on every priority-poll interval.
		if (data.length === 1024) {
			if (SETTINGS.debugLevel === 'verbose') this.log('debug', 'Received raw 0x2B signals status (1024 bytes)')
			return
		}
		const hex = Buffer.from(data).toString('hex')
		const response = parseLegacyResponse(data)
		if (!response.success && SETTINGS.debugLevel !== 'off') {
			this.log(
				'warn',
				`Newton ERR response: [${hex.slice(0, 32)}${hex.length > 32 ? '...' : ''}] (${data.length} bytes)`,
			)
		} else if (SETTINGS.debugLevel === 'verbose') {
			this.log(
				'debug',
				`Newton OK response: [${hex.slice(0, 32)}${hex.length > 32 ? '...' : ''}] (${data.length} bytes)`,
			)
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
			const payload = response.payload
			// Firmware returns `snaplist`; accept the older observed aliases too.
			// Accept either shape so the operator-facing count remains useful.
			const snapshots = Array.isArray(payload?.snaplist)
				? payload.snaplist
				: Array.isArray(payload?.snapshots)
					? payload.snapshots
					: Array.isArray(payload?.database)
						? payload.database
						: Array.isArray(payload)
							? payload
							: []
			this.state.snapshotCount = snapshots.length
			this.state.lastSnapshotResponse = JSON.stringify(payload ?? {})
			this.storeSnapshotList(snapshots)
			this.updateVariables()
			return
		}

		if (command === Number(SnapshotCmd.Apply)) {
			this.state.lastAppliedSnapshot = JSON.stringify(response.payload ?? {})
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
			this.state.lastSnapshotResponse = JSON.stringify(response.payload ?? { ok: true })
			this.updateVariables()
			// Store/Delete change the database: refresh the by-name dropdown.
			if (command === Number(SnapshotCmd.Store) || command === Number(SnapshotCmd.Delete)) {
				this.requestSnapshotDatabase()
			}
		}
	}

	// Extract {uuid, name} entries and re-register the action definitions when
	// the list changed, so the snapshot-by-name dropdown reflects the device.
	private storeSnapshotList(snapshots: unknown[]): void {
		const list = snapshots.flatMap((entry) => {
			if (typeof entry !== 'object' || entry === null) return []
			const record = entry as Record<string, unknown>
			const uuid = typeof record.uuid === 'string' ? record.uuid.trim() : ''
			if (!uuid) return []
			const name =
				typeof record.name === 'string' && record.name.trim()
					? record.name.trim()
					: typeof record.description === 'string' && record.description.trim()
						? record.description.trim()
						: uuid.slice(0, 8)
			return [{ uuid, name }]
		})

		const wasLoaded = this.state.snapshotDatabaseLoaded
		this.state.snapshotDatabaseLoaded = true
		const key = JSON.stringify(list)
		if (wasLoaded && key === JSON.stringify(this.state.snapshotList)) return
		this.state.snapshotList = list
		this.setupDefinitions()
		// Re-evaluate existing label feedbacks immediately so a UUID deleted from
		// the device loses its action target instead of remaining applicable.
		this.checkFeedbacks('snapshot_apply_label')
	}

	// Snapshots exist only from firmware 0.98: older firmware answers the SPC
	// database read with a legacy [0x66, 0x00]. Read the version first and skip
	// the read outright on old firmware; when the version is unknown, probe and
	// let the rejection mark the feature unsupported.
	private async initSnapshotSupport(): Promise<void> {
		await this.readFirmwareVersion()
		const fw = this.state.firmwareVersion
		const supported = fw ? isFirmwareAtLeast(fw, MIN_SNAPSHOT_FIRMWARE) : null
		if (supported === false) {
			this.markSnapshotsUnsupported(
				`Snapshots require firmware ${MIN_SNAPSHOT_FIRMWARE} or later (device reports ${fw}); snapshot actions are disabled`,
			)
			return
		}
		this.requestSnapshotDatabase()
	}

	// Read the firmware version (0x40). Called on every connect — the firmware
	// may have been updated between reconnects — and by the slow poll fallback.
	private async readFirmwareVersion(): Promise<void> {
		if (!this.client?.isConnected) return
		try {
			const r = await this.client.sendCommandExpect(buildImportFirmwareCommand(), {
				name: 'Read Firmware Version',
				timeoutMs: SETTINGS.commandTimeoutMs,
				expectedLength: 10,
			})
			if (r.success) {
				const fw = parseImportFirmwareResponse(r.rx)
				if (fw && fw !== this.state.firmwareVersion) {
					this.state.firmwareVersion = fw
					this.updateVariables()
				}
			}
		} catch {
			// The version stays unknown; snapshot support falls back to probing.
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
	private requestSnapshotDatabase(): void {
		if (this.state.snapshotsUnsupported) return
		const client = this.client
		if (!client?.isConnected) return
		client
			.sendCommandExpect(buildSnapshotGetDatabase(), {
				name: 'Snapshot Get Database',
				timeoutMs: SETTINGS.commandTimeoutMs,
			})
			.then((r) => {
				if (!r.success && r.rx.length === 2 && r.rx[0] === REPLY_ERR) {
					this.markSnapshotsUnsupported(
						`Snapshots require firmware ${MIN_SNAPSHOT_FIRMWARE} or later (device rejected the snapshot database read); snapshot actions are disabled`,
					)
				}
			})
			.catch(() => {
				// Transport errors are handled by the connection lifecycle; the
				// dropdown simply stays empty until the next successful read.
			})
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
	}

	private polling = false

	private async pollDeviceState(): Promise<void> {
		if (!this.client?.isConnected) return
		if (this.polling) return
		this.polling = true

		try {
			// Gain/mute state is read from the complete 0x21 audio-preset payload
			// in pollPresetAudio().
			// Static identity fields are read until they are populated, then left
			// alone to avoid unnecessary protocol traffic on busy show networks.
			if (!this.state.deviceName) {
				try {
					const r = await this.client.sendCommandExpect(buildImportDescriptionCommand(), {
						name: 'Read Device Description',
						timeoutMs: SETTINGS.commandTimeoutMs,
						expectedLength: 18,
					})
					// A failed read only skips this block; firmware/serial are read independently below.
					if (r.success) {
						const name = parseImportDescriptionResponse(r.rx)
						if (name) {
							this.state.deviceName = name
							this.updateVariables()
						}
					}
				} catch {
					// ignore
				}
			}

			if (!this.state.firmwareVersion && this.client.isConnected) {
				// A failed read only skips this block; serial is still read below.
				await this.readFirmwareVersion()
			}

			if (!this.state.serialNumber && this.client.isConnected) {
				try {
					const r = await this.client.sendCommandExpect(buildImportSerialCommand(), {
						name: 'Read Serial Number',
						timeoutMs: SETTINGS.commandTimeoutMs,
						expectedLength: 18,
					})
					if (r.success) {
						const serial = parseImportSerialResponse(r.rx)
						if (serial) {
							this.state.serialNumber = serial
							this.updateVariables()
						}
					}
				} catch {
					// ignore
				}
			}
		} finally {
			this.polling = false
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
	}

	private priorityPolling = false

	private async pollPriorityMetadata(): Promise<void> {
		if (!this.client?.isConnected) return
		if (this.priorityPolling) return
		this.priorityPolling = true

		try {
			await this.pollNextPriorityList()
			await this.pollNextClockList()
		} catch {
			// ignore – next tick will retry
		} finally {
			this.priorityPolling = false
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
		if (!this.client?.isConnected || this.presetAudioPolling || this.gainSubs.size === 0) return
		if (this.presetAudioFailures >= 2) return

		this.presetAudioPolling = true
		try {
			const r = await this.client.sendCommandExpect(buildImportAudioPresetCommand(), {
				name: 'Import Audio Preset',
				timeoutMs: SETTINGS.commandTimeoutMs,
				expectedLength: PRESET_AUDIO_RESPONSE_LENGTH,
				isSuccess: (data) => data.length === PRESET_AUDIO_RESPONSE_LENGTH && data[0] === 0x33,
				parser: parsePresetAudioGains,
			})
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
			this.registerPresetAudioFailure(err instanceof Error ? err.message : String(err))
		} finally {
			this.presetAudioPolling = false
		}
	}

	private registerPresetAudioFailure(reason: string): void {
		this.presetAudioFailures++
		if (this.presetAudioFailures === 2) {
			this.log('warn', `Preset-audio polling disabled until reconnect: ${reason}`)
		}
	}

	// The active source (0x2B blob) changes fast and is polled every tick; the
	// channel lists (0x91) change rarely, so one channel is refreshed per tick
	// round-robin — a full sweep of the 16 inputs every ~1.6 s.
	private nextPriorityListChannel = 0

	private async pollNextPriorityList(): Promise<void> {
		if (!this.client?.isConnected || this.state.priorityListsUnsupported) return

		const channelIndex = this.nextPriorityListChannel
		this.nextPriorityListChannel = (this.nextPriorityListChannel + 1) % SIGNALS_INPUT_DSP_PRIORITY_COUNT
		try {
			const r = await this.client.sendCommandExpect(buildReadPriorityListCommand(channelIndex), {
				name: 'Read Priority List',
				timeoutMs: SETTINGS.commandTimeoutMs,
				expectedLength: 6,
				isSuccess: (data) => data.length === 6,
				parser: parsePriorityListResponse,
			})
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
			// Transport failures still stop optional polling until reconnect. A
			// normal legacy [0x66, 0x00] rejection resolves without a timeout.
			this.markPriorityListsUnsupported(err instanceof Error ? err.message : String(err))
		}
	}

	// Clock priority lists (0x81) change rarely: one clock type per tick
	// round-robin, full sweep of the 3 types every ~300 ms.
	private nextClockType = 0

	private async pollNextClockList(): Promise<void> {
		if (!this.client?.isConnected || this.state.clockListsUnsupported) return

		const clockType = this.nextClockType
		this.nextClockType = (this.nextClockType + 1) % CLOCK_TYPE_COUNT
		try {
			const r = await this.client.sendCommandExpect(buildGetClockCommand(clockType), {
				name: 'Get Processing Clock',
				timeoutMs: SETTINGS.commandTimeoutMs,
				expectedLength: 19,
				isSuccess: (data) => data.length === 19,
				parser: parseClockStateResponse,
			})
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
			// See 0x91 above: only transport failures reach this catch path.
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
		if (!this.config.host) return
		this.vuListener = new VuListener(
			this.config.host,
			SETTINGS.vuPort,
			getInteractivityProfile(this.config.interactivity).meterPollInterval,
		)
		let loggedFirstPacket = false

		this.vuListener.on('vuLevels', (levels) => {
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

		this.vuListener.on('expired', () => this.handleVuStreamLoss('No VU packets'))
		this.vuListener.on('error', (err) => {
			this.log('warn', `VU listener error: ${err.message}`)
			this.handleVuStreamLoss(`UDP error: ${err.message}`)
		})

		this.vuListener.start()
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
		this.clearVuState(reason)
		this.clearUdpPriorityState()
		if (!this.udpStreamLost) {
			this.udpStreamLost = true
			this.log(
				'warn',
				`No UDP status from ${this.config.host}:${SETTINGS.vuPort} (${reason}). Meters and priority/clock monitors stay N/A until the stream returns; TCP control is unaffected. Check that UDP port ${SETTINGS.vuPort} from the Newton to Companion is allowed.`,
			)
		}
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
		this.updateVuVariables()
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
		vars.priority_selected_active = selectedPriority >= 0 ? selectedPriority : 'N/A'
		// If 0x91 is unavailable, fall back to the fixed expected source so the
		// overridden variable can still be somewhat useful.
		vars.priority_selected_highest = selectedList?.sources[0] ?? SETTINGS.priorityMonitorHighestSource
		vars.priority_selected_forced = selectedList
			? selectedList.isForced
				? 'yes'
				: 'no'
			: this.state.priorityListsUnsupported
				? 'unsupported'
				: 'unknown'
		vars.priority_selected_forced_channel = selectedList?.forcedChannel ?? 'N/A'
		vars.priority_selected_overridden =
			selectedPriority >= 0 && selectedPriority !== Number(vars.priority_selected_highest) ? 'yes' : 'no'
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
			this.lastVuPublish = Date.now()
			this.setVariableValues(this.buildVuVariables())
			this.checkFeedbacks('meter')
		}, interval - elapsed)
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
