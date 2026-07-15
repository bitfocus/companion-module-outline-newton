import { InstanceStatus, TCPHelper } from '@companion-module/base'
import { EventEmitter } from 'events'
import { PORT_TCP, REPLY_ERR, REPLY_OK, SPC_HEADER } from './constants.js'
import { MessageAccumulator, parseSPR, type ResponseFraming } from './command-parser.js'
import type { SPRResponse } from './types.js'

const COMMAND_TIMEOUT_MS = 5000
const RECONNECT_INTERVAL_MS = 10000
const LEGACY_ACK_LENGTH = 2

export interface NewtonTcpClientEvents {
	connected: []
	disconnected: []
	error: [error: Error]
	rawData: [direction: 'TX' | 'RX', data: Buffer]
	commandResult: [result: NewtonCommandResult<unknown>]
	commandError: [name: string, error: Error]
	legacyResponse: [data: Buffer]
	sprResponse: [response: SPRResponse]
	statusChange: [status: InstanceStatus, message: string | undefined]
}

export interface SendCommandExpectOptions<TParsed = Buffer> {
	name?: string
	timeoutMs?: number
	/** Required for non-ACK legacy reads, e.g. status=1024 and H2L=6. */
	expectedLength?: number
	/** How to frame the reply. Defaults from the request command. */
	responseFraming?: ResponseFraming
	/** SPR command id expected in the response (defaults from an SPC request). */
	expectedSprCommand?: number
	isSuccess?: (data: Buffer) => boolean
	parser?: (data: Buffer) => TParsed | null
}

export interface NewtonCommandResult<TParsed = Buffer> {
	name: string
	tx: Buffer
	rx: Buffer
	success: boolean
	parsed: TParsed | null
	error?: string
}

interface ResolvedCommandOptions<TParsed> {
	name: string
	timeoutMs: number
	expectedLength: number
	responseFraming: ResponseFraming
	expectedSprCommand?: number
	isSuccess?: (data: Buffer) => boolean
	parser?: (data: Buffer) => TParsed | null
}

interface PendingCommand<TParsed = Buffer> {
	cmd: Buffer
	options: ResolvedCommandOptions<TParsed>
	resolve: (result: NewtonCommandResult<TParsed>) => void
	reject: (err: Error) => void
	timer: ReturnType<typeof setTimeout> | null
}

/**
 * TCP client wrapper for Newton device communication.
 *
 * Legacy replies carry no request id, so commands are serialized and every
 * response is framed from the command that was transmitted. A timeout is a
 * hard protocol boundary: the socket is rebuilt before any later command can
 * be sent, preventing an old legacy reply from resolving a newer request.
 */
export class NewtonTcpClient extends EventEmitter<NewtonTcpClientEvents> {
	private socket: TCPHelper | null = null
	private readonly accumulator: MessageAccumulator
	private host: string
	private port: number
	private readonly socketFactory: (host: string, port: number) => TCPHelper
	private commandQueue: PendingCommand<unknown>[] = []
	private activeCommand: PendingCommand<unknown> | null = null

	constructor(
		host: string,
		port: number = PORT_TCP,
		socketFactory: (host: string, port: number) => TCPHelper = (targetHost, targetPort) =>
			new TCPHelper(targetHost, targetPort, { reconnect_interval: RECONNECT_INTERVAL_MS }),
	) {
		super()
		this.host = host
		this.port = port
		this.socketFactory = socketFactory
		this.accumulator = new MessageAccumulator(
			(data) => this.handleLegacyMessage(data),
			(data) => this.handleSPRMessage(data),
		)
	}

	connect(): void {
		this.destroy()
		const socket = this.socketFactory(this.host, this.port)
		this.socket = socket

		socket.on('connect', () => {
			if (this.socket !== socket) return
			this.accumulator.reset()
			this.emit('connected')
		})
		socket.on('data', (data: Buffer) => {
			if (this.socket !== socket) return
			this.emit('rawData', 'RX', data)
			this.accumulator.feed(data)
		})
		socket.on('error', (err: Error) => {
			if (this.socket !== socket) return
			this.accumulator.reset()
			this.rejectAll(err)
			this.emit('error', err)
		})
		socket.on('end', () => {
			if (this.socket !== socket) return
			this.accumulator.reset()
			this.rejectAll(new Error('Connection closed'))
			this.emit('disconnected')
		})
		socket.on('status_change', (status, message) => {
			if (this.socket === socket) this.emit('statusChange', status, message)
		})
	}

