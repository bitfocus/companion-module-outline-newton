import type { ChannelType, SnapshotApplyMode } from './constants.js'

/** Result of parsing a legacy protocol response */
export interface LegacyResponse {
	success: boolean
	command: number
	payload: Buffer
}

/** Result of parsing an SPR (Special Protocol Reply) */
export interface SPRResponse {
	command: number
	success: boolean
	payload: Record<string, unknown> | null
	rawPayload: Buffer
}

export interface PriorityListState {
	sources: number[]
	isForced: boolean
	forcedChannel: number
}

export interface VuState {
	selected: string
	selectedPeak: string
	selectedClip: string
	rawLength: number
	rawFirstHex: string
	format: string
}

/** Gain command parameters */
export interface GainParams {
	channelType: ChannelType
	channelIndex: number
	gainDb: number
	mute: boolean
}

/** Delay command parameters */
export interface DelayParams {
	channelType: ChannelType
	channelIndex: number
	delayMs: number
}

/** Polarity command parameters */
export interface PolarityParams {
	channelType: ChannelType
	channelIndex: number
	inverted: boolean
}

/** Matrix assignment parameters */
export interface MatrixParams {
	outputChannel: number
	inputValue: number
}

/** Snapshot apply parameters */
export interface SnapshotApplyParams {
	uuid: string
	fadingTime?: number
	mode?: SnapshotApplyMode
	parts?: string[]
}

/** Snapshot store parameters */
export interface SnapshotStoreParams {
	author?: string
	description?: string
	place?: string
	recall?: string[]
	[key: string]: unknown
}

/** Snapshot metadata update parameters */
export interface SnapshotUpdateMetadataParams {
	uuid: string
	[key: string]: unknown
}

/** Device state tracked by the module */
export interface NewtonState {
	connected: boolean
	currentPreset: number
	muteActive: boolean
	deviceName: string
	firmwareVersion: string
	serialNumber: string
	lastError: string
	lastCommand: string
	lastResponseHex: string
	lastPriorityUpdate: string
	lastVuUpdate: string
	snapshotCount: number
	lastSnapshotResponse: string
	lastAppliedSnapshot: string
	/** Active source channel for InputDsp priority patches (0..15). -1 = unknown. */
	priorityInputDsp: number[]
	/** Active source channel for AuxMixer priority patches (0..7). -1 = unknown. */
	priorityAuxMixer: number[]
	prioritySelectedActive: number
	prioritySelectedList: PriorityListState | null
	prioritySelectedUnsupported: boolean
	/** Latest VU levels for InputDsp channels (per-channel float). */
	vuInputDsp: number[]
	/** Latest VU levels for OutputDsp channels (per-channel float). */
	vuOutputDsp: number[]
	vu: VuState
}

/** Fader description (multi-channel gain set) */
export interface FaderParams {
	channelType: ChannelType
	gains: number[] // array of float gain values in dB, one per channel
}
