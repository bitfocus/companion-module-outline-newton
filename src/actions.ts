import type { CompanionActionDefinitions, InstanceBase } from '@companion-module/base'
import { presetAudioReadOptions } from './preset-audio.js'
import {
	ChannelType,
	ClockType,
	GAIN_MAX_DB,
	GAIN_MIN_DB,
	MIN_SNAPSHOT_FIRMWARE,
	SnapshotApplyMode,
	clampGainDb,
} from './protocol/constants.js'
import {
	buildGainCommand,
	buildGetClockCommand,
	buildImportAudioPresetCommand,
	buildReadPriorityListCommand,
	buildRearmClockCommand,
	buildRearmPriorityCommand,
	buildSnapshotApply,
	buildSnapshotGetDatabase,
} from './protocol/command-builder.js'
import { parseClockStateResponse, parsePriorityListResponse } from './protocol/command-parser.js'
import { findSnapshot, snapshotPlaceholderLabel } from './snapshots.js'
import type { NewtonActionResult } from './protocol/types.js'
import type { SendCommandExpectOptions } from './protocol/tcp-client.js'
import type { ClockPriorityState, GainReadState, PriorityListState, SnapshotInfo } from './protocol/types.js'
import type { NewtonActionClient } from './action-client.js'

type Logger = Pick<InstanceBase<never>, 'log'> & {
	reportActionResult?: (result: NewtonActionResult) => void
	/** Fresh confirmed state after a write: refreshes matching gain/mute buttons at once. */
	reportGainRead?: (channelType: number, channelIndex: number, state: GainReadState) => void
}

// Action feedback variables are IPC-visible strings. Never turn a large SPR
// payload (for example a snapshot database) into an unbounded hex variable.
const MAX_ACTION_RESPONSE_HEX_BYTES = 128

function formatActionResponseHex(data: Buffer): string {
	if (data.length <= MAX_ACTION_RESPONSE_HEX_BYTES) return data.toString('hex')
	return `${data.subarray(0, MAX_ACTION_RESPONSE_HEX_BYTES).toString('hex')}… (${data.length} bytes total)`
}

function reportActionFailure(logger: Logger, name: string, error: string, controlId?: string): void {
	logger.log('error', `${name}: ${error}`)
	logger.reportActionResult?.({ name, success: false, responseHex: '', error, controlId })
}

const CHANNEL_TYPE_CHOICES = [
	{ id: ChannelType.InputDsp, label: 'Input DSP' },
	{ id: ChannelType.OutputDsp, label: 'Output DSP' },
	{ id: ChannelType.AuxMixer, label: 'Aux Mixer' },
	{ id: ChannelType.MatrixMixer, label: 'Matrix Mixer' },
	{ id: ChannelType.Trimmer, label: 'Trimmer' },
	{ id: ChannelType.OutputGroup, label: 'Output Group' },
]

const VALID_CHANNEL_TYPES = new Set<number>([
	Number(ChannelType.InputDsp),
	Number(ChannelType.OutputDsp),
	Number(ChannelType.AuxMixer),
	Number(ChannelType.MatrixMixer),
	Number(ChannelType.Trimmer),
	Number(ChannelType.OutputGroup),
])

/** Number of addressable channels in each documented Gain command bank. */
const CHANNEL_TYPE_CHANNEL_COUNTS: Readonly<Record<ChannelType, number>> = {
	[ChannelType.InputDsp]: 16,
	[ChannelType.OutputDsp]: 16,
	[ChannelType.AuxMixer]: 10,
	[ChannelType.MatrixMixer]: 288,
	[ChannelType.Trimmer]: 64,
	[ChannelType.OutputGroup]: 64,
}

function channelCountForType(channelType: ChannelType): number {
	return CHANNEL_TYPE_CHANNEL_COUNTS[channelType]
}

function isGainReadChannelType(channelType: number): channelType is ChannelType.InputDsp | ChannelType.OutputDsp {
	return channelType === Number(ChannelType.InputDsp) || channelType === Number(ChannelType.OutputDsp)
}

