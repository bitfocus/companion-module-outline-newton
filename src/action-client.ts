import type { NewtonCommandResult, SendCommandExpectOptions } from './protocol/tcp-client.js'

/**
 * The small transport surface used by Companion action callbacks.
 *
 * Keeping this separate from the full TCP client makes the lifetime rule
 * explicit: action definitions capture one Newton session when registered.
 */
export interface NewtonActionClient {
	sendCommandExpect<TParsed = Buffer>(
		cmd: Buffer,
		options?: SendCommandExpectOptions<TParsed>,
	): Promise<NewtonCommandResult<TParsed>>
}

/**
 * Bind an action definition to the supplied TCP session.
 *
 * Do not resolve the instance's current client at send time. A multi-step
 * action may otherwise read device A, the configuration may switch to device
 * B, and its later write could reach B. Re-registering definitions after a
 * target change gives new actions a new bound client; old ones can only fail
 * against their destroyed session.
 */
export function bindActionClient(
	client: NewtonActionClient | null,
	commandTimeoutMs: number,
	queueTtlMs: number = commandTimeoutMs,
): NewtonActionClient {
	return {
		async sendCommandExpect<TParsed = Buffer>(
			cmd: Buffer,
			options: SendCommandExpectOptions<TParsed> = {},
		): Promise<NewtonCommandResult<TParsed>> {
			if (!client) throw new Error('Not connected to Newton device')
			return client.sendCommandExpect(cmd, { timeoutMs: commandTimeoutMs, queueTtlMs, ...options })
		},
	}
}
