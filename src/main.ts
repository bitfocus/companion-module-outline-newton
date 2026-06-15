import { InstanceBase, InstanceStatus, runEntrypoint } from '@companion-module/base'
import { DEFAULT_CONFIG, getConfigFields, type ModuleConfig } from './config.js'
import { UpgradeScripts } from './upgrades.js'
import { getActionDefinitions } from './actions.js'
import { getFeedbackDefinitions } from './feedbacks.js'
import { getVariableDefinitions } from './variables.js'
import { getPresetDefinitions } from './presets.js'
import { NewtonTcpClient } from './protocol/tcp-client.js'
import {
	parseImportDescriptionResponse,
	parseImportFirmwareResponse,
	parseImportSerialResponse,
	parseLegacyResponse,
	parsePriorityListResponse,
	parsePriorityPatchState,
	parseReadPresetResponse,
	type PriorityPatchState,
} from './protocol/command-parser.js'
import {
	buildImportDescriptionCommand,
	buildImportFirmwareCommand,
	buildImportSerialCommand,
	buildImportSignalsCommand,
	buildReadPresetCommand,
	buildReadPriorityListCommand,
} from './protocol/command-builder.js'
import {
	ChannelType,
	SIGNALS_AUX_MIXER_PRIORITY_COUNT,
	SIGNALS_INPUT_DSP_PRIORITY_COUNT,
	SnapshotCmd,
} from './protocol/constants.js'
import { VuListener } from './protocol/vu-listener.js'
import type { NewtonState, SPRResponse } from './protocol/types.js'

class NewtonInstance extends InstanceBase<ModuleConfig> {
	private client: NewtonTcpClient | null = null
	private vuListener: VuListener | null = null
	private pollTimer: ReturnType<typeof setInterval> | null = null
	private priorityPollTimer: ReturnType<typeof setInterval> | null = null
	private config: ModuleConfig = { ...DEFAULT_CONFIG }

	// Single source of truth for variables and feedbacks. Protocol handlers
	// update this object first, then publish the small subset Companion needs.
	private state: NewtonState = {
		connected: false,
		currentPreset: -1,
		muteActive: false,
		deviceName: '',
		firmwareVersion: '',
		serialNumber: '',
		lastError: '',
		lastCommand: '',
		lastResponseHex: '',
		lastPriorityUpdate: '',
		lastVuUpdate: '',
		snapshotCount: 0,
		lastSnapshotResponse: '',
		lastAppliedSnapshot: '',
		priorityInputDsp: new Array(SIGNALS_INPUT_DSP_PRIORITY_COUNT).fill(-1),
		priorityAuxMixer: new Array(SIGNALS_AUX_MIXER_PRIORITY_COUNT).fill(-1),
		prioritySelectedActive: -1,
		prioritySelectedList: null,
		prioritySelectedUnsupported: false,
		vuInputDsp: [],
		vuOutputDsp: [],
		vu: {
			selected: 'No VU packets',
			selectedPeak: 'No VU packets',
			selectedClip: 'No VU packets',
			rawLength: 0,
			rawFirstHex: '',
			format: 'No VU packets',
		},
	}

	async init(config: ModuleConfig): Promise<void> {
		this.config = { ...DEFAULT_CONFIG, ...config }
		this.updateStatus(InstanceStatus.Disconnected)

		// Register actions/feedbacks/variables before connecting so Companion can
		// render the instance immediately, even while the socket is still offline.
		this.setupDefinitions()

		if (this.config.host) {
			this.connectToDevice()
		} else {
			this.updateStatus(InstanceStatus.BadConfig, 'No host configured')
		}

		if (this.config.enableVu) {
			this.startVuListener()
		}
	}

	async destroy(): Promise<void> {
		this.stopPolling()
		this.stopPriorityPolling()
		this.stopVuListener()
		if (this.client) {
			this.client.destroy()
			this.client = null
		}
	}

