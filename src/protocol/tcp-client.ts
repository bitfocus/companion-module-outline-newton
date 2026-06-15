import { TCPHelper, InstanceStatus } from '@companion-module/base'
import { EventEmitter } from 'events'
import { PORT_TCP } from './constants.js'
import { MessageAccumulator, parseSPR } from './command-parser.js'
import type { SPRResponse } from './types.js'

const COMMAND_TIMEOUT_MS = 5000
const RECONNECT_INTERVAL_MS = 10000

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
	expectedLength?: number
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

interface PendingCommand<TParsed = Buffer> {
	cmd: Buffer
	options: Required<Omit<SendCommandExpectOptions<TParsed>, 'parser' | 'isSuccess'>> &
		Pick<SendCommandExpectOptions<TParsed>, 'parser' | 'isSuccess'>
	resolve: (result: NewtonCommandResult<TParsed>) => void
	reject: (err: Error) => void
	timer: ReturnType<typeof setTimeout> | null
}

/**
 * TCP client wrapper for Newton device communication.
 * Handles connection management, message framing, and command queuing.
 */
export class NewtonTcpClient extends EventEmitter<NewtonTcpClientEvents> {
	private socket: TCPHelper | null = null
	private accumulator: MessageAccumulator
	private host: string
	private port: number

	// Newton legacy replies do not include a request id. Serializing commands
	// keeps each incoming response associated with exactly one action/poll.
	private commandQueue: PendingCommand<unknown>[] = []
	private activeCommand: PendingCommand<unknown> | null = null

	constructor(host: string, port: number = PORT_TCP) {
		super()
		this.host = host
		this.port = port

		this.accumulator = new MessageAccumulator(
			(data) => this.handleLegacyMessage(data),
			(data) => this.handleSPRMessage(data),
		)
	}

	/**
	 * Connect to the Newton device.
	 */
	connect(): void {
		this.destroy()
		this.accumulator.reset()

		this.socket = new TCPHelper(this.host, this.port, {
			reconnect_interval: RECONNECT_INTERVAL_MS,
		})

		this.socket.on('connect', () => {
			this.emit('connected')
		})

		this.socket.on('data', (data: Buffer) => {
			this.emit('rawData', 'RX', data)
			this.accumulator.feed(data)
		})

		this.socket.on('error', (err: Error) => {
			this.rejectAll(err)
			this.emit('error', err)
		})

		this.socket.on('end', () => {
			this.rejectAll(new Error('Connection closed'))
			this.emit('disconnected')
		})

		this.socket.on('status_change', (status, message) => {
			this.emit('statusChange', status, message)
		})
	}

	/**
	 * Update connection target and reconnect.
	 */
	reconnect(host: string, port: number = PORT_TCP): void {
		this.host = host
		this.port = port
		this.connect()
	}

	/**
	 * Send a raw buffer command and return the raw response.
	 * Serializes commands: only one in-flight at a time.
	 */
	async sendCommand(cmd: Buffer): Promise<Buffer> {
		const result = await this.sendCommandExpect(cmd)
		return result.rx
	}

	async sendCommandExpect<TParsed = Buffer>(
		cmd: Buffer,
		options: SendCommandExpectOptions<TParsed> = {},
	): Promise<NewtonCommandResult<TParsed>> {
		if (!this.socket || !this.socket.isConnected) {
			throw new Error('Not connected to Newton device')
		}

		const fullOptions: PendingCommand<TParsed>['options'] = {
			name: options.name ?? `0x${(cmd[0] ?? 0).toString(16).padStart(2, '0')}`,
			timeoutMs: options.timeoutMs ?? COMMAND_TIMEOUT_MS,
			expectedLength: options.expectedLength ?? 0,
			isSuccess: options.isSuccess,
			parser: options.parser,
		}

		return new Promise<NewtonCommandResult<TParsed>>((resolve, reject) => {
			this.commandQueue.push({
				cmd,
				options: fullOptions,
				resolve,
				reject,
				timer: null,
			} as PendingCommand<unknown>)
			void this.processQueue()
		})
	}

