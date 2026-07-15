import {
	CLOCK_LIST_LENGTH,
	CLOCK_TYPE_COUNT,
	REPLY_ERR,
	REPLY_OK,
	SIGNALS_AUX_MIXER_PRIORITY_COUNT,
	SIGNALS_CLOCK_BLOCK_SIZE,
	SIGNALS_CLOCK_STATUS_BASE,
	SIGNALS_INPUT_DSP_PRIORITY_COUNT,
	SIGNALS_PRIORITY_PATCH_LENGTH,
	SIGNALS_PRIORITY_PATCH_OFFSET,
	SPR_CRC_SIZE,
	SPR_HEADER,
	SPR_HEADER_SIZE,
	SPR_NOERR,
	SPC_HEADER,
} from './constants.js'
import { verifyCrc16 } from './crc16.js'
import type { ClockPriorityState, GainReadState, LegacyResponse, PriorityListState, SPRResponse } from './types.js'

/**
 * Legacy response header size: 2 bytes (reply code + 0x00).
 * E.g. [0x33, 0x00] = success, [0x66, 0x00] = error.
 */
export const LEGACY_HEADER_SIZE = 2

/**
 * Parse a legacy protocol response.
 * Legacy responses have a 2-byte header: [replyCode, 0x00]
 * 0x33 0x00 = success, 0x66 0x00 = error.
 * The remaining bytes (from offset 2) are the payload.
 */
export function parseLegacyResponse(data: Buffer): LegacyResponse {
	if (data.length < LEGACY_HEADER_SIZE) {
		return { success: false, command: 0, payload: Buffer.alloc(0) }
	}

	const replyCode = data[0]
	return {
		success: replyCode === REPLY_OK,
		command: replyCode,
		payload: data.subarray(LEGACY_HEADER_SIZE),
	}
}

/**
 * Parse an SPR (Special Protocol Reply) message.
 *
 * Structure:
 * [0]: 0xF1 (SPR header)
 * [1]: 0x00 (empty)
 * [2-3]: CMD (16bit MSB first)
 * [4-5]: LEN (total length, 16bit MSB first)
 * [6-7]: Standard Reply (16bit, 0x3300=OK, 0x6600=ERR)
 * [8..N-3]: payload (JSON)
 * [N-2..N-1]: CRC16 (LSB first)
 */
export function parseSPR(data: Buffer): SPRResponse | null {
	if (data.length < SPR_HEADER_SIZE + SPR_CRC_SIZE) {
		return null
	}

	if (data[0] !== SPR_HEADER) {
		return null
	}

	const cmd = data.readUInt16BE(2)
	const len = data.readUInt16BE(4)

	if (data.length < len) {
		return null // incomplete message
	}

	// Verify CRC over the complete message
	const messageSlice = data.subarray(0, len)
	if (!verifyCrc16(messageSlice)) {
		return null
	}

	const stdReply = data.readUInt16BE(6)
	const success = stdReply === SPR_NOERR

	// Extract JSON payload if present
	const payloadStart = SPR_HEADER_SIZE
	const payloadEnd = len - SPR_CRC_SIZE
	let payload: Record<string, unknown> | null = null
	const rawPayload = data.subarray(payloadStart, payloadEnd)

	if (payloadEnd > payloadStart) {
		try {
			const jsonStr = rawPayload.toString('utf-8')
			payload = JSON.parse(jsonStr) as Record<string, unknown>
		} catch {
			// payload is not valid JSON, leave as null
		}
	}

	return { command: cmd, success, payload, rawPayload }
}

/**
 * Determine if a buffer starts with a Special Protocol message (SPC or SPR).
 */
export function isSpecialProtocol(data: Buffer): boolean {
	if (data.length < 1) return false
	return data[0] === SPC_HEADER || data[0] === SPR_HEADER
}

/**
 * Get the expected total length of a Special Protocol message from its header.
 * Returns -1 if the buffer doesn't contain enough data for the length field.
 */
export function getSpecialProtocolLength(data: Buffer): number {
	if (data.length < 6) return -1
	return data.readUInt16BE(4)
}

/**
 * Inactivity window (ms) used only for legacy responses whose size is not
 * known by the caller. All Newton commands used by the module now select a
 * fixed response size or SPR framing before sending.
 * Legacy responses carry no length field, so we wait for a brief gap in the
 * incoming stream before flushing the buffer to the consumer. Tuned for LAN
 * round-trip times: long enough to assemble a 1024-byte signals blob that
 * arrives in multiple TCP segments, short enough not to noticeably delay
 * 2-byte ACKs.
 */