	async configUpdated(config: ModuleConfig): Promise<void> {
		const prevVu = this.config.enableVu
		const prevVuPort = this.config.vuPort
		const prevPriorityType = this.config.priorityMonitorChannelType
		const prevPriorityIndex = this.config.priorityMonitorChannelIndex
		this.config = { ...DEFAULT_CONFIG, ...config }
		if (
			prevPriorityType !== this.config.priorityMonitorChannelType ||
			prevPriorityIndex !== this.config.priorityMonitorChannelIndex
		) {
			this.state.prioritySelectedList = null
			this.state.prioritySelectedUnsupported = false
			this.state.prioritySelectedActive = -1
		}
		this.stopPolling()
		this.stopPriorityPolling()

		// Recreate the TCP client on every config update. The Companion TCPHelper
		// owns reconnect timers internally, so a fresh instance avoids stale
		// sockets when host, port, or timing changes.
		if (this.client) {
			this.client.destroy()
			this.client = null
		}

		if (this.config.host) {
			this.connectToDevice()
		} else {
			this.updateStatus(InstanceStatus.BadConfig, 'No host configured')
		}

		if (this.config.enableVu && (!prevVu || prevVuPort !== this.config.vuPort)) {
			this.startVuListener()
		} else if (!this.config.enableVu && prevVu) {
			this.stopVuListener()
		}
		this.updateVariables()
	}

	getConfigFields() {
		return getConfigFields()
	}

	private setupDefinitions(): void {
		const clientProxy = this.getClientProxy()

		this.setActionDefinitions(getActionDefinitions(clientProxy, this))
		this.setFeedbackDefinitions(getFeedbackDefinitions(() => this.state))
		this.setVariableDefinitions(getVariableDefinitions())
		this.setPresetDefinitions(getPresetDefinitions())

		this.updateVariables()
	}

