import { InstanceStatus, TCPHelper } from '@companion-module/base'
import { EventEmitter } from 'events'
import { PORT_TCP, SPC_HEADER } from './constants.js'
import {
	LEGACY_HEADER_SIZE,
	MessageAccumulator,
	isLegacyAckResponse,
	parseSPR,
	type ResponseFraming,
} from './command-parser.js'
import type { SPRResponse } from './types.js'

/** Default response deadline for one command once it reaches the wire. */
const COMMAND_TIMEOUT_MS = 3000
/**
 * Limit both queued and in-flight work. Legacy replies have no request ID, so
 * accepting an unbounded stream of button presses can otherwise execute stale
 * operator actions many seconds after they were requested.
 */
const MAX_PENDING_COMMANDS = 32
const RECONNECT_INTERVAL_MS = 10000

/**
 * Rejection produced by queue governance (TTL expiry, poll eviction), not by
 * the device or the transport: the connection is healthy and a retry may
 * succeed. Consumers use isQueueRejection to keep backpressure out of
 * failure counters, "unsupported" marks and operator-facing error state.
 */
export class QueueRejectionError extends Error {
	constructor(
		message: string,
		readonly reason: 'expired' | 'evicted',
	) {
		super(message)
		this.name = 'QueueRejectionError'
	}
}

export function isQueueRejection(error: unknown): error is QueueRejectionError {
	return error instanceof QueueRejectionError
}

/**
 * Commands from an operator should not sit behind background refreshes. The
 * caller must mark recurring device reads as `poll`; unmarked commands are
 * treated as operator work for backwards-compatible safe behaviour.
 */