const LEGACY_COALESCE_MS = 30
// Flood guard for replies whose size is unknown. Commands that declare a
// bigger fixed response size (e.g. the 384 KiB 0x21 audio preset) raise the
// effective cap for their own turn via setResponseFraming.
const MAX_ACCUMULATOR_BYTES = 64 * 1024

export type ResponseFraming = 'legacyFixedLength' | 'legacyCoalesced' | 'spr'

/**
 * Buffer accumulator for handling TCP stream fragmentation.
 * Collects incoming data chunks and emits complete messages.
 *
 * - Special Protocol messages (SPR, prefix 0xF1) carry a length field and
 *   are emitted exactly when their declared length has arrived.
 * - Legacy responses have no length field; we coalesce incoming bytes for a
 *   short inactivity window and then flush, which lets large responses
 *   (e.g. 1024-byte 0x2B signals blob) reassemble correctly even when split
 *   across multiple TCP segments.
 */
export class MessageAccumulator {
	private chunks: Buffer[] = []
	private firstChunk = 0
	private firstOffset = 0
	private bufferedLength = 0
	private flushTimer: ReturnType<typeof setTimeout> | null = null
	private framing: ResponseFraming = 'legacyCoalesced'
	private expectedLegacyLength = 0
	// Some fixed-size legacy reads return a bare [0x66, 0x00] when the
	// feature is unsupported. This must be explicitly enabled by the caller:
	// raw replies can legitimately start with the same two bytes.
	// In SPR framing, a legacy [0x33/0x66, 0x00] is accepted only as the very
	// first reply of the turn (pre-0.98 firmware rejecting an SPC command);
	// once real SPR bytes are seen, stray status-looking pairs stay junk.
	private sprLegacyReplyWindow = true
	private maxBufferedBytes = MAX_ACCUMULATOR_BYTES
	private readonly onLegacyMessage: (data: Buffer) => void
	private readonly onSPRMessage: (data: Buffer) => void

	constructor(onLegacyMessage: (data: Buffer) => void, onSPRMessage: (data: Buffer) => void) {
		this.onLegacyMessage = onLegacyMessage
		this.onSPRMessage = onSPRMessage
	}

	/**
	 * Select framing for the response to the command currently in flight.
	 * Newton's legacy TCP replies do not carry a command id or a size, so this
	 * must be set from the transmitted command rather than guessed from the
	 * first byte received (a raw 0x2B status packet can legitimately start F0/F1).
	 */
	setResponseFraming(framing: ResponseFraming, expectedLegacyLength = 0): void {
		if (framing === 'legacyFixedLength' && (!Number.isInteger(expectedLegacyLength) || expectedLegacyLength < 1)) {
			throw new Error('Legacy fixed-length framing requires a positive byte length')
		}
		this.reset()
		this.framing = framing
		this.expectedLegacyLength = expectedLegacyLength
		this.sprLegacyReplyWindow = true
		// Let declared large fixed-length replies through while keeping the
		// small default as a flood guard for everything else.
		this.maxBufferedBytes = Math.max(MAX_ACCUMULATOR_BYTES, expectedLegacyLength + 4096)
	}

	/**
	 * Feed incoming data from TCP into the accumulator.
	 * Complete messages are emitted via callbacks.
	 */
	feed(data: Buffer): void {
		if (data.length === 0) return
		this.chunks.push(data)
		this.bufferedLength += data.length
		if (this.bufferedLength > this.maxBufferedBytes) {
			// A frame larger than the declared/expected response cannot be
			// recovered safely, so drop it.
			this.reset()
			return
		}
		this.processBuffer()
	}

	private processBuffer(): void {
		if (this.framing === 'spr') {
			this.processSPRBuffer()
			return
		}

		if (this.framing === 'legacyFixedLength') {
			// A complete documented raw reply always wins over the short-error
			// compatibility path below.
			if (this.bufferedLength >= this.expectedLegacyLength) {
				this.cancelFlushTimer()
				const message = this.take(this.expectedLegacyLength)
				// The client serializes requests. Any suffix cannot be a response to a
				// later request yet, so discard it instead of mis-associating it.
				this.discard(this.bufferedLength)
				this.onLegacyMessage(message)
				return
			}

			// A rejecting firmware sends only [0x66, 0x00]; every fixed-length
			// read accepts it so a rejection can never escalate into a timeout
			// teardown. Wait one TCP coalescing window before accepting: a valid
			// raw response may start with these bytes and arrive fragmented. Any
			// additional byte before the timer expires makes it a normal
			// fixed-size response again.
			if (
				this.bufferedLength === LEGACY_HEADER_SIZE &&
				this.peek(LEGACY_HEADER_SIZE)[0] === REPLY_ERR &&
				this.peek(LEGACY_HEADER_SIZE)[1] === 0x00
			) {
				this.scheduleFlush()
				return
			}

			this.cancelFlushTimer()
			return
		}

		// Compatibility fallback for callers that truly do not know the reply
		// size. This is deliberately never selected from the data itself.
		this.scheduleFlush()
	}