	private getClientProxy(): NewtonTcpClient {
		const getClient = () => this.client
		const getTimeout = () => this.config.commandTimeoutMs
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

		this.client = new NewtonTcpClient(this.config.host, this.config.port)

		this.client.on('connected', () => {
			this.state.connected = true
			this.updateStatus(InstanceStatus.Ok)
			this.updateVariables()
			this.checkFeedbacks('connection_status', 'mute_active', 'preset_active')
			this.log('info', `Connected to Newton at ${this.config.host}:${this.config.port}`)

			void this.pollDeviceState()
			this.startPolling()

			if (this.config.enablePriorityPolling) {
				void this.pollPriorityState()
				this.startPriorityPolling()
			}
		})

		this.client.on('disconnected', () => {
			this.state.connected = false
			this.updateStatus(InstanceStatus.Disconnected)
			this.updateVariables()
			this.checkFeedbacks('connection_status')
			this.stopPolling()
			this.stopPriorityPolling()
			this.log('warn', 'Disconnected from Newton device')
		})

		this.client.on('error', (err) => {
			this.log('error', `Connection error: ${err.message}`)
			this.state.connected = false
			this.updateStatus(InstanceStatus.ConnectionFailure, err.message)
			this.updateVariables()
			this.checkFeedbacks('connection_status')
		})

		this.client.on('statusChange', (status, message) => {
			this.updateStatus(status, message ?? undefined)
		})

		this.client.on('rawData', (direction, data) => {
			if (this.config.debugLevel === 'verbose') {
				this.log('debug', `${direction}: [${Buffer.from(data).toString('hex')}] (${data.length} bytes)`)
			}
		})

		this.client.on('commandResult', (result) => {
			this.state.lastCommand = result.name
			this.state.lastResponseHex = result.rx.toString('hex')
			this.state.lastError = result.success ? '' : (result.error ?? 'Unknown command error')
			if (!result.success && this.config.debugLevel !== 'off') {
				this.log('warn', `${result.name}: ${this.state.lastError} RX [${this.state.lastResponseHex}]`)
			}
			this.updateVariables()
		})

		this.client.on('commandError', (name, err) => {
			this.state.lastCommand = name
			this.state.lastError = err.message
			if (this.config.debugLevel !== 'off') this.log('error', `${name}: ${err.message}`)
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
		const hex = Buffer.from(data).toString('hex')
		const response = parseLegacyResponse(data)
		if (!response.success && this.config.debugLevel !== 'off') {
			this.log(
				'warn',
				`Newton ERR response: [${hex.slice(0, 32)}${hex.length > 32 ? '...' : ''}] (${data.length} bytes)`,
			)
		} else if (this.config.debugLevel === 'verbose') {
			this.log(
				'debug',
				`Newton OK response: [${hex.slice(0, 32)}${hex.length > 32 ? '...' : ''}] (${data.length} bytes)`,
			)
		}
	}

	private handleSPRResponse(response: SPRResponse): void {
		if (!response.success && this.config.debugLevel !== 'off') {
			this.log('warn', `SPR error for command 0x${response.command.toString(16).padStart(4, '0')}`)
			return
		}
		if (this.config.debugLevel === 'verbose') {
			this.log('debug', `SPR response for command 0x${response.command.toString(16).padStart(4, '0')}`)
		}
		this.updateSnapshotState(response)
	}

	private updateSnapshotState(response: SPRResponse): void {
		const command = Number(response.command)
		if (command === Number(SnapshotCmd.GetDatabase)) {
			const payload = response.payload
			// Firmware builds have returned both `snapshots` and `database` arrays.
			// Accept either shape so the operator-facing count remains useful.
			const snapshots = Array.isArray(payload?.snapshots)
				? payload.snapshots
				: Array.isArray(payload?.database)
					? payload.database
					: Array.isArray(payload)
						? payload
						: []
			this.state.snapshotCount = snapshots.length
			this.state.lastSnapshotResponse = JSON.stringify(payload ?? {})
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
		}
	}

	// ===== Slow polling (preset / description / firmware / serial) =====

	private startPolling(): void {
		this.stopPolling()
		if (this.config.pollInterval > 0) {
			this.pollTimer = setInterval(() => {
				void this.pollDeviceState()
			}, this.config.pollInterval)
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
			try {
				const r = await this.client.sendCommandExpect(buildReadPresetCommand(), {
					name: 'Read Current Preset',
					timeoutMs: this.config.commandTimeoutMs,
				})
				const preset = r.success ? parseReadPresetResponse(r.rx) : null
				if (preset !== null && preset !== this.state.currentPreset) {
					this.state.currentPreset = preset
					this.updateVariables()
					this.checkFeedbacks('preset_active')
				}
			} catch {
				// Keep polling metadata even if this firmware does not expose preset state.
			}

			// Static identity fields are read until they are populated, then left
			// alone to avoid unnecessary protocol traffic on busy show networks.
			if (!this.state.deviceName) {
				try {
					const r = await this.client.sendCommandExpect(buildImportDescriptionCommand(), {
						name: 'Read Device Description',
						timeoutMs: this.config.commandTimeoutMs,
					})
					if (!r.success) return
					const name = parseImportDescriptionResponse(r.rx)
					if (name) {
						this.state.deviceName = name
						this.updateVariables()
					}
				} catch {
					// ignore
				}
			}

			if (!this.state.firmwareVersion && this.client.isConnected) {
				try {
					const r = await this.client.sendCommandExpect(buildImportFirmwareCommand(), {
						name: 'Read Firmware Version',
						timeoutMs: this.config.commandTimeoutMs,
					})
					if (!r.success) return
					const fw = parseImportFirmwareResponse(r.rx)
					if (fw) {
						this.state.firmwareVersion = fw
						this.updateVariables()
					}
				} catch {
					// ignore
				}
			}

			if (!this.state.serialNumber && this.client.isConnected) {
				try {
					const r = await this.client.sendCommandExpect(buildImportSerialCommand(), {
						name: 'Read Serial Number',
						timeoutMs: this.config.commandTimeoutMs,
					})
					if (!r.success) return
					const serial = parseImportSerialResponse(r.rx)
					if (serial) {
						this.state.serialNumber = serial
						this.updateVariables()
					}
				} catch {
					// ignore
				}
			}
		} finally {
			this.polling = false
		}
	}

	// ===== Fast polling (priority patch state via 0x2B offset 666) =====

	private startPriorityPolling(): void {
		this.stopPriorityPolling()
		const interval = Math.max(200, this.config.priorityPollInterval)
		this.priorityPollTimer = setInterval(() => {
			void this.pollPriorityState()
		}, interval)
	}

	private stopPriorityPolling(): void {
		if (this.priorityPollTimer) {
			clearInterval(this.priorityPollTimer)
			this.priorityPollTimer = null
		}
	}

	private priorityPolling = false

	private async pollPriorityState(): Promise<void> {
		if (!this.client?.isConnected) return
		if (this.priorityPolling) return
		this.priorityPolling = true

		try {
			const r = await this.client.sendCommandExpect(buildImportSignalsCommand(), {
				name: 'Read Priority Patch State',
				timeoutMs: this.config.commandTimeoutMs,
				expectedLength: 1024,
				// This command returns a raw signals blob on known Newton firmware,
				// not the standard legacy OK header, so byte length + parser decide.
				isSuccess: () => true,
				parser: parsePriorityPatchState,
			})
			const state: PriorityPatchState | null = r.success ? r.parsed : null
			if (state) {
				this.state.lastPriorityUpdate = new Date().toISOString()
				const changed =
					!arraysEqual(state.inputDsp, this.state.priorityInputDsp) ||
					!arraysEqual(state.auxMixer, this.state.priorityAuxMixer)

				this.state.priorityInputDsp = state.inputDsp
				this.state.priorityAuxMixer = state.auxMixer
				this.state.prioritySelectedActive = this.getSelectedPriorityActiveSource()

				this.updateVariables()
				if (changed) {
					this.checkFeedbacks('priority_active_source', 'priority_overridden')
				}
			}

			await this.pollSelectedPriorityList()
		} catch {
			// ignore – next tick will retry
		} finally {
			this.priorityPolling = false
		}
	}

	private async pollSelectedPriorityList(): Promise<void> {
		if (!this.client?.isConnected || this.state.prioritySelectedUnsupported) return

		const channelType = Number(this.config.priorityMonitorChannelType)
		const channelIndex = Number(this.config.priorityMonitorChannelIndex)
		try {
			const r = await this.client.sendCommandExpect(buildReadPriorityListCommand(channelType, channelIndex), {
				name: 'Read Selected Priority List',
				timeoutMs: this.config.commandTimeoutMs,
				parser: parsePriorityListResponse,
			})
			if (!r.success) {
				// Some firmware rejects 0x91. Mark it unsupported until the monitored
				// patch changes so polling does not spam warnings every interval.
				this.state.prioritySelectedUnsupported = true
				this.state.prioritySelectedList = null
				this.state.lastError = 'Read Priority List unsupported or rejected by firmware'
				this.updateVariables()
				return
			}
			const parsed = r.parsed
			if (parsed) {
				this.state.prioritySelectedList = parsed
				this.state.prioritySelectedUnsupported = false
				this.updateVariables()
				this.checkFeedbacks('priority_manual_forced', 'priority_backup_active')
			}
		} catch (err) {
			this.state.lastError = err instanceof Error ? err.message : String(err)
			this.updateVariables()
		}
	}

	// ===== VU listener =====

	private startVuListener(): void {
		this.stopVuListener()
		this.vuListener = new VuListener(this.config.vuPort)
		let loggedFirstPacket = false

		this.vuListener.on('vuLevels', (levels) => {
			// The decoder is intentionally conservative: raw packet details stay
			// visible so new firmware formats can be identified from Companion.
			this.state.vuInputDsp = levels.inputDsp
			this.state.vuOutputDsp = levels.outputDsp
			this.state.vu.rawLength = levels.raw.length
			this.state.vu.rawFirstHex = levels.raw.subarray(0, 32).toString('hex')
			this.state.vu.format = levels.format === 'unknown' ? 'Unknown VU format' : levels.format
			this.state.lastVuUpdate = new Date().toISOString()
			if (!loggedFirstPacket && this.config.debugLevel === 'verbose') {
				loggedFirstPacket = true
				this.log('debug', `VU first packet: ${levels.raw.length} bytes [${levels.raw.toString('hex')}]`)
			}
			this.updateVuVariables()
		})

		this.vuListener.on('error', (err) => {
			this.log('warn', `VU listener error: ${err.message}`)
		})

		this.vuListener.start()
		this.log('info', `VU listener started on UDP ${this.config.vuPort}`)
	}

	private stopVuListener(): void {
		if (this.vuListener) {
			this.vuListener.stop()
			this.vuListener = null
		}
	}

	// ===== Variable updates =====

	private updateVariables(): void {
		const vars: Record<string, string | number | undefined> = {
			connection_state: this.state.connected ? 'Connected' : 'Disconnected',
			current_preset: this.state.currentPreset >= 0 ? String(this.state.currentPreset) : 'N/A',
			device_name: this.state.deviceName || 'Unknown',
			firmware_version: this.state.firmwareVersion || 'Unknown',
			serial_number: this.state.serialNumber || 'Unknown',
			mute_state: this.state.muteActive ? 'on' : 'off',
			last_error: this.state.lastError || '',
			last_command: this.state.lastCommand || '',
			last_response_hex: this.state.lastResponseHex || '',
			last_priority_update: this.state.lastPriorityUpdate || 'Never',
			last_vu_update: this.state.lastVuUpdate || 'Never',
			snapshot_count: this.state.snapshotCount,
			last_snapshot_response: this.state.lastSnapshotResponse || '',
			last_applied_snapshot: this.state.lastAppliedSnapshot || '',
		}

		for (let i = 0; i < SIGNALS_INPUT_DSP_PRIORITY_COUNT; i++) {
			const v = this.state.priorityInputDsp[i]
			vars[`priority_in_${i}`] = v !== undefined && v >= 0 ? v : 'N/A'
		}
		for (let i = 0; i < SIGNALS_AUX_MIXER_PRIORITY_COUNT; i++) {
			const v = this.state.priorityAuxMixer[i]
			vars[`priority_aux_${i}`] = v !== undefined && v >= 0 ? v : 'N/A'
		}

		const selectedPriority = this.state.prioritySelectedActive
		const selectedList = this.state.prioritySelectedList
		vars.priority_selected_active = selectedPriority >= 0 ? selectedPriority : 'N/A'
		// If 0x91 is unavailable, fall back to the operator-configured expected
		// source so the overridden feedback can still be useful.
		vars.priority_selected_highest = selectedList?.sources[0] ?? this.config.priorityMonitorHighestSource
		vars.priority_selected_forced = selectedList
			? selectedList.isForced
				? 'yes'
				: 'no'
			: this.state.prioritySelectedUnsupported
				? 'unsupported'
				: 'unknown'
		vars.priority_selected_forced_channel = selectedList?.forcedChannel ?? 'N/A'
		vars.priority_selected_overridden =
			selectedPriority >= 0 && selectedPriority !== Number(vars.priority_selected_highest) ? 'yes' : 'no'
		vars.priority_read_list_status = this.state.prioritySelectedUnsupported
			? 'Unsupported by firmware'
			: selectedList
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

	private updateVuVariables(): void {
		const vars: Record<string, string | number> = {}
		for (let i = 0; i < this.state.vuInputDsp.length; i++) {
			vars[`vu_in_${i}`] = this.state.vuInputDsp[i].toFixed(2)
		}
		for (let i = 0; i < this.state.vuOutputDsp.length; i++) {
			vars[`vu_out_${i}`] = this.state.vuOutputDsp[i].toFixed(2)
		}
		this.updateSelectedVuState()
		vars.vu_selected = this.state.vu.selected
		vars.vu_selected_peak = this.state.vu.selectedPeak
		vars.vu_selected_clip = this.state.vu.selectedClip
		vars.vu_raw_length = this.state.vu.rawLength
		vars.vu_raw_first_hex = this.state.vu.rawFirstHex
		vars.vu_format = this.state.vu.format
		vars.last_vu_update = this.state.lastVuUpdate || 'Never'
		this.setVariableValues(vars)
	}

	private getSelectedPriorityActiveSource(): number {
		const idx = this.config.priorityMonitorChannelIndex
		const arr =
			this.config.priorityMonitorChannelType === ChannelType.AuxMixer
				? this.state.priorityAuxMixer
				: this.state.priorityInputDsp
		const value = arr[idx]
		return value !== undefined ? value : -1
	}

	private updateSelectedVuState(): void {
		if (this.state.vu.format === 'Unknown VU format') {
			this.state.vu.selected = 'Unknown VU format'
			this.state.vu.selectedPeak = 'Unknown VU format'
			this.state.vu.selectedClip = 'Unknown VU format'
			return
		}
		const arr =
			this.config.vuMonitorChannelType === ChannelType.OutputDsp ? this.state.vuOutputDsp : this.state.vuInputDsp
		const value = arr[this.config.vuMonitorChannelIndex]
		if (value === undefined) {
			this.state.vu.selected = 'No VU packets'
			this.state.vu.selectedPeak = 'No VU packets'
			this.state.vu.selectedClip = 'No VU packets'
			return
		}
		this.state.vu.selected = value.toFixed(2)
		this.state.vu.selectedPeak = value.toFixed(2)
		// Until the firmware VU scale is confirmed, treat non-negative values as
		// a simple clip/status indicator rather than a calibrated dB threshold.
		this.state.vu.selectedClip = value >= 0 ? 'yes' : 'no'
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
