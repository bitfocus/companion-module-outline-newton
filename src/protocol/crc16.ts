import { CRC16_INITIAL, CRC16_POLYNOMIAL } from './constants.js'

/**
 * Calculate CRC16 using polynomial 0xA001 with initial value 0x0000.
 * This matches the libcrc implementation used by Newton firmware.
 */
export function calculateCrc16(buffer: Buffer, offset = 0, length?: number): number {
	const end = length !== undefined ? offset + length : buffer.length
	let crc = CRC16_INITIAL

	for (let i = offset; i < end; i++) {
		crc ^= buffer[i]
		for (let bit = 0; bit < 8; bit++) {
			if (crc & 0x0001) {
				crc = (crc >> 1) ^ CRC16_POLYNOMIAL
			} else {
				crc = crc >> 1
			}
		}
	}

	return crc & 0xffff
}

/**
 * Verify CRC16 of a complete message (including the CRC bytes at the end).
 * If the CRC is correct, calculating over the entire message (including CRC) yields 0.
 * The CRC in the message is stored LSB first.
 */
export function verifyCrc16(buffer: Buffer, offset = 0, length?: number): boolean {
	return calculateCrc16(buffer, offset, length) === 0
}

/**
 * Append CRC16 to a buffer in LSB-first order (as required by Newton protocol).
 * The CRC is calculated over everything before the last 2 bytes,
 * then stored at the last 2 bytes in LSB-first format.
 */
export function appendCrc16(buffer: Buffer): void {
	const crc = calculateCrc16(buffer, 0, buffer.length - 2)
	// LSB first as required by Newton protocol
	buffer[buffer.length - 2] = crc & 0xff
	buffer[buffer.length - 1] = (crc >> 8) & 0xff
}