	private processSPRBuffer(): void {
		while (this.bufferedLength > 0) {
			// Firmware without Special Protocol support (< 0.98) answers an SPC
			// request with a plain legacy [0x33/0x66, 0x00] status. Surface it as
			// a legacy message so the in-flight command resolves as a rejection
			// instead of timing out (a timeout tears down the connection by design).
			const first = this.peek(1)[0]
			if (this.sprLegacyReplyWindow && (first === REPLY_OK || first === REPLY_ERR)) {
				if (this.bufferedLength < LEGACY_HEADER_SIZE) return
				if (this.peek(LEGACY_HEADER_SIZE)[1] === 0x00) {
					this.onLegacyMessage(this.take(LEGACY_HEADER_SIZE))
					continue
				}
			}
			this.sprLegacyReplyWindow = false
			const headerOffset = this.indexOf(SPR_HEADER)
			if (headerOffset < 0) {
				this.discard(this.bufferedLength)
				return
			}
			if (headerOffset > 0) {
				this.discard(headerOffset)
			}
			if (this.bufferedLength < 6) return

			const expectedLen = getSpecialProtocolLength(this.peek(6))
			const minFrameLen = SPR_HEADER_SIZE + SPR_CRC_SIZE
			if (expectedLen < minFrameLen || expectedLen > MAX_ACCUMULATOR_BYTES) {
				// Corrupt length: advance one byte and search for the next SPR header.
				this.discard(1)
				continue
			}
			if (this.bufferedLength < expectedLen) return

			const message = this.take(expectedLen)
			this.onSPRMessage(message)
		}
	}

	private scheduleFlush(): void {
		this.cancelFlushTimer()
		this.flushTimer = setTimeout(() => {
			this.flushTimer = null
			this.flushLegacy()
		}, LEGACY_COALESCE_MS)
	}

	private cancelFlushTimer(): void {
		if (this.flushTimer) {
			clearTimeout(this.flushTimer)
			this.flushTimer = null
		}
	}

	private flushLegacy(): void {
		if (this.bufferedLength === 0) return
		this.onLegacyMessage(this.take(this.bufferedLength))
	}

	/**
	 * Clear the internal buffer.
	 */
	reset(): void {
		this.cancelFlushTimer()
		this.chunks = []
		this.firstChunk = 0
		this.firstOffset = 0
		this.bufferedLength = 0
	}

	private indexOf(byte: number): number {
		let offset = 0
		for (let i = this.firstChunk; i < this.chunks.length; i++) {
			const chunk = this.chunks[i]
			const chunkOffset = i === this.firstChunk ? this.firstOffset : 0
			const found = chunk.indexOf(byte, chunkOffset)
			if (found >= 0) return offset + found - chunkOffset
			offset += chunk.length - chunkOffset
		}
		return -1
	}

	private peek(length: number): Buffer {
		if (length > this.bufferedLength) throw new RangeError('Cannot peek beyond accumulated data')
		const result = Buffer.allocUnsafe(length)
		let copied = 0
		for (let i = this.firstChunk; copied < length; i++) {
			const chunk = this.chunks[i]
			const chunkOffset = i === this.firstChunk ? this.firstOffset : 0
			const count = Math.min(length - copied, chunk.length - chunkOffset)
			chunk.copy(result, copied, chunkOffset, chunkOffset + count)
			copied += count
		}
		return result
	}

	private take(length: number): Buffer {
		const result = this.peek(length)
		this.discard(length)
		return result
	}

	private discard(length: number): void {
		if (length < 0 || length > this.bufferedLength) throw new RangeError('Cannot discard beyond accumulated data')
		let remaining = length
		while (remaining > 0) {
			const chunk = this.chunks[this.firstChunk]
			const available = chunk.length - this.firstOffset
			if (remaining < available) {
				this.firstOffset += remaining
				remaining = 0
			} else {
				remaining -= available
				this.firstChunk++
				this.firstOffset = 0
			}
		}
		this.bufferedLength -= length
		if (this.bufferedLength === 0) {
			this.chunks = []
			this.firstChunk = 0
			this.firstOffset = 0
		} else if (this.firstChunk > 128 && this.firstChunk * 2 >= this.chunks.length) {
			this.chunks = this.chunks.slice(this.firstChunk)
			this.firstChunk = 0
		}
	}
}

