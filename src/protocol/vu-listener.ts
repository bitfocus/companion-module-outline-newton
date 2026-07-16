import { UDPHelper } from '@companion-module/base'
import { EventEmitter } from 'events'
import { isIP } from 'node:net'
import { buildImportSignalsCommand } from './command-builder.js'
import { PORT_METERS } from './constants.js'

const STATUS_PACKET_LENGTH = 1024
const CHANNEL_COUNT = 16
// 0x2B status blob meter banks (16 float32 each): peak, peak-hold and RMS for
// Input DSP then Output DSP.
const INPUT_PEAK_OFFSET = 0
const INPUT_RMS_OFFSET = 128
const OUTPUT_PEAK_OFFSET = 192
const OUTPUT_RMS_OFFSET = 320
const EXPIRY_MS = 3000
const MIN_DB = -144

export interface VuListenerEvents {
	vuPacket: [data: Buffer]
	vuLevels: [levels: VuLevels]
	expired: []
	error: [error: Error]
}

/** Documented 0x2B status meters, exposed as peak and RMS dB values. */
export interface VuLevels {
	inputDsp: number[]
	outputDsp: number[]
	inputDspRms: number[]
	outputDspRms: number[]
	raw: Buffer
	format: 'status-1024-peak-db'
}

interface UdpRemoteInfo {
	address?: string
	port?: number
}

/**
 * Polls Newton's UDP meter/status server. The helper deliberately has no
 * bind_port: the operating system allocates a local ephemeral port, which is
 * where Newton sends the 1024-byte reply. Meter data stays off TCP.
 */
export class VuListener extends EventEmitter<VuListenerEvents> {
	private socket: UDPHelper | null = null
	private expiryTimer: ReturnType<typeof setTimeout> | null = null
	private pollTimer: ReturnType<typeof setInterval> | null = null

	constructor(
		private readonly host: string,
		private readonly port: number = PORT_METERS,
		private readonly pollIntervalMs: number = 200,
	) {
		super()
	}

	start(): void {
		this.stop()
		// Do not bind a fixed local port. UDPHelper binds an ephemeral local port
		// by default, then sends each status query to Newton's server port.
		this.socket = new UDPHelper(this.host, this.port)
		this.socket.on('data', (data: Buffer, rinfo?: UdpRemoteInfo) => {
			if (!this.isExpectedSource(rinfo) || data.length !== STATUS_PACKET_LENGTH) return
			const decoded = decodeStatusMeters(data)
			if (!decoded) return
			this.armExpiry()
			this.emit('vuPacket', data)
			this.emit('vuLevels', decoded)
		})
		this.socket.on('error', (err: Error) => this.emit('error', err))
		this.socket.on('listening', () => {
			this.pollStatus()
			this.pollTimer = setInterval(() => this.pollStatus(), this.pollIntervalMs)
		})

		this.armExpiry()
	}

	stop(): void {
		if (this.pollTimer) {
			clearInterval(this.pollTimer)
			this.pollTimer = null
		}
		if (this.expiryTimer) {
			clearTimeout(this.expiryTimer)
			this.expiryTimer = null
		}
		this.socket?.destroy()
		this.socket = null
	}

	private pollStatus(): void {
		const socket = this.socket
		if (!socket) return
		// This is a new real-time status sample, not a TCP retry. UDP transport
		// deliberately provides no retransmission when a sample is lost.
		void socket.send(buildImportSignalsCommand()).catch((err: unknown) => {
			this.emit('error', err instanceof Error ? err : new Error(String(err)))
		})
	}

	private armExpiry(): void {
		if (this.expiryTimer) clearTimeout(this.expiryTimer)
		this.expiryTimer = setTimeout(() => {
			this.expiryTimer = null
			this.emit('expired')
		}, EXPIRY_MS)
	}

	private isExpectedSource(rinfo?: UdpRemoteInfo): boolean {
		// Responses must come from Newton's meter server port. For an IP target
		// validate the peer address as well; for a DNS target UDPHelper resolves
		// the host, so the source port and packet shape remain the reliable guard.
		if (rinfo?.port !== this.port) return false
		return isIP(this.host) === 0 || rinfo.address === this.host
	}
}

/** Decode the Newton 0x2B status blob's input/output peak and RMS meter banks. */
export function decodeStatusMeters(data: Buffer): VuLevels | null {
	if (data.length !== STATUS_PACKET_LENGTH) return null
	const inputDsp: number[] = []
	const outputDsp: number[] = []
	const inputDspRms: number[] = []
	const outputDspRms: number[] = []
	for (let i = 0; i < CHANNEL_COUNT; i++) {
		inputDsp.push(antilogToDb(data.readFloatLE(INPUT_PEAK_OFFSET + i * 4), 20))
		outputDsp.push(antilogToDb(data.readFloatLE(OUTPUT_PEAK_OFFSET + i * 4), 20))
		inputDspRms.push(antilogToDb(data.readFloatLE(INPUT_RMS_OFFSET + i * 4), 20))
		outputDspRms.push(antilogToDb(data.readFloatLE(OUTPUT_RMS_OFFSET + i * 4), 20))
	}
	return { inputDsp, outputDsp, inputDspRms, outputDspRms, raw: data, format: 'status-1024-peak-db' }
}

function antilogToDb(value: number, multiplier: number): number {
	return Number.isFinite(value) && value > 0 ? Math.max(MIN_DB, multiplier * Math.log10(value)) : MIN_DB
}