export type CommandPriority = 'action' | 'normal' | 'poll'

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
	/** Scheduling class. `action` jumps ahead of queued normal/poll requests. */
	priority?: CommandPriority
	/** Maximum time a command may wait before it is discarded as stale. Defaults to timeoutMs. */
	queueTtlMs?: number
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
	priority: CommandPriority
	queueTtlMs: number
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
	queueTimer: ReturnType<typeof setTimeout> | null
	queueExpiresAt: number
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
	private readonly reconnectDelayMs: number
	private commandQueue: PendingCommand<unknown>[] = []
	private activeCommand: PendingCommand<unknown> | null = null
	/** One delayed rebuild after a protocol timeout; prevents a reconnect storm. */
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null
	/** Consecutive scheduled reconnects since the last live session; drives the backoff ladder. */
	private reconnectAttempts = 0
	/** Socket currently waiting for TCPHelper's delayed reconnect after a failure. */
	private recoveringSocket: TCPHelper | null = null

	constructor(
		host: string,
		port: number = PORT_TCP,
		socketFactory: (host: string, port: number) => TCPHelper = (targetHost, targetPort) =>
			new TCPHelper(targetHost, targetPort, { reconnect_interval: RECONNECT_INTERVAL_MS }),
		reconnectDelayMs: number = RECONNECT_INTERVAL_MS,
	) {
		super()
		this.host = host
		this.port = port
		this.socketFactory = socketFactory
		this.reconnectDelayMs = reconnectDelayMs
		this.accumulator = new MessageAccumulator(
			(data) => this.handleLegacyMessage(data),
			(data) => this.handleSPRMessage(data),
		)
	}

	connect(): void {
		// destroy() also cancels any scheduled reconnect before the rebuild.
		this.destroy()
		const socket = this.socketFactory(this.host, this.port)
		this.socket = socket

		socket.on('connect', () => {
			if (this.socket !== socket) return
			this.recoveringSocket = null
			// A live session proves the device is back: restart the backoff ladder.
			this.reconnectAttempts = 0
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
			// TCPHelper schedules its configured delayed reconnect before emitting
			// this event. Invalidate our command session, but do not replace the
			// helper immediately: doing both creates a tight socket loop while an
			// offline Newton keeps refusing connections.
			this.handleSocketFailure(socket, err, undefined, false)
			this.emit('error', err)
		})
		socket.on('end', () => {
			if (this.socket !== socket) return
			// TCPHelper schedules its delayed reconnect before emitting `end`.
			this.handleSocketFailure(socket, new Error('Connection closed'), undefined, false)
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
		const expectedLength = options.expectedLength ?? (responseFraming === 'legacyFixedLength' ? LEGACY_HEADER_SIZE : 0)
		if (responseFraming === 'legacyFixedLength' && expectedLength < 1) {
			throw new Error('Legacy fixed-length commands require expectedLength')
		}
		const expectedSprCommand =
			options.expectedSprCommand ?? (isSpc && cmd.length >= 4 ? cmd.readUInt16BE(2) : undefined)
		const timeoutMs = options.timeoutMs ?? COMMAND_TIMEOUT_MS
		const queueTtlMs = options.queueTtlMs ?? timeoutMs
		if (!isValidDuration(timeoutMs)) throw new Error('Command timeout must be a positive finite number')
		if (!isValidDuration(queueTtlMs)) throw new Error('Command queue TTL must be a positive finite number')
		const priority = options.priority ?? 'action'
		if (!isCommandPriority(priority)) throw new Error(`Unsupported command priority ${String(priority)}`)
		const fullOptions: ResolvedCommandOptions<TParsed> = {
			name: options.name ?? `0x${(cmd[0] ?? 0).toString(16).padStart(2, '0')}`,
			timeoutMs,
			priority,
			queueTtlMs,
			expectedLength,
			responseFraming,
			expectedSprCommand,
			isSuccess: options.isSuccess,
			parser: options.parser,
		}

		if (this.pendingCommandCount >= MAX_PENDING_COMMANDS) {
			// A meter/status refresh must never make a real button press fail just
			// because it arrived first. Preserve the active command, but evict the
			// oldest queued poll to make room for an operator action.
			if (priority !== 'action' || !this.evictQueuedPollForAction()) {
				return Promise.reject(new Error(`Command queue is full (maximum ${MAX_PENDING_COMMANDS} pending commands)`))
			}
		}

		return new Promise<NewtonCommandResult<TParsed>>((resolve, reject) => {
			const item: PendingCommand<unknown> = {
				cmd,
				options: fullOptions,
				resolve,
				reject,
				timer: null,
				queueTimer: null,
				queueExpiresAt: Date.now() + queueTtlMs,
			} as PendingCommand<unknown>
			this.enqueue(item)
			void this.processQueue()
		})
	}

	/** Send a command which intentionally has no reply to associate. */
	sendCommandNoWait(cmd: Buffer): void {
		const socket = this.socket
		if (!socket?.isConnected) return
		this.emit('rawData', 'TX', cmd)
		const name = `0x${(cmd[0] ?? 0).toString(16).padStart(2, '0')}`
		void socket
			.send(cmd)
			.then((sent) => {
				if (!sent && this.socket === socket) {
					// A false result means the helper lost the connection between the
					// isConnected check above and its write attempt. Let its delayed
					// reconnect recover the transport, but never claim the command ran.
					this.handleSocketFailure(socket, new Error(`${name} failed to send`), name, false)
				}
			})
			.catch((err) => {
				if (this.socket === socket) this.handleSocketFailure(socket, toError(err), name)
			})
	}

	get isConnected(): boolean {
		return this.socket?.isConnected ?? false
	}

	destroy(): void {
		this.cancelScheduledReconnect()
		this.rejectAll(new Error('Client destroyed'))
		this.accumulator.reset()
		const socket = this.socket
		this.socket = null
		this.recoveringSocket = null
		socket?.destroy()
	}

	private handleLegacyMessage(data: Buffer): void {
		const item = this.activeCommand
		// Firmware without Special Protocol support (< 0.98) answers an SPC
		// request with a plain legacy [0x66, 0x00]: let that status reply resolve
		// the SPR-framed command as a device rejection rather than leaving it to
		// the timeout, which would tear down an otherwise healthy connection.
		const isLegacyStatusReply = isLegacyAckResponse(data)
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

		let item: PendingCommand<unknown> | undefined
		while (this.commandQueue.length > 0) {
			const candidate = this.commandQueue.shift()!
			this.clearQueueTimer(candidate)
			if (candidate.queueExpiresAt <= Date.now()) {
				this.rejectExpiredQueuedItem(candidate)
				continue
			}
			item = candidate
			break
		}
		if (!item) return
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
			if (!sent)
				this.handleSocketFailure(socket, new Error(`${item.options.name} failed to send`), item.options.name, false)
		} catch (err) {
			if (this.activeCommand === item && this.socket === socket) {
				this.handleSocketFailure(socket, sendFailureError(item.options.name, toError(err)), item.options.name)
			}
		}
	}

	private handleTimeout(item: PendingCommand<unknown>): void {
		if (this.activeCommand !== item) return
		// A few firmware paths reject fixed-size reads with only [0x66, 0x00].
		// It is indistinguishable from the beginning of valid raw data until the
		// response deadline, so resolve it here without tearing down the socket.
		if (this.accumulator.flushShortLegacyError()) return
		const error = new Error(`${item.options.name} timeout after ${item.options.timeoutMs}ms`)
		this.clearItemTimer(item)
		this.activeCommand = null
		this.accumulator.reset()
		this.emit('commandError', item.options.name, error)
		item.reject(error)

		// Legacy replies have no request ID. Destroying the connection is the only
		// reliable way to establish that a later reply belongs to a later command.
		this.rejectQueued(error)
		const socket = this.socket
		this.socket = null
		socket?.destroy()
		// A pulled cable produces no TCP FIN/RST: the timeout IS the detection.
		// Tell consumers the link is gone so status/feedbacks flip immediately.
		// Delay the rebuild: immediate reconnects after every short command timeout
		// create many half-closed sessions and can keep a struggling Newton busy.
		this.emit('disconnected')
		this.scheduleReconnect()
	}

	private scheduleReconnect(): void {
		if (this.reconnectTimer || this.socket) return
		// Backoff ladder max/8 → max/4 → max/2 → max, reset on a successful
		// connect: a one-off transient recovers in ~a second while a real
		// outage still cannot produce a reconnect storm.
		const step = Math.min(this.reconnectAttempts, 3)
		const delay = Math.max(1, Math.round(this.reconnectDelayMs / 2 ** (3 - step)))
		this.reconnectAttempts++
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null
			if (this.socket) return
			try {
				this.connect()
			} catch (err) {
				// A socket-factory failure must not end retrying: stay on the ladder.
				this.emit('error', toError(err))
				this.scheduleReconnect()
			}
		}, delay)
	}

	private cancelScheduledReconnect(): void {
		if (!this.reconnectTimer) return
		clearTimeout(this.reconnectTimer)
		this.reconnectTimer = null
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

	/** Insert by priority while preserving FIFO order within each priority class. */
	private enqueue(item: PendingCommand<unknown>): void {
		const insertAt = this.commandQueue.findIndex(
			(queued) => commandPriorityRank(queued.options.priority) < commandPriorityRank(item.options.priority),
		)
		if (insertAt < 0) this.commandQueue.push(item)
		else this.commandQueue.splice(insertAt, 0, item)
		item.queueTimer = setTimeout(() => this.expireQueuedItem(item), item.options.queueTtlMs)
	}

	private expireQueuedItem(item: PendingCommand<unknown>): void {
		const index = this.commandQueue.indexOf(item)
		if (index < 0) return
		this.commandQueue.splice(index, 1)
		this.clearQueueTimer(item)
		this.rejectExpiredQueuedItem(item)
	}

	/** Remove the oldest queued background poll so an operator action can enter a full queue. */
	private evictQueuedPollForAction(): boolean {
		const index = this.commandQueue.findIndex((item) => item.options.priority === 'poll')
		if (index < 0) return false
		const [item] = this.commandQueue.splice(index, 1)
		this.clearQueueTimer(item)
		const error = new QueueRejectionError(
			`${item.options.name} dropped from command queue to run an operator action`,
			'evicted',
		)
		this.emit('commandError', item.options.name, error)
		item.reject(error)
		return true
	}

	private rejectExpiredQueuedItem(item: PendingCommand<unknown>): void {
		const error = new QueueRejectionError(
			`${item.options.name} expired in command queue after ${item.options.queueTtlMs}ms`,
			'expired',
		)
		this.emit('commandError', item.options.name, error)
		item.reject(error)
	}

	/**
	 * A rejected write means the bytes may have been partially accepted. Since
	 * Newton's legacy responses have no request ID, no later command may use
	 * this session: reject all work, discard framing state and reconnect.
	 */
	private handleSocketFailure(
		socket: TCPHelper,
		error: Error,
		commandName?: string,
		reconnectImmediately: boolean = true,
	): void {
		if (this.socket !== socket) return
		if (!reconnectImmediately && this.recoveringSocket === socket) return

		const active = this.activeCommand
		if (active) {
			this.clearItemTimer(active)
			this.activeCommand = null
			this.emit('commandError', active.options.name, error)
			active.reject(error)
		} else if (commandName) {
			this.emit('commandError', commandName, error)
		}

		this.rejectQueued(error)
		this.accumulator.reset()
		if (!reconnectImmediately) {
			// TCPHelper keeps this same socket instance and retries after its
			// configured reconnect interval. Keeping the reference lets its later
			// `connect` event restore the session without an unbounded spawn loop.
			this.recoveringSocket = socket
			this.emit('disconnected')
			return
		}
		this.socket = null
		this.recoveringSocket = null
		socket.destroy()
		this.emit('disconnected')
		this.connect()
	}

	private rejectAll(error: Error): void {
		this.rejectQueued(error)
		const active = this.activeCommand
		if (active) this.rejectItem(active, error)
	}

	private rejectQueued(error: Error): void {
		const queued = this.commandQueue.splice(0)
		for (const item of queued) {
			this.clearItemTimer(item)
			this.clearQueueTimer(item)
			item.reject(error)
		}
	}

	private get pendingCommandCount(): number {
		return this.commandQueue.length + (this.activeCommand ? 1 : 0)
	}

	private clearItemTimer(item: PendingCommand<unknown>): void {
		if (item.timer) {
			clearTimeout(item.timer)
			item.timer = null
		}
	}

	private clearQueueTimer(item: PendingCommand<unknown>): void {
		if (item.queueTimer) {
			clearTimeout(item.queueTimer)
			item.queueTimer = null
		}
	}
}

function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error))
}

function sendFailureError(commandName: string, error: Error): Error {
	return new Error(`${commandName} failed to send: ${error.message}`)
}

function isValidDuration(value: number): boolean {
	return Number.isFinite(value) && value > 0
}

function isCommandPriority(value: string): value is CommandPriority {
	return value === 'action' || value === 'normal' || value === 'poll'
}

function commandPriorityRank(priority: CommandPriority): number {
	switch (priority) {
		case 'action':
			return 2
		case 'normal':
			return 1
		case 'poll':
			return 0
	}
}