/**
 * Extract a null-terminated (or end-of-buffer) string from a legacy response.
 * Payload starts after the 2-byte header [replyCode, 0x00].
 */
function parseLegacyString(data: Buffer): string | null {
	if (data.length <= LEGACY_HEADER_SIZE) return null
	if (data[0] !== REPLY_OK) return null
	let end = LEGACY_HEADER_SIZE
	while (end < data.length && data[end] !== 0) end++
	return data.subarray(LEGACY_HEADER_SIZE, end).toString('utf-8')
}

/**
 * Parse the response to an ImportDescription command (0x3E).
 * Response: [0x33, 0x00, ...description bytes...] on success.
 */
export function parseImportDescriptionResponse(data: Buffer): string | null {
	return parseLegacyString(data)
}

/**
 * Parse the response to an ImportFirmware command (0x40).
 * Response: [0x33, 0x00, ...firmware version bytes...] on success.
 */
export function parseImportFirmwareResponse(data: Buffer): string | null {
	return parseLegacyString(data)
}

/**
 * Compare a device firmware string (e.g. "0.97", "1.0.2") against a minimum
 * version. Numeric segments are compared left to right; missing segments
 * count as 0. Returns null when either string carries no numeric segment, so
 * callers can fall back to probing the feature instead of guessing.
 */
export function isFirmwareAtLeast(version: string, minimum: string): boolean | null {
	const parse = (value: string): number[] | null => value.match(/\d+/g)?.map(Number) ?? null
	const have = parse(version)
	const want = parse(minimum)
	if (!have || !want) return null
	for (let i = 0; i < Math.max(have.length, want.length); i++) {
		const a = have[i] ?? 0
		const b = want[i] ?? 0
		if (a !== b) return a > b
	}
	return true
}

/**
 * Parse the response to an ImportSerial command (0x37).
 * Response: [0x33, 0x00, ...serial number bytes...] on success.
 */
export function parseImportSerialResponse(data: Buffer): string | null {
	return parseLegacyString(data)
}

/**
 * Priority patch state extracted from an ImportSignals (0x2B) response.
 * inputDsp[i] = currently active source channel for InputDsp priority patch i (i = 0..15).
 * auxMixer[i] = currently active source channel for AuxMixer priority patch i (i = 0..7).
 */
export interface PriorityPatchState {
	inputDsp: number[]
	auxMixer: number[]
}

/**
 * Extract the priority patch state from a 0x2B (ImportSignals) response.
 *
 * Unlike most legacy responses, the 0x2B reply is a raw 1024-byte signals
 * blob without the standard `0x33 0x00` header — the data starts at byte 0.
 * Bytes [666..689] hold the currently active source channel for each
 * priority patch (16 InputDsp + 8 AuxMixer).
 */
export function parsePriorityPatchState(data: Buffer): PriorityPatchState | null {
	if (data.length < SIGNALS_PRIORITY_PATCH_OFFSET + SIGNALS_PRIORITY_PATCH_LENGTH) {
		return null
	}

	const block = data.subarray(
		SIGNALS_PRIORITY_PATCH_OFFSET,
		SIGNALS_PRIORITY_PATCH_OFFSET + SIGNALS_PRIORITY_PATCH_LENGTH,
	)
	const inputDsp = Array.from(block.subarray(0, SIGNALS_INPUT_DSP_PRIORITY_COUNT))
	const auxMixer = Array.from(
		block.subarray(
			SIGNALS_INPUT_DSP_PRIORITY_COUNT,
			SIGNALS_INPUT_DSP_PRIORITY_COUNT + SIGNALS_AUX_MIXER_PRIORITY_COUNT,
		),
	)

	return { inputDsp, auxMixer }
}

/**
 * Parse a 0x91 priority list response.
 * Expected successful payload is 6 bytes:
 * [0..3] source channels from highest to lowest priority
 * [4] isForced/manual mode flag
 * [5] forced channel
 *
 * Some firmware variants may include the standard legacy OK header; accept both.
 */
export function parsePriorityListResponse(data: Buffer): PriorityListState | null {
	const payload =
		data.length >= LEGACY_HEADER_SIZE + 6 && data[0] === REPLY_OK
			? data.subarray(LEGACY_HEADER_SIZE, LEGACY_HEADER_SIZE + 6)
			: data.length >= 6
				? data.subarray(0, 6)
				: null

	if (!payload) return null

	return {
		sources: Array.from(payload.subarray(0, 4)),
		isForced: payload[4] !== 0,
		forcedChannel: payload[5] ?? -1,
	}
}

