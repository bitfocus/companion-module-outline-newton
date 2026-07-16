import { Regex, type SomeCompanionConfigField } from '@companion-module/base'
import { ChannelType, PORT_METERS, PORT_TCP } from './protocol/constants.js'

export type Interactivity = 'low' | 'medium' | 'high'

export interface InteractivityProfile {
	meterPollInterval: number
	presetAudioPollInterval: number
}

/** Operator profiles affect UDP meters and the large TCP audio-preset refresh only. */
export const INTERACTIVITY_PROFILES: Readonly<Record<Interactivity, InteractivityProfile>> = {
	low: { meterPollInterval: 1000, presetAudioPollInterval: 5000 },
	medium: { meterPollInterval: 200, presetAudioPollInterval: 2000 },
	high: { meterPollInterval: 80, presetAudioPollInterval: 1000 },
}

export function normalizeInteractivity(value: unknown): Interactivity {
	return value === 'low' || value === 'high' || value === 'medium' ? value : 'medium'
}

export function getInteractivityProfile(value: unknown): InteractivityProfile {
	return INTERACTIVITY_PROFILES[normalizeInteractivity(value)]
}

/** Operator-editable connection and response profile settings. */
export interface ModuleConfig {
	host: string
	interactivity: Interactivity
}

/** Fixed runtime settings, formerly exposed as individual config fields. */
export interface ModuleSettings {
	port: number
	pollInterval: number
	priorityMetadataPollInterval: number
	commandTimeoutMs: number
	presetAudioTimeoutMs: number
	actionQueueTtlMs: number
	snapshotDbRetryMs: number
	debugLevel: 'off' | 'errors' | 'verbose'
	vuPort: number
	vuMonitorChannelType: ChannelType
	vuMonitorChannelIndex: number
	enablePriorityPolling: boolean
	priorityMonitorChannelType: ChannelType
	priorityMonitorChannelIndex: number
}

// Keep command failure visible promptly and release the serialized control
// queue; 3 seconds is the agreed response deadline for Newton control.
const COMMAND_TIMEOUT_MS = 3000
// The 0x21 full audio-preset response is roughly 384 KiB. It may need
// longer than an interactive command on a busy Newton, but stays bounded.
const PRESET_AUDIO_TIMEOUT_MS = 12000
// A button may queue behind one valid full-preset transfer plus its own wire
// turn. Derived, not free-standing: raising the transfer timeout can never
// silently starve queued operator actions.
const ACTION_QUEUE_TTL_MS = PRESET_AUDIO_TIMEOUT_MS + COMMAND_TIMEOUT_MS + 1000

export const SETTINGS: ModuleSettings = {
	port: PORT_TCP,
	pollInterval: 5000,
	priorityMetadataPollInterval: 1000,
	commandTimeoutMs: COMMAND_TIMEOUT_MS,
	presetAudioTimeoutMs: PRESET_AUDIO_TIMEOUT_MS,
	actionQueueTtlMs: ACTION_QUEUE_TTL_MS,
	// A connect-time snapshot database read that expired behind a long preset
	// transfer is retried on this cadence until it lands.
	snapshotDbRetryMs: 5000,
	debugLevel: 'errors',
	vuPort: PORT_METERS,
	vuMonitorChannelType: ChannelType.InputDsp,
	vuMonitorChannelIndex: 0,
	enablePriorityPolling: true,
	priorityMonitorChannelType: ChannelType.InputDsp,
	priorityMonitorChannelIndex: 0,
}

export function getConfigFields(): SomeCompanionConfigField[] {
	return [
		{
			type: 'textinput',
			id: 'host',
			label: 'Device IP Address',
			width: 12,
			regex: Regex.IP,
			required: true,
		},
		{
			type: 'dropdown',
			id: 'interactivity',
			label: 'Interactivity',
			width: 6,
			default: 'medium',
			choices: [
				{ id: 'low', label: 'Low' },
				{ id: 'medium', label: 'Default' },
				{ id: 'high', label: 'High' },
			],
		},
	]
}
