import { SETTINGS } from './config.js'
import { PRESET_AUDIO_RESPONSE_LENGTH, parsePresetAudioGains } from './protocol/command-parser.js'

/**
 * The 0x21 full audio-preset read owns its framing and its long transfer
 * deadline (~384 KiB on the wire). Every caller must use these options: a
 * call that forgot the dedicated timeout would abort a valid slow transfer
 * at the 3 s command default and tear down the connection.
 */
export function presetAudioReadOptions(): {
	name: string
	timeoutMs: number
	expectedLength: number
	isSuccess: (data: Buffer) => boolean
	parser: typeof parsePresetAudioGains
} {
	return {
		name: 'Import Audio Preset',
		timeoutMs: SETTINGS.presetAudioTimeoutMs,
		expectedLength: PRESET_AUDIO_RESPONSE_LENGTH,
		isSuccess: (data: Buffer) => data.length === PRESET_AUDIO_RESPONSE_LENGTH && data[0] === 0x33,
		parser: parsePresetAudioGains,
	}
}