async function runCommand(
	client: NewtonActionClient,
	logger: Logger,
	name: string,
	cmd: Buffer,
	controlId?: string,
	options: SendCommandExpectOptions = {},
): Promise<boolean> {
	// Keep action callbacks thin: command builders own wire layout, while the
	// TCP client owns queuing, timeout handling, response parsing, and logging.
	try {
		const result = await client.sendCommandExpect(cmd, { name, ...options })
		logger.reportActionResult?.({
			name,
			success: result.success,
			responseHex: formatActionResponseHex(result.rx),
			error: result.error,
			controlId,
		})
		if (!result.success) logger.log('warn', `${name}: ${result.error ?? 'device returned an error'}`)
		return result.success
	} catch (err) {
		const error = err instanceof Error ? err.message : String(err)
		reportActionFailure(logger, name, error, controlId)
		return false
	}
}

async function buildAndRunCommand(
	client: NewtonActionClient,
	logger: Logger,
	name: string,
	build: () => Buffer,
	controlId?: string,
	options: SendCommandExpectOptions = {},
): Promise<boolean> {
	try {
		return await runCommand(client, logger, name, build(), controlId, options)
	} catch (err) {
		const error = err instanceof Error ? err.message : String(err)
		reportActionFailure(logger, name, error, controlId)
		return false
	}
}

function validChannelType(value: unknown, logger: Logger, actionName: string, controlId?: string): ChannelType | null {
	const channelType = Number(value)
	if (!Number.isInteger(channelType) || !VALID_CHANNEL_TYPES.has(channelType)) {
		reportActionFailure(logger, actionName, `unsupported channel type ${String(value)}`, controlId)
		return null
	}
	return channelType
}

function validSnapshotApplyMode(
	value: unknown,
	logger: Logger,
	actionName: string,
	controlId?: string,
): SnapshotApplyMode | null {
	if (value === SnapshotApplyMode.Direct || value === SnapshotApplyMode.ThroughZero) return value
	reportActionFailure(logger, actionName, 'transition mode must be Direct or Through Zero', controlId)
	return null
}

async function readPriorityList(
	client: NewtonActionClient,
	logger: Logger,
	channelIndex: number,
	controlId?: string,
): Promise<PriorityListState | null> {
	const cmd = buildReadPriorityListCommand(channelIndex)
	try {
		const result = await client.sendCommandExpect(cmd, {
			name: 'Read Priority List',
			expectedLength: 6,
			isSuccess: (data) => data.length === 6,
			parser: parsePriorityListResponse,
		})
		if (result.success && result.parsed) {
			logger.reportActionResult?.({
				name: 'Read Priority List',
				success: true,
				responseHex: formatActionResponseHex(result.rx),
				controlId,
			})
			return result.parsed
		}
		const error = result.error ?? 'invalid response'
		logger.reportActionResult?.({
			name: 'Read Priority List',
			success: false,
			responseHex: formatActionResponseHex(result.rx),
			error,
			controlId,
		})
		logger.log('warn', `Read Priority List: ${error}`)
	} catch (err) {
		const error = err instanceof Error ? err.message : String(err)
		reportActionFailure(logger, 'Read Priority List', error, controlId)
	}
	return null
}

/**
 * Provider retained for the module wiring and feedback cache. Read-modify-write
 * actions deliberately do not use it: they obtain a fresh 0x21 state first.
 */
export type GainReadProvider = (channelType: number, channelIndex: number) => GainReadState | undefined

/**
 * Read one Input/Output gain state from the full 0x21 audio-preset response.
 * Newton firmware 0.98 rejects Get Gain (0x01), so this is the only reliable
 * read before a gain/mute read-modify-write operation.
 */
async function readFreshGainState(
	client: NewtonActionClient,
	logger: Logger,
	name: string,
	channelType: ChannelType.InputDsp | ChannelType.OutputDsp,
	channelIndex: number,
): Promise<GainReadState | null> {
	try {
		const result = await client.sendCommandExpect(buildImportAudioPresetCommand(), presetAudioReadOptions())
		if (!result.success || !result.parsed) {
			logger.log(
				'warn',
				`${name}: unable to read current gain/mute: ${result.error ?? 'invalid audio preset response'}`,
			)
			return null
		}
		const current =
			channelType === ChannelType.InputDsp
				? result.parsed.inputDsp[channelIndex]
				: result.parsed.outputDsp[channelIndex]
		if (!current) {
			logger.log('warn', `${name}: requested channel has no valid gain/mute state in the audio preset`)
			return null
		}
		logger.reportGainRead?.(channelType, channelIndex, current)
		return current
	} catch (err) {
		logger.log('warn', `${name}: unable to read current gain/mute: ${err instanceof Error ? err.message : String(err)}`)
		return null
	}
}

