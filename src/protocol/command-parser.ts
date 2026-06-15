import {
	REPLY_OK,
	SIGNALS_AUX_MIXER_PRIORITY_COUNT,
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
import type { LegacyResponse, PriorityListState, SPRResponse } from './types.js'

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
 * Inactivity window (ms) used to coalesce fragmented legacy responses.
 * Legacy responses carry no length field, so we wait for a brief gap in the
 * incoming stream before flushing the buffer to the consumer. Tuned for LAN
 * round-trip times: long enough to assemble a 1024-byte signals blob that
 * arrives in multiple TCP segments, short enough not to noticeably delay
 * 2-byte ACKs.
 */
const LEGACY_COALESCE_MS = 30

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
	private buffer: Buffer = Buffer.alloc(0)
	private flushTimer: ReturnType<typeof setTimeout> | null = null
	private readonly onLegacyMessage: (data: Buffer) => void
	private readonly onSPRMessage: (data: Buffer) => void

	constructor(onLegacyMessage: (data: Buffer) => void, onSPRMessage: (data: Buffer) => void) {
		this.onLegacyMessage = onLegacyMessage
		this.onSPRMessage = onSPRMessage
	}

	/**
	 * Feed incoming data from TCP into the accumulator.
	 * Complete messages are emitted via callbacks.
	 */
	feed(data: Buffer): void {
		this.buffer = Buffer.concat([this.buffer, data])
		this.processBuffer()
	}

	private processBuffer(): void {
		while (this.buffer.length > 0) {
			if (isSpecialProtocol(this.buffer)) {
				// Cancel any pending legacy flush — a complete SPR takes priority.
				this.cancelFlushTimer()

				const expectedLen = getSpecialProtocolLength(this.buffer)
				if (expectedLen < 0 || this.buffer.length < expectedLen) {
					break // wait for more data
				}

				const message = this.buffer.subarray(0, expectedLen)
				this.buffer = this.buffer.subarray(expectedLen)

				if (message[0] === SPR_HEADER) {
					this.onSPRMessage(Buffer.from(message))
				}
			} else {
				// Legacy: coalesce — schedule a flush after a short inactivity
				// window. Each new chunk resets the timer so multi-segment
				// responses arrive intact.
				this.scheduleFlush()
				break
			}
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
		if (this.buffer.length === 0) return
		const message = this.buffer
		this.buffer = Buffer.alloc(0)
		this.onLegacyMessage(Buffer.from(message))
	}

	/**
	 * Clear the internal buffer.
	 */
	reset(): void {
		this.cancelFlushTimer()
		this.buffer = Buffer.alloc(0)
	}
}

/**
 * Parse the response to a ReadPreset command (0x08).
 * Response: [0x33, 0x00, presetNumber] on success (3 bytes).
 */
export function parseReadPresetResponse(data: Buffer): number | null {
	if (data.length < LEGACY_HEADER_SIZE) return null
	if (data[0] !== REPLY_OK) return null
	if (data.length < LEGACY_HEADER_SIZE + 1) return null
	return data[LEGACY_HEADER_SIZE]
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