	reconnect(host: string, port: number = PORT_TCP): void {
		this.host = host
		this.port = port
		this.connect()
	}

	async sendCommand(cmd: Buffer): Promise<Buffer> {
		const result = await this.sendCommandExpect(cmd)
		return result.rx
	}

	async sendCommandExpect<TParsed = Buffer>(
		cmd: Buffer,
		options: SendCommandExpectOptions<TParsed> = {},
	): Promise<NewtonCommandResult<TParsed>> {
		if (!this.socket || !this.socket.isConnected) throw new Error('Not connected to Newton device')

		const isSpc = cmd[0] === SPC_HEADER
		const responseFraming = options.responseFraming ?? (isSpc ? 'spr' : 'legacyFixedLength')
		const expectedLength = options.expectedLength ?? (responseFraming === 'legacyFixedLength' ? LEGACY_ACK_LENGTH : 0)
		if (responseFraming === 'legacyFixedLength' && expectedLength < 1) {
			throw new Error('Legacy fixed-length commands require expectedLength')
		}
		const expectedSprCommand =
			options.expectedSprCommand ?? (isSpc && cmd.length >= 4 ? cmd.readUInt16BE(2) : undefined)
		const fullOptions: ResolvedCommandOptions<TParsed> = {
			name: options.name ?? `0x${(cmd[0] ?? 0).toString(16).padStart(2, '0')}`,
			timeoutMs: options.timeoutMs ?? COMMAND_TIMEOUT_MS,
			expectedLength,
			responseFraming,
			expectedSprCommand,
			isSuccess: options.isSuccess,
			parser: options.parser,
		}

		return new Promise<NewtonCommandResult<TParsed>>((resolve, reject) => {
			this.commandQueue.push({ cmd, options: fullOptions, resolve, reject, timer: null } as PendingCommand<unknown>)
			void this.processQueue()
		})
	}

	/** Send a command which intentionally has no reply to associate. */
	sendCommandNoWait(cmd: Buffer): void {
		const socket = this.socket
		if (!socket?.isConnected) return
		this.emit('rawData', 'TX', cmd)
		const name = `0x${(cmd[0] ?? 0).toString(16).padStart(2, '0')}`
		void socket.send(cmd).catch((err) => {
			if (this.socket === socket) this.emit('commandError', name, toError(err))
		})
	}

	get isConnected(): boolean {
		return this.socket?.isConnected ?? false
	}

	destroy(): void {
		this.rejectAll(new Error('Client destroyed'))
		this.accumulator.reset()
		const socket = this.socket
		this.socket = null
		socket?.destroy()
	}

	private handleLegacyMessage(data: Buffer): void {
		const item = this.activeCommand
		// Firmware without Special Protocol support (< 0.98) answers an SPC
		// request with a plain legacy [0x66, 0x00]: let that status reply resolve
		// the SPR-framed command as a device rejection rather than leaving it to
		// the timeout, which would tear down an otherwise healthy connection.
		const isLegacyStatusReply =
			data.length === LEGACY_ACK_LENGTH && data[1] === 0x00 && (data[0] === REPLY_OK || data[0] === REPLY_ERR)
		if (item && (item.options.responseFraming !== 'spr' || isLegacyStatusReply)) this.resolveItem(item, data)
		this.emit('legacyResponse', data)
	}

	private handleSPRMessage(data: Buffer): void {
		const response = parseSPR(data)
		if (!response) return
		const item = this.activeCommand
		if (item?.options.responseFraming === 'spr') {
			const expected = item.options.expectedSprCommand
			if (expected === undefined || response.command === expected) {
				this.resolveItem(item, data)
			}
		}
		// Do publish valid SPRs for state consumers, but never let an unexpected
		// command id resolve the request currently in flight.
		this.emit('sprResponse', response)
	}