/** Read the current list, then rearm the patch from slot 0, preserving state. */
async function rearmInput(
	client: NewtonActionClient,
	logger: Logger,
	name: string,
	channelIndex: number,
	controlId?: string,
): Promise<void> {
	const priority = await readPriorityList(client, logger, channelIndex, controlId)
	if (!priority) {
		reportActionFailure(logger, name, 'cancelled because the current priority list could not be read', controlId)
		return
	}
	await buildAndRunCommand(client, logger, name, () => buildRearmPriorityCommand(channelIndex, priority, 0), controlId)
}

/** Read the current clock settings (0x81), then rearm from slot 0 (0x80). */
async function rearmClock(
	client: NewtonActionClient,
	logger: Logger,
	name: string,
	clockType: ClockType,
	controlId?: string,
): Promise<void> {
	let clock: ClockPriorityState | null = null
	try {
		const result = await client.sendCommandExpect(buildGetClockCommand(clockType), {
			name: 'Get Processing Clock',
			expectedLength: 19,
			isSuccess: (data) => data.length === 19,
			parser: parseClockStateResponse,
		})
		if (result.success && result.parsed) clock = result.parsed
	} catch (err) {
		reportActionFailure(logger, 'Get Processing Clock', err instanceof Error ? err.message : String(err), controlId)
	}
	if (!clock) {
		reportActionFailure(logger, name, 'cancelled because the current clock settings could not be read', controlId)
		return
	}
	await buildAndRunCommand(client, logger, name, () => buildRearmClockCommand(clockType, clock, 0), controlId)
}

