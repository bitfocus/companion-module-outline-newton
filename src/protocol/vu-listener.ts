import { UDPHelper } from '@companion-module/base'
import { EventEmitter } from 'events'
import { PORT_METERS } from './constants.js'

/**
 * VU meter listener events.
 * Each VU packet decoded into per-channel float levels (linear or dB depending on device).
 */
export interface VuListenerEvents {
	vuPacket: [data: Buffer]
	vuLevels: [levels: VuLevels]
	error: [error: Error]
}

/**
 * Decoded VU meter levels.
 * Indices follow the device convention: 0..15 input DSP, 0..15 output DSP, etc.
 * Each level is a float; semantics depend on the firmware (typically dB or linear 0..1).
 */
export interface VuLevels {
	inputDsp: number[]
	outputDsp: number[]
	raw: Buffer
	format: 'float32-le-header2' | 'unknown'
}

const DEFAULT_VU_PORT = PORT_METERS

/**
 * Listens on the VU meter UDP port (6667) for broadcast VU packets from the
 * Newton device. The exact wire format is firmware-dependent; we expose the
 * raw buffer plus a best-effort decoded view so downstream code can pick
 * whichever form it needs.
 */
export class VuListener extends EventEmitter<VuListenerEvents> {
	private socket: UDPHelper | null = null
	private boundPort: number

	constructor(port: number = DEFAULT_VU_PORT) {
		super()
		this.boundPort = port
	}

	/**
	 * Start listening for VU packets.
	 * UDPHelper binds to the local port and accepts broadcast/unicast.
	 */
	start(): void {
		this.stop()
		// UDPHelper signature: (host, port) — for a listener we pass localhost
		// and the bind port. Some firmware sends VU as broadcast on the LAN; the
		// OS-level multicast/broadcast routing handles it as long as we bound.
		this.socket = new UDPHelper('0.0.0.0', this.boundPort, { bind_port: this.boundPort })

		this.socket.on('data', (data: Buffer) => {
			this.emit('vuPacket', data)
			const decoded = this.decodeVu(data)
			if (decoded) this.emit('vuLevels', decoded)
		})

		this.socket.on('error', (err) => {
			this.emit('error', err)
		})
	}

	/**
	 * Stop listening and free the socket.
	 */
	stop(): void {
		if (this.socket) {
			this.socket.destroy()
			this.socket = null
		}
	}

	/**
	 * Best-effort decode of a VU packet.
	 * Newton VU packets are typically structured as a small header followed by
	 * per-channel float32 (LE) values. Without an exact spec for this firmware
	 * we expose the raw buffer and a generic float-array view; consumers pick.
	 *
	 * Heuristic: if the buffer is large enough for 16 InputDsp + 16 OutputDsp
	 * float32 LE values plus a small header, decode that layout. Otherwise
	 * leave decoded fields empty — the raw buffer is always available.
	 */
	private decodeVu(data: Buffer): VuLevels | null {
		if (data.length < 4) return null

		// Best-effort: assume a 2-byte header (cmd + flag) followed by float32 LE values.
		// Without firmware-confirmed spec, we expose generic floats. Consumers can
		// reinterpret using the raw buffer if their device differs.
		const HEADER = 2
		const FLOAT_SIZE = 4
		const usable = Math.floor((data.length - HEADER) / FLOAT_SIZE)
		if (usable < 32) {
			return { inputDsp: [], outputDsp: [], raw: data, format: 'unknown' }
		}

		const inputDspCount = Math.min(16, usable)
		const outputDspCount = Math.min(16, Math.max(0, usable - inputDspCount))

		const inputDsp: number[] = []
		for (let i = 0; i < inputDspCount; i++) {
			inputDsp.push(data.readFloatLE(HEADER + i * FLOAT_SIZE))
		}
		const outputDsp: number[] = []
		for (let i = 0; i < outputDspCount; i++) {
			outputDsp.push(data.readFloatLE(HEADER + (inputDspCount + i) * FLOAT_SIZE))
		}

		return { inputDsp, outputDsp, raw: data, format: 'float32-le-header2' }
	}
}