	private async processQueue(): Promise<void> {
		if (this.activeCommand || this.commandQueue.length === 0) return
		const socket = this.socket
		if (!socket?.isConnected) {
			this.rejectAll(new Error('Not connected to Newton device'))
			return
		}

		const item = this.commandQueue.shift()!
		this.activeCommand = item
		try {
			this.accumulator.setResponseFraming(item.options.responseFraming, item.options.expectedLength)
		} catch (err) {
			this.rejectItem(item, toError(err))
			return
		}
		item.timer = setTimeout(() => this.handleTimeout(item), item.options.timeoutMs)

		try {
			this.emit('rawData', 'TX', item.cmd)
			const sent = await socket.send(item.cmd)
			if (this.activeCommand !== item || this.socket !== socket) return
			if (!sent) this.rejectItem(item, new Error(`${item.options.name} failed to send`))
		} catch (err) {
			if (this.activeCommand === item && this.socket === socket) this.rejectItem(item, toError(err))
		}
	}

	private handleTimeout(item: PendingCommand<unknown>): void {
		if (this.activeCommand !== item) return
		const error = new Error(`${item.options.name} timeout after ${item.options.timeoutMs}ms`)
		this.clearItemTimer(item)
		this.activeCommand = null
		this.accumulator.reset()
		this.emit('commandError', item.options.name, error)
		item.reject(error)

		// Legacy replies have no request ID. Destroying the connection is the only
		// reliable way to establish that a later reply belongs to a later command.
		const queued = this.commandQueue.splice(0)
		for (const pending of queued) pending.reject(error)
		const socket = this.socket
		this.socket = null
		socket?.destroy()
		// A pulled cable produces no TCP FIN/RST: the timeout IS the detection.
		// Tell consumers the link is gone so status/feedbacks flip immediately,
		// then rebuild the socket, which keeps retrying until the device is back.
		this.emit('disconnected')
		this.connect()
	}

	private resolveItem(item: PendingCommand<unknown>, data: Buffer): void {
		if (this.activeCommand !== item) return
		this.clearItemTimer(item)
		this.activeCommand = null

		const success = this.evaluateSuccess(item, data)
		const parsed = this.parseResult(item, data)
		const error = this.describeResultError(item, data, success, parsed)
		const result: NewtonCommandResult<unknown> = {
			name: item.options.name,
			tx: item.cmd,
			rx: data,
			success: success && !error,
			parsed,
			error,
		}
		item.resolve(result)
		this.emit('commandResult', result)
		void this.processQueue()
	}

	private evaluateSuccess(item: PendingCommand<unknown>, data: Buffer): boolean {
		if (item.options.isSuccess) return item.options.isSuccess(data)
		if (item.options.responseFraming === 'spr') return parseSPR(data)?.success ?? false
		return data.length >= 2 && data[0] === 0x33 && data[1] === 0x00
	}

	private parseResult(item: PendingCommand<unknown>, data: Buffer): unknown | null {
		return item.options.parser ? item.options.parser(data) : data
	}

	private describeResultError(
		item: PendingCommand<unknown>,
		data: Buffer,
		success: boolean,
		parsed: unknown | null,
	): string | undefined {
		if (item.options.expectedLength > 0 && data.length !== item.options.expectedLength) {
			return `${item.options.name} expected ${item.options.expectedLength} bytes, got ${data.length}`
		}
		if (!success) return `${item.options.name} device returned error response`
		if (item.options.parser && parsed === null) return `${item.options.name} parser returned null`
		return undefined
	}

	private rejectItem(item: PendingCommand<unknown>, error: Error): void {
		if (this.activeCommand !== item) return
		this.clearItemTimer(item)
		this.activeCommand = null
		this.emit('commandError', item.options.name, error)
		item.reject(error)
		void this.processQueue()
	}

	private rejectAll(error: Error): void {
		const queued = this.commandQueue.splice(0)
		for (const item of queued) {
			this.clearItemTimer(item)
			item.reject(error)
		}
		const active = this.activeCommand
		if (active) this.rejectItem(active, error)
	}

	private clearItemTimer(item: PendingCommand<unknown>): void {
		if (item.timer) {
			clearTimeout(item.timer)
			item.timer = null
		}
	}
}

function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error))
}