export function getActionDefinitions(
	client: NewtonActionClient,
	logger: Logger,
	// controlId -> input number registered by the rearm label feedback.
	rearmTargets: Map<string, number> = new Map(),
	// controlId -> clock type registered by the clock rearm label feedback.
	clockRearmTargets: Map<string, number> = new Map(),
	// Snapshot database entries read from the device; the definitions are
	// re-registered whenever this list changes so the dropdown stays current.
	snapshotList: SnapshotInfo[] = [],
	// controlId -> snapshot uuid registered by the snapshot label feedback.
	snapshotTargets: Map<string, string> = new Map(),
	// controlId -> channel registered by the channel-mute feedback.
	muteTargets: Map<string, { channelType: number; channelIndex: number }> = new Map(),
	// Retained for the module wiring and feedback cache. Gain mutations always
	// issue a fresh 0x21 read instead of using this potentially stale cache.
	_getGainRead: GainReadProvider = () => undefined,
	// True when the connected firmware predates snapshots (< 0.98); the
	// snapshot actions then fail fast with a clear message.
	snapshotsUnsupported: () => boolean = () => false,
	// Distinguishes a successfully read empty database from one not read yet.
	snapshotDatabaseLoaded: () => boolean = () => false,
	// Kept by main across definition refreshes so a configuration/UI refresh
	// cannot split two read-modify-write operations for the same channel.
	gainMutationQueues: Map<string, Promise<void>> = new Map(),
): CompanionActionDefinitions {
	const snapshotChoices = [
		{
			id: '',
			label: snapshotPlaceholderLabel(snapshotList.length, snapshotsUnsupported(), snapshotDatabaseLoaded()),
		},
		...snapshotList.map((snapshot) => ({ id: snapshot.uuid, label: snapshot.name })),
	]

	// 0x21 is a read-modify-write prerequisite. Serialise the whole transaction
	// per channel, not merely the TCP frames: otherwise two quick presses could
	// both read the same old value and one increment/toggle would be lost.
	const enqueueGainOperation = async (
		channelType: ChannelType,
		channelIndex: number,
		operation: () => Promise<void>,
	): Promise<void> => {
		const key = `${channelType}:${channelIndex}`
		const previous = gainMutationQueues.get(key) ?? Promise.resolve()
		const queued = previous.catch(() => undefined).then(operation)
		gainMutationQueues.set(key, queued)
		void queued.then(
			() => {
				if (gainMutationQueues.get(key) === queued) gainMutationQueues.delete(key)
			},
			() => {
				if (gainMutationQueues.get(key) === queued) gainMutationQueues.delete(key)
			},
		)
		await queued
	}

	const mutateFreshGain = async (
		name: string,
		channelType: ChannelType.InputDsp | ChannelType.OutputDsp,
		channelIndex: number,
		controlId: string | undefined,
		mutation: (current: GainReadState) => Promise<void>,
	): Promise<void> => {
		await enqueueGainOperation(channelType, channelIndex, async () => {
			const current = await readFreshGainState(client, logger, name, channelType, channelIndex)
			if (!current) {
				reportActionFailure(logger, name, 'unable to read current gain/mute from Newton; no change was sent', controlId)
				return
			}
			await mutation(current)
		})
	}

	const mutateChannelMute = async (
		name: string,
		channelType: ChannelType.InputDsp | ChannelType.OutputDsp,
		channelIndex: number,
		mode: 'mute' | 'unmute' | 'toggle',
		controlId?: string,
	): Promise<void> => {
		await mutateFreshGain(name, channelType, channelIndex, controlId, async (current) => {
			const mute = mode === 'toggle' ? !current.muted : mode === 'mute'
			// The device value can be outside the safe write window. Never echo it
			// back unchecked merely because the operation only changes mute.
			const gainDb = clampGainDb(current.gainDb)
			const written = await buildAndRunCommand(
				client,
				logger,
				name,
				() => buildGainCommand({ channelType, channelIndex, gainDb, mute }),
				controlId,
			)
			if (written) logger.reportGainRead?.(channelType, channelIndex, { gainDb, muted: mute })
		})
	}
	return {
		legacy_unsafe_action: {
			name: 'Blocked legacy Newton action',
			description: 'This saved action is no longer supported and was disabled during an update.',
			options: [
				{
					type: 'textinput',
					label: 'Reason',
					id: 'reason',
					default: '',
				},
			],
			callback: async (action) => {
				reportActionFailure(
					logger,
					'Blocked legacy Newton action',
					String(action.options['reason'] ?? 'review and recreate it'),
					action.controlId,
				)
			},
		},

		// ===== Gain =====
		set_gain: {
			name: 'Set Gain and Mute State',
			description:
				"Set a channel's gain and mute state together. Channel ranges: Input/Output 1-16, Aux 1-10, Matrix 1-288, Trimmer/Output Group 1-64.",
			options: [
				{
					type: 'dropdown',
					label: 'Channel Type',
					id: 'channelType',
					default: ChannelType.InputDsp,
					choices: CHANNEL_TYPE_CHOICES,
				},
				{
					type: 'number',
					label: 'Channel (1-based; range depends on type)',
					id: 'channelIndex',
					default: 1,
					min: 1,
					max: 288,
				},
				{
					type: 'number',
					label: 'Gain (dB)',
					id: 'gainDb',
					default: 0,
					min: GAIN_MIN_DB,
					max: GAIN_MAX_DB,
					step: 0.1,
				},
				{
					type: 'checkbox',
					label: 'Mute',
					id: 'mute',
					default: false,
				},
			],
			callback: async (action) => {
				const channelType = validChannelType(action.options['channelType'], logger, 'Set Gain', action.controlId)
				if (channelType === null) return
				const channel = Number(action.options['channelIndex'])
				const channelCount = channelCountForType(channelType)
				if (!Number.isInteger(channel) || channel < 1 || channel > channelCount) {
					reportActionFailure(
						logger,
						'Set Gain',
						`channel must be between 1 and ${channelCount} for the selected channel type`,
						action.controlId,
					)
					return
				}
				const gainDb = action.options['gainDb']
				if (typeof gainDb !== 'number' || !Number.isFinite(gainDb)) {
					reportActionFailure(logger, 'Set Gain', 'gain must be a finite number', action.controlId)
					return
				}
				const mute = action.options['mute']
				if (typeof mute !== 'boolean') {
					reportActionFailure(logger, 'Set Gain', 'mute must be a boolean value', action.controlId)
					return
				}
				const params = {
					channelType,
					// Operators enter 1-based channels; Newton addresses them from 0.
					channelIndex: channel - 1,
					// The UI enforces min/max, but trigger expressions can inject any
					// number: clamp to the device-safe window before building.
					gainDb: clampGainDb(gainDb),
					mute,
				}
				await enqueueGainOperation(channelType, params.channelIndex, async () => {
					const written = await buildAndRunCommand(
						client,
						logger,
						'Set Gain',
						() => buildGainCommand(params),
						action.controlId,
					)
					if (written && isGainReadChannelType(channelType)) {
						logger.reportGainRead?.(channelType, params.channelIndex, { gainDb: params.gainDb, muted: params.mute })
					}
				})
			},
		},

		// ===== Snapshot database refresh =====
		snapshot_get_database: {
			name: 'Refresh Snapshot Database',
			description:
				'Read the current snapshot list from Newton again. Use this after snapshots are changed outside Companion.',
			options: [],
			callback: async (action) => {
				if (snapshotsUnsupported()) {
					reportActionFailure(
						logger,
						'Refresh Snapshot Database',
						`snapshots require Newton firmware ${MIN_SNAPSHOT_FIRMWARE} or later`,
						action.controlId,
					)
					return
				}
				await runCommand(client, logger, 'Refresh Snapshot Database', buildSnapshotGetDatabase(), action.controlId)
			},
		},

		// ===== Snapshot Apply (by name) =====
		snapshot_apply_selected: {
			name: 'Snapshot Apply (by name)',
			description: 'Apply a snapshot chosen by name. The list is read from the device when the module connects.',
			options: [
				{
					type: 'dropdown',
					label: 'Snapshot',
					id: 'uuid',
					default: '',
					choices: snapshotChoices,
				},
				{
					type: 'number',
					label: 'Fading Time (ms)',
					id: 'fadingTime',
					default: 2000,
					min: 0,
					max: 65535,
				},
				{
					type: 'dropdown',
					label: 'Transition Mode',
					id: 'mode',
					default: SnapshotApplyMode.Direct,
					choices: [
						{ id: SnapshotApplyMode.Direct, label: 'Direct' },
						{ id: SnapshotApplyMode.ThroughZero, label: 'Through Zero' },
					],
				},
			],
			callback: async (action) => {
				if (snapshotsUnsupported()) {
					reportActionFailure(
						logger,
						'Snapshot Apply (by name)',
						`snapshots require Newton firmware ${MIN_SNAPSHOT_FIRMWARE} or later`,
						action.controlId,
					)
					return
				}
				const uuid = String(action.options['uuid'] ?? '').trim()
				if (!uuid) {
					reportActionFailure(
						logger,
						'Snapshot Apply (by name)',
						'no snapshot selected; read the device database first',
						action.controlId,
					)
					return
				}
				if (!snapshotDatabaseLoaded()) {
					reportActionFailure(
						logger,
						'Snapshot Apply (by name)',
						'the snapshot database has not been read from the device yet; retry in a moment',
						action.controlId,
					)
					return
				}
				if (!findSnapshot(snapshotList, uuid)) {
					reportActionFailure(
						logger,
						'Snapshot Apply (by name)',
						'the selected snapshot no longer exists on the device; read the database again and select a current snapshot',
						action.controlId,
					)
					return
				}
				const fadingTime = Number(action.options['fadingTime'])
				if (
					!Number.isInteger(fadingTime) ||
					fadingTime < 0 ||
					fadingTime > 65535 ||
					(fadingTime > 0 && fadingTime < 2000)
				) {
					reportActionFailure(
						logger,
						'Snapshot Apply (by name)',
						'fading time must be 0 or between 2000 and 65535 ms',
						action.controlId,
					)
					return
				}
				const mode = validSnapshotApplyMode(
					action.options['mode'],
					logger,
					'Snapshot Apply (by name)',
					action.controlId,
				)
				if (mode === null) return
				await buildAndRunCommand(
					client,
					logger,
					'Snapshot Apply (by name)',
					() =>
						buildSnapshotApply({
							uuid,
							fadingTime,
							mode,
						}),
					action.controlId,
				)
			},
		},

		// ===== Snapshot Apply (from the button's label feedback) =====
		apply_this_snapshot: {
			name: 'Apply This Button Snapshot',
			description: "Applies the snapshot chosen in this button's Snapshot label feedback.",
			options: [
				{
					type: 'number',
					label: 'Fading Time (ms)',
					id: 'fadingTime',
					default: 2000,
					min: 0,
					max: 65535,
				},
				{
					type: 'dropdown',
					label: 'Transition Mode',
					id: 'mode',
					default: SnapshotApplyMode.Direct,
					choices: [
						{ id: SnapshotApplyMode.Direct, label: 'Direct' },
						{ id: SnapshotApplyMode.ThroughZero, label: 'Through Zero' },
					],
				},
			],
			callback: async (action) => {
				if (snapshotsUnsupported()) {
					reportActionFailure(
						logger,
						'Apply This Button Snapshot',
						`snapshots require Newton firmware ${MIN_SNAPSHOT_FIRMWARE} or later`,
						action.controlId,
					)
					return
				}
				const uuid = snapshotTargets.get(action.controlId)
				if (!uuid) {
					reportActionFailure(
						logger,
						'Apply This Button Snapshot',
						'add the "Snapshot - Apply Button Label" feedback to this button and select the snapshot',
						action.controlId,
					)
					return
				}
				if (!snapshotDatabaseLoaded()) {
					reportActionFailure(
						logger,
						'Apply This Button Snapshot',
						'the snapshot database has not been read from the device yet; retry in a moment',
						action.controlId,
					)
					return
				}
				if (!findSnapshot(snapshotList, uuid)) {
					snapshotTargets.delete(action.controlId)
					reportActionFailure(
						logger,
						'Apply This Button Snapshot',
						'the selected snapshot no longer exists on the device; select it again in the Snapshot label feedback',
						action.controlId,
					)
					return
				}
				const fadingTime = Number(action.options['fadingTime'])
				if (
					!Number.isInteger(fadingTime) ||
					fadingTime < 0 ||
					fadingTime > 65535 ||
					(fadingTime > 0 && fadingTime < 2000)
				) {
					reportActionFailure(
						logger,
						'Apply This Button Snapshot',
						'fading time must be 0 or between 2000 and 65535 ms',
						action.controlId,
					)
					return
				}
				const mode = validSnapshotApplyMode(
					action.options['mode'],
					logger,
					'Apply This Button Snapshot',
					action.controlId,
				)
				if (mode === null) return
				await buildAndRunCommand(
					client,
					logger,
					'Apply This Button Snapshot',
					() =>
						buildSnapshotApply({
							uuid,
							fadingTime,
							mode,
						}),
					action.controlId,
				)
			},
		},

		// ===== Hardware-to-Logic priority (Input DSP only) =====
		read_priority_list: {
			name: 'Read Priority List',
			description: 'Read the priority source list of one input (1-16).',
			options: [
				{
					type: 'number',
					label: 'Input (1-16)',
					id: 'channelIndex',
					default: 1,
					min: 1,
					max: 16,
				},
			],
			callback: async (action) => {
				// Operators enter inputs 1-16; the protocol addresses channels 0-15.
				const input = Number(action.options['channelIndex'])
				if (!Number.isInteger(input) || input < 1 || input > 16) {
					reportActionFailure(logger, 'Read Priority List', 'input must be between 1 and 16', action.controlId)
					return
				}
				await readPriorityList(client, logger, input - 1, action.controlId)
			},
		},

		rearm_priority: {
			name: 'Rearm Priority Patch',
			description:
				'Rearm one input (1-16) so its highest-priority source takes over again, keeping the current source list.',
			options: [
				{
					type: 'number',
					label: 'Input (1-16)',
					id: 'channelIndex',
					default: 1,
					min: 1,
					max: 16,
				},
			],
			callback: async (action) => {
				// Operators enter inputs 1-16; the protocol addresses channels 0-15.
				const input = Number(action.options['channelIndex'])
				if (!Number.isInteger(input) || input < 1 || input > 16) {
					reportActionFailure(logger, 'Rearm Priority Patch', 'input must be between 1 and 16', action.controlId)
					return
				}
				await rearmInput(client, logger, 'Rearm Priority Patch', input - 1, action.controlId)
			},
		},

		rearm_this_input: {
			name: 'Rearm This Button Input',
			description: "Rearms the input chosen in this button's Rearm label feedback.",
			options: [],
			callback: async (action) => {
				const input = rearmTargets.get(action.controlId)
				if (!input) {
					reportActionFailure(
						logger,
						'Rearm This Button Input',
						'add the "Input Patch - Rearm Button Label" feedback to this button and set the input number',
						action.controlId,
					)
					return
				}
				await rearmInput(client, logger, 'Rearm This Button Input', input - 1, action.controlId)
			},
		},

		// ===== Level Up / Down =====
		adjust_gain: {
			name: 'Level Up / Down',
			description:
				"Raise or lower a channel's gain by a chosen dB amount, keeping its mute state. Limited to -80…+6 dB.",
			options: [
				{
					type: 'dropdown',
					label: 'Channel Type',
					id: 'channelType',
					default: ChannelType.InputDsp,
					choices: [
						{ id: ChannelType.InputDsp, label: 'Input DSP' },
						{ id: ChannelType.OutputDsp, label: 'Output DSP' },
					],
				},
				{
					type: 'number',
					label: 'Channel (1-16)',
					id: 'channel',
					default: 1,
					min: 1,
					max: 16,
				},
				{
					type: 'dropdown',
					label: 'Direction',
					id: 'direction',
					default: 'up',
					choices: [
						{ id: 'up', label: 'Up (+)' },
						{ id: 'down', label: 'Down (-)' },
					],
				},
				{
					type: 'number',
					label: 'Amount (dB)',
					id: 'deltaDb',
					default: 1,
					min: 0.1,
					max: 24,
					step: 0.1,
				},
			],
			callback: async (action) => {
				const name = 'Level Up / Down'
				const channelType = Number(action.options['channelType'])
				if (!isGainReadChannelType(channelType)) {
					reportActionFailure(logger, name, 'channel type must be Input DSP or Output DSP', action.controlId)
					return
				}
				// Operators enter channels 1-16; the protocol addresses 0-15.
				const channel = Number(action.options['channel'])
				if (!Number.isInteger(channel) || channel < 1 || channel > 16) {
					reportActionFailure(logger, name, 'channel must be between 1 and 16', action.controlId)
					return
				}
				const deltaDb = Number(action.options['deltaDb'])
				if (!Number.isFinite(deltaDb) || deltaDb <= 0 || deltaDb > 24) {
					reportActionFailure(logger, name, 'amount must be between 0.1 and 24 dB', action.controlId)
					return
				}
				const direction = action.options['direction']
				if (direction !== 'up' && direction !== 'down') {
					reportActionFailure(logger, name, 'direction must be Up or Down', action.controlId)
					return
				}
				const channelIndex = channel - 1
				const signed = direction === 'down' ? -deltaDb : deltaDb
				await mutateFreshGain(name, channelType, channelIndex, action.controlId, async (current) => {
					const gainDb = clampGainDb(current.gainDb + signed)
					const written = await buildAndRunCommand(
						client,
						logger,
						name,
						() => buildGainCommand({ channelType, channelIndex, gainDb, mute: current.muted }),
						action.controlId,
					)
					if (written) logger.reportGainRead?.(channelType, channelIndex, { gainDb, muted: current.muted })
				})
			},
		},

		set_channel_mute: {
			name: 'Channel Mute (set/toggle)',
			description: 'Mute, unmute or toggle a channel, keeping its gain.',
			options: [
				{
					type: 'dropdown',
					label: 'Channel Type',
					id: 'channelType',
					default: ChannelType.InputDsp,
					choices: [
						{ id: ChannelType.InputDsp, label: 'Input DSP' },
						{ id: ChannelType.OutputDsp, label: 'Output DSP' },
					],
				},
				{
					type: 'number',
					label: 'Channel (1-16)',
					id: 'channel',
					default: 1,
					min: 1,
					max: 16,
				},
				{
					type: 'dropdown',
					label: 'Mode',
					id: 'mode',
					default: 'toggle',
					choices: [
						{ id: 'toggle', label: 'Toggle' },
						{ id: 'mute', label: 'Mute' },
						{ id: 'unmute', label: 'Unmute' },
					],
				},
			],
			callback: async (action) => {
				const name = 'Channel Mute (set/toggle)'
				const channelType = Number(action.options['channelType'])
				if (!isGainReadChannelType(channelType)) {
					reportActionFailure(logger, name, 'channel type must be Input DSP or Output DSP', action.controlId)
					return
				}
				// Operators enter channels 1-16; the protocol addresses 0-15.
				const channel = Number(action.options['channel'])
				if (!Number.isInteger(channel) || channel < 1 || channel > 16) {
					reportActionFailure(logger, name, 'channel must be between 1 and 16', action.controlId)
					return
				}
				const mode = String(action.options['mode'])
				if (mode !== 'toggle' && mode !== 'mute' && mode !== 'unmute') {
					reportActionFailure(logger, name, 'invalid mode', action.controlId)
					return
				}
				await mutateChannelMute(name, channelType, channel - 1, mode, action.controlId)
			},
		},

		mute_this_channel: {
			name: 'Mute This Button Channel',
			description: "Mutes/toggles the channel chosen in this button's Channel Mute feedback.",
			options: [
				{
					type: 'dropdown',
					label: 'Mode',
					id: 'mode',
					default: 'toggle',
					choices: [
						{ id: 'toggle', label: 'Toggle' },
						{ id: 'mute', label: 'Mute' },
						{ id: 'unmute', label: 'Unmute' },
					],
				},
			],
			callback: async (action) => {
				const name = 'Mute This Button Channel'
				const target = muteTargets.get(action.controlId)
				if (!target) {
					reportActionFailure(
						logger,
						name,
						'add the "Levels - Channel Mute" feedback to this button and set the channel',
						action.controlId,
					)
					return
				}
				const mode = String(action.options['mode'])
				if (mode !== 'toggle' && mode !== 'mute' && mode !== 'unmute') {
					reportActionFailure(logger, name, 'invalid mode', action.controlId)
					return
				}
				if (
					!isGainReadChannelType(target.channelType) ||
					!Number.isInteger(target.channelIndex) ||
					target.channelIndex < 0 ||
					target.channelIndex >= 16
				) {
					reportActionFailure(
						logger,
						name,
						'the button channel is invalid; refresh its Channel Mute feedback',
						action.controlId,
					)
					return
				}
				await mutateChannelMute(name, target.channelType, target.channelIndex, mode, action.controlId)
			},
		},

		rearm_clock: {
			name: 'Rearm Clock',
			description: 'Rearm a clock (Master or Word Clock Out) so its highest-priority source takes over again.',
			options: [
				{
					type: 'dropdown',
					label: 'Clock',
					id: 'clockType',
					default: ClockType.Master,
					choices: [
						{ id: ClockType.Master, label: 'Master Clock' },
						{ id: ClockType.WordClockOut1, label: 'Word Clock Out 1' },
						{ id: ClockType.WordClockOut2, label: 'Word Clock Out 2' },
					],
				},
			],
			callback: async (action) => {
				const clockType = Number(action.options['clockType'])
				if (!Number.isInteger(clockType) || clockType < 0 || clockType > 2) {
					reportActionFailure(logger, 'Rearm Clock', 'invalid clock type', action.controlId)
					return
				}
				await rearmClock(client, logger, 'Rearm Clock', clockType, action.controlId)
			},
		},

		rearm_this_clock: {
			name: 'Rearm This Button Clock',
			description: "Rearms the clock chosen in this button's Clock Rearm label feedback.",
			options: [],
			callback: async (action) => {
				const clockType = clockRearmTargets.get(action.controlId)
				if (clockType === undefined) {
					reportActionFailure(
						logger,
						'Rearm This Button Clock',
						'add the "Clock - Rearm Button Label" feedback to this button and select the clock',
						action.controlId,
					)
					return
				}
				await rearmClock(client, logger, 'Rearm This Button Clock', clockType, action.controlId)
			},
		},

		rearm_all_inputs: {
			name: 'Rearm All Inputs',
			description: 'Rearm all 16 inputs at once.',
			options: [],
			callback: async (action) => {
				const name = 'Rearm All Inputs'
				// Inputs are reported 1-based to operators; the protocol uses 0-15.
				const failedInputs: number[] = []
				for (let channelIndex = 0; channelIndex < 16; channelIndex++) {
					const priority = await readPriorityList(client, logger, channelIndex, action.controlId)
					if (!priority) {
						failedInputs.push(channelIndex + 1)
						continue
					}
					try {
						const result = await client.sendCommandExpect(buildRearmPriorityCommand(channelIndex, priority, 0), {
							name,
						})
						if (!result.success) failedInputs.push(channelIndex + 1)
					} catch {
						failedInputs.push(channelIndex + 1)
					}
				}
				if (failedInputs.length === 0) {
					logger.reportActionResult?.({ name, success: true, responseHex: '', controlId: action.controlId })
				} else {
					reportActionFailure(logger, name, `failed on input(s) ${failedInputs.join(', ')}`, action.controlId)
				}
			},
		},
	}
}