/**
 * Parse a Get Processing Clock (0x81) response: 19 bytes
 * [0-15] priority list, [16] isForced, [17] forced index, [18] is48.
 * Accepts both the raw 19-byte body and the [0x33,0x00]-prefixed form.
 */
export function parseClockStateResponse(data: Buffer): ClockPriorityState | null {
	const bodyLength = CLOCK_LIST_LENGTH + 3
	const payload =
		data.length >= LEGACY_HEADER_SIZE + bodyLength && data[0] === REPLY_OK
			? data.subarray(LEGACY_HEADER_SIZE, LEGACY_HEADER_SIZE + bodyLength)
			: data.length >= bodyLength
				? data.subarray(0, bodyLength)
				: null

	if (!payload) return null

	return {
		list: Array.from(payload.subarray(0, CLOCK_LIST_LENGTH)),
		isForced: payload[CLOCK_LIST_LENGTH] !== 0,
		forcedIndex: payload[CLOCK_LIST_LENGTH + 1],
		is48: payload[CLOCK_LIST_LENGTH + 2] !== 0,
	}
}

// ===== 0x21 audio preset blob =====
// The preset is 393216 bytes; the 0x21 response prefixes it with [0x33, 0x00].
// Gain block: 458 entries of 5 bytes (float32 LE dB + mute byte) at preset
// offset 1008, ordered by Channel Type: 16 InputDsp, 16 OutputDsp, 10 AuxMixer
// (8 ch + 2 masters), 288 MatrixMixer, 64 Trimmer, 64 OutputGroup = 458.
export const PRESET_AUDIO_SIZE = 393216
export const PRESET_AUDIO_RESPONSE_LENGTH = LEGACY_HEADER_SIZE + PRESET_AUDIO_SIZE
const PRESET_GAIN_OFFSET = 1008
const PRESET_GAIN_STRIDE = 5
const PRESET_GAIN_INPUT_BASE = 0
const PRESET_GAIN_OUTPUT_BASE = 16

export interface PresetAudioGains {
	/** Gain+mute per Input DSP channel 0-15 (null when the float is invalid). */
	inputDsp: (GainReadState | null)[]
	/** Gain+mute per Output DSP channel 0-15 (null when the float is invalid). */
	outputDsp: (GainReadState | null)[]
}

/** Extract the Input/Output DSP gain+mute banks from a 0x21 response. */
export function parsePresetAudioGains(data: Buffer): PresetAudioGains | null {
	const gainBase = LEGACY_HEADER_SIZE + PRESET_GAIN_OFFSET
	const needed = gainBase + (PRESET_GAIN_OUTPUT_BASE + 16) * PRESET_GAIN_STRIDE
	if (data.length < needed || data[0] !== REPLY_OK) return null

	const readEntry = (entryIndex: number): GainReadState | null => {
		const offset = gainBase + entryIndex * PRESET_GAIN_STRIDE
		const gainDb = data.readFloatLE(offset)
		if (!Number.isFinite(gainDb)) return null
		return { gainDb, muted: data[offset + 4] !== 0 }
	}

	const inputDsp: (GainReadState | null)[] = []
	const outputDsp: (GainReadState | null)[] = []
	for (let i = 0; i < 16; i++) {
		inputDsp.push(readEntry(PRESET_GAIN_INPUT_BASE + i))
		outputDsp.push(readEntry(PRESET_GAIN_OUTPUT_BASE + i))
	}
	return { inputDsp, outputDsp }
}

/**
 * Extract the definitive clock source per clock type from the 0x2B blob:
 * bytes 631 (Master), 648 (WC Out 1) and 665 (WC Out 2) hold the selected
 * Clock List value post-backup.
 */
export function parseClockSelected(data: Buffer): number[] | null {
	const needed = SIGNALS_CLOCK_STATUS_BASE + SIGNALS_CLOCK_BLOCK_SIZE * CLOCK_TYPE_COUNT
	if (data.length < needed) return null
	const selected: number[] = []
	for (let type = 0; type < CLOCK_TYPE_COUNT; type++) {
		selected.push(data[SIGNALS_CLOCK_STATUS_BASE + type * SIGNALS_CLOCK_BLOCK_SIZE + (SIGNALS_CLOCK_BLOCK_SIZE - 1)])
	}
	return selected
}