	/**
	 * Send a command without waiting for a response (fire-and-forget).
	 */
	sendCommandNoWait(cmd: Buffer): void {
		if (!this.socket || !this.socket.isConnected) {
			return
		}
		this.emit('rawData', 'TX', cmd)
		void this.socket.send(cmd)
	}

	/**
	 * Check if currently connected.
	 */
	get isConnected(): boolean {
		return this.socket?.isConnected ?? false
	}

	/**
	 * Destroy the connection and clean up.
	 */
	destroy(): void {
		this.rejectAll(new Error('Client destroyed'))
		this.accumulator.reset()

		if (this.socket) {
			this.socket.destroy()
			this.socket = null
		}
	}

	private handleLegacyMessage(data: Buffer): void {
		this.resolveActive(data)
		this.emit('legacyResponse', data)
	}

	private handleSPRMessage(data: Buffer): void {
		const response = parseSPR(data)
		if (response) {
			// Only a CRC-valid SPR can resolve the active command. Invalid or partial
			// frames are ignored by the parser and will eventually time out.
			this.resolveActive(data)
			this.emit('sprResponse', response)
		}
	}

	private async processQueue(): Promise<void> {
		if (this.activeCommand || this.commandQueue.length === 0) return
		if (!this.socket || !this.socket.isConnected) {
			this.rejectAll(new Error('Not connected to Newton device'))
			return
		}

		const item = this.commandQueue.shift()!
		this.activeCommand = item
		item.timer = setTimeout(() => {
			this.rejectActive(new Error(`${item.options.name} timeout after ${item.options.timeoutMs}ms`))
		}, item.options.timeoutMs)

		try {
			this.emit('rawData', 'TX', item.cmd)
			const sent = await this.socket.send(item.cmd)
			if (!sent) this.rejectActive(new Error(`${item.options.name} failed to send`))
		} catch (err) {
			this.rejectActive(err instanceof Error ? err : new Error(String(err)))
		}
	}

	private resolveActive(data: Buffer): void {
		const item = this.activeCommand
		if (!item) return

		this.clearActiveTimer()
		this.activeCommand = null

		const success = this.evaluateSuccess(item, data)
		const parsed = this.parseResult(item, data)
		const error = this.describeResultError(item, data, success, parsed)
		// A command is successful only when the protocol status is OK and the
		// optional parser/length checks agree with the expected response shape.
		item.resolve({
			name: item.options.name,
			tx: item.cmd,
			rx: data,
			success: success && !error,
			parsed,
			error,
		})
		this.emit('commandResult', {
			name: item.options.name,
			tx: item.cmd,
			rx: data,
			success: success && !error,
			parsed,
			error,
		})
		void this.processQueue()
	}

	private evaluateSuccess(item: PendingCommand<unknown>, data: Buffer): boolean {
		if (item.options.isSuccess) return item.options.isSuccess(data)
		if (data[0] === 0xf1) return parseSPR(data)?.success ?? false
		return data.length >= 2 && data[0] === 0x33 && data[1] === 0x00
	}

	private parseResult(item: PendingCommand<unknown>, data: Buffer): unknown | null {
		if (!item.options.parser) return data
		return item.options.parser(data)
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

	private rejectActive(error: Error): void {
		const item = this.activeCommand
		if (!item) return
		this.clearActiveTimer()
		this.activeCommand = null
		this.emit('commandError', item.options.name, error)
		item.reject(error)
		void this.processQueue()
	}

	private rejectAll(error: Error): void {
		this.rejectActive(error)
		for (const item of this.commandQueue.splice(0)) {
			if (item.timer) clearTimeout(item.timer)
			item.reject(error)
		}
	}

	private clearActiveTimer(): void {
		if (this.activeCommand?.timer) {
			clearTimeout(this.activeCommand.timer)
			this.activeCommand.timer = null
		}
	}
}
