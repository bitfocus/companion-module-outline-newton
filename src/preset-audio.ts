import { SETTINGS } from './config.js'
import { PRESET_AUDIO_RESPONSE_LENGTH, parsePresetAudioGains } from './protocol/command-parser.js'

const PRESET_AUDIO_BACKOFF_THRESHOLD = 2
const PRESET_AUDIO_MIN_BACKOFF_MS = 5000
const PRESET_AUDIO_MAX_BACKOFF_MS = 60000

export interface PresetAudioPollFailure {
	accepted: boolean
	consecutiveFailures: number
	retryDelayMs: number
	enteredBackoff: boolean
}

export interface PresetAudioPollSuccess {
	accepted: boolean
	recovered: boolean
}

/**
 * Single-flight and retry gate for the large 0x21 transfer.
 *
 * Attempt tokens make lifecycle resets safe: a completion from an old TCP
 * session cannot release a newer transfer. Changing only the interactivity
 * profile deliberately leaves this gate intact, so restarting the cadence
 * never queues a second 384 KiB read behind one already in flight.
 */
export class PresetAudioPollRecovery {
	private activeAttempt: number | null = null
	private nextAttempt = 0
	private consecutiveFailures = 0
	private retryNotBefore = 0

	begin(now: number = Date.now()): number | null {
		if (this.activeAttempt !== null || now < this.retryNotBefore) return null
		this.activeAttempt = ++this.nextAttempt
		return this.activeAttempt
	}

	release(attempt: number): boolean {
		if (this.activeAttempt !== attempt) return false
		this.activeAttempt = null
		return true
	}

	succeed(attempt: number): PresetAudioPollSuccess {
		if (!this.release(attempt)) return { accepted: false, recovered: false }
		const recovered = this.consecutiveFailures >= PRESET_AUDIO_BACKOFF_THRESHOLD
		this.consecutiveFailures = 0
		this.retryNotBefore = 0
		return { accepted: true, recovered }
	}

	fail(attempt: number, regularPollIntervalMs: number, now: number = Date.now()): PresetAudioPollFailure {
		if (!this.release(attempt)) {
			return {
				accepted: false,
				consecutiveFailures: this.consecutiveFailures,
				retryDelayMs: 0,
				enteredBackoff: false,
			}
		}

		this.consecutiveFailures++
		const retryDelayMs = presetAudioRetryDelayMs(this.consecutiveFailures, regularPollIntervalMs)
		this.retryNotBefore = now + retryDelayMs
		return {
			accepted: true,
			consecutiveFailures: this.consecutiveFailures,
			retryDelayMs,
			enteredBackoff: this.consecutiveFailures === PRESET_AUDIO_BACKOFF_THRESHOLD,
		}
	}

	reset(): void {
		this.activeAttempt = null
		this.consecutiveFailures = 0
		this.retryNotBefore = 0
	}
}

export function presetAudioRetryDelayMs(consecutiveFailures: number, regularPollIntervalMs: number): number {
	const regularInterval = positiveFiniteOr(regularPollIntervalMs, PRESET_AUDIO_MIN_BACKOFF_MS)
	if (consecutiveFailures < PRESET_AUDIO_BACKOFF_THRESHOLD) return regularInterval

	const exponent = Math.max(0, Math.min(consecutiveFailures - PRESET_AUDIO_BACKOFF_THRESHOLD, 10))
	return Math.min(PRESET_AUDIO_MAX_BACKOFF_MS, Math.max(PRESET_AUDIO_MIN_BACKOFF_MS, regularInterval) * 2 ** exponent)
}

function positiveFiniteOr(value: number, fallback: number): number {
	return Number.isFinite(value) && value > 0 ? value : fallback
}

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
		isSuccess: (data: Buffer) => data.length === PRESET_AUDIO_RESPONSE_LENGTH && data[0] === 0x33 && data[1] === 0x00,
		parser: parsePresetAudioGains,
	}
}
