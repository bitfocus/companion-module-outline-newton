import type { CompanionActionDefinitions, InstanceBase } from '@companion-module/base'
import { ChannelType, SnapshotApplyMode, SNAPSHOT_PARTS } from './protocol/constants.js'
import {
	buildChangePresetCommand,
	buildDelayCommand,
	buildGainCommand,
	buildMatrixCommand,
	buildPanCommand,
	buildPolarityCommand,
	buildReadPriorityListCommand,
	buildRearmPriorityCommand,
	buildSnapshotApply,
	buildSnapshotDelete,
	buildSnapshotGetDatabase,
	buildSnapshotStore,
	buildStorePresetCommand,
} from './protocol/command-builder.js'
import { parsePriorityListResponse } from './protocol/command-parser.js'
import type { NewtonTcpClient } from './protocol/tcp-client.js'

type Logger = Pick<InstanceBase<never>, 'log'>

const CHANNEL_TYPE_CHOICES = [
	{ id: ChannelType.InputDsp, label: 'Input DSP' },
	{ id: ChannelType.OutputDsp, label: 'Output DSP' },
	{ id: ChannelType.InputPatch, label: 'Input Patch' },
	{ id: ChannelType.OutputPatch, label: 'Output Patch' },
	{ id: ChannelType.Group, label: 'Group' },
	{ id: ChannelType.Trimmer, label: 'Trimmer' },
	{ id: ChannelType.AuxMixer, label: 'Aux Mixer' },
	{ id: ChannelType.Matrix, label: 'Matrix' },
]

const SNAPSHOT_PART_CHOICES = Object.entries(SNAPSHOT_PARTS).map(([key, value]) => ({
	id: value,
	label: key.replace(/_/g, ' '),
}))

async function runCommand(
	client: NewtonTcpClient,
	logger: Logger,
	name: string,
	cmd: Buffer,
	options: Parameters<NewtonTcpClient['sendCommandExpect']>[1] = {},
): Promise<void> {
	// Keep action callbacks thin: command builders own wire layout, while the
	// TCP client owns queuing, timeout handling, response parsing, and logging.
	logger.log('info', `${name}: TX [${cmd.toString('hex')}]`)
	try {
		const result = await client.sendCommandExpect(cmd, { name, ...options })
		const rxHex = result.rx.toString('hex')
		if (result.success) {
			logger.log('info', `${name}: OK RX [${rxHex}]`)
		} else {
			logger.log('warn', `${name}: ERR ${result.error ?? 'unknown'} RX [${rxHex}]`)
		}
	} catch (err) {
		logger.log('error', `${name}: ${err instanceof Error ? err.message : String(err)}`)
	}
}

export function getActionDefinitions(client: NewtonTcpClient, logger: Logger): CompanionActionDefinitions {
	return {
		// ===== Gain =====
		set_gain: {
			name: 'Set Gain',
			description: 'Set gain level for a specific channel',
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
					label: 'Channel Index',
					id: 'channelIndex',
					default: 0,
					min: 0,
					max: 287,
				},
				{
					type: 'number',
					label: 'Gain (dB)',
					id: 'gainDb',
					default: 0,
					min: -100,
					max: 20,
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
				const params = {
					channelType: Number(action.options['channelType']),
					channelIndex: Number(action.options['channelIndex']),
					gainDb: Number(action.options['gainDb']),
					mute: Boolean(action.options['mute']),
				}
				const cmd = buildGainCommand(params)
				await runCommand(client, logger, 'Set Gain', cmd)
			},
		},

		// ===== Mute (via Gain command, byte 10) =====
		set_mute: {
			name: 'Set Channel Mute',
			description: 'Mute or unmute a specific channel via the Gain command',
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
					label: 'Channel Index',
					id: 'channelIndex',
					default: 0,
					min: 0,
					max: 287,
				},
				{
					type: 'number',
					label: 'Gain (dB) - current value to preserve',
					id: 'gainDb',
					default: 0,
					min: -100,
					max: 20,
					step: 0.1,
				},
				{
					type: 'dropdown',
					label: 'Mute',
					id: 'mute',
					default: 1,
					choices: [
						{ id: 1, label: 'Mute' },
						{ id: 0, label: 'Unmute' },
					],
				},
			],
			callback: async (action) => {
				// Newton's per-channel mute travels on the Gain command. The current
				// gain is therefore an explicit option so muting does not overwrite it.
				const cmd = buildGainCommand({
					channelType: Number(action.options['channelType']),
					channelIndex: Number(action.options['channelIndex']),
					gainDb: Number(action.options['gainDb']),
					mute: Number(action.options['mute']) === 1,
				})
				await runCommand(client, logger, 'Set Channel Mute', cmd)
			},
		},

		// ===== Delay =====
		set_delay: {
			name: 'Set Delay',
			description: 'Set delay for a channel',
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
					label: 'Channel Index',
					id: 'channelIndex',
					default: 0,
					min: 0,
					max: 287,
				},
				{
					type: 'number',
					label: 'Delay (ms)',
					id: 'delayMs',
					default: 0,
					min: 0,
					max: 8000,
					step: 0.01,
				},
			],
			callback: async (action) => {
				const cmd = buildDelayCommand({
					channelType: Number(action.options['channelType']),
					channelIndex: Number(action.options['channelIndex']),
					delayMs: Number(action.options['delayMs']),
				})
				await runCommand(client, logger, 'Set Delay', cmd)
			},
		},

		// ===== Change Preset =====
		change_preset: {
			name: 'Change Preset',
			description: 'Switch to a different preset',
			options: [
				{
					type: 'number',
					label: 'Preset Number',
					id: 'preset',
					default: 0,
					min: 0,
					max: 255,
				},
			],
			callback: async (action) => {
				const cmd = buildChangePresetCommand(Number(action.options['preset']))
				await runCommand(client, logger, 'Change Preset', cmd)
			},
		},

		// ===== Store Preset =====
		store_preset: {
			name: 'Store Preset',
			description: 'Save the current configuration to a preset',
			options: [
				{
					type: 'number',
					label: 'Preset Number',
					id: 'preset',
					default: 0,
					min: 0,
					max: 255,
				},
			],
			callback: async (action) => {
				const cmd = buildStorePresetCommand(Number(action.options['preset']))
				await runCommand(client, logger, 'Store Preset', cmd)
			},
		},

		// ===== Polarity =====
		set_polarity: {
			name: 'Set Polarity',
			description: 'Set channel polarity (normal or inverted)',
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
					label: 'Channel Index',
					id: 'channelIndex',
					default: 0,
					min: 0,
					max: 287,
				},
				{
					type: 'checkbox',
					label: 'Invert',
					id: 'inverted',
					default: false,
				},
			],
			callback: async (action) => {
				const cmd = buildPolarityCommand({
					channelType: Number(action.options['channelType']),
					channelIndex: Number(action.options['channelIndex']),
					inverted: Boolean(action.options['inverted']),
				})
				await runCommand(client, logger, 'Set Polarity', cmd)
			},
		},

		// ===== Pan =====
		set_pan: {
			name: 'Set Pan',
			description: 'Set pan position for a channel (-1.0 to 1.0)',
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
					label: 'Channel Index',
					id: 'channelIndex',
					default: 0,
					min: 0,
					max: 287,
				},
				{
					type: 'number',
					label: 'Pan (-1.0 to 1.0)',
					id: 'panValue',
					default: 0,
					min: -1,
					max: 1,
					step: 0.01,
				},
			],
			callback: async (action) => {
				const cmd = buildPanCommand(
					Number(action.options['channelType']),
					Number(action.options['channelIndex']),
					Number(action.options['panValue']),
				)
				await runCommand(client, logger, 'Set Pan', cmd)
			},
		},

		// ===== Matrix =====
		set_matrix: {
			name: 'Set Matrix Assignment',
			description: 'Assign an input to an output in the routing matrix',
			options: [
				{
					type: 'number',
					label: 'Output Channel',
					id: 'outputChannel',
					default: 0,
					min: 0,
					max: 15,
				},
				{
					type: 'number',
					label: 'Input Value',
					id: 'inputValue',
					default: 0,
					min: 0,
					max: 15,
				},
			],
			callback: async (action) => {
				const cmd = buildMatrixCommand({
					outputChannel: Number(action.options['outputChannel']),
					inputValue: Number(action.options['inputValue']),
				})
				await runCommand(client, logger, 'Set Matrix Assignment', cmd)
			},
		},

		// ===== Snapshot Apply =====
		snapshot_apply: {
			name: 'Snapshot Apply',
			description: 'Apply a saved snapshot with optional fading',
			options: [
				{
					type: 'textinput',
					label: 'Snapshot UUID',
					id: 'uuid',
					required: true,
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
				{
					type: 'multidropdown',
					label: 'Parts to Recall',
					id: 'parts',
					default: ['/'],
					choices: SNAPSHOT_PART_CHOICES,
				},
			],
			callback: async (action) => {
				const parts = action.options['parts'] as string[] | undefined
				// Empty selection means "device default"; otherwise send the selected
				// recall areas exactly as Special Protocol JSON expects them.
				const cmd = buildSnapshotApply({
					uuid: String(action.options['uuid']),
					fadingTime: Number(action.options['fadingTime']),
					mode: String(action.options['mode']) as SnapshotApplyMode,
					parts: parts && parts.length > 0 ? parts : undefined,
				})
				await runCommand(client, logger, 'Snapshot Apply', cmd)
			},
		},

		// ===== Snapshot Store =====
		snapshot_store: {
			name: 'Snapshot Store',
			description: 'Create a new snapshot on the device',
			options: [
				{
					type: 'textinput',
					label: 'Author',
					id: 'author',
					default: '',
				},
				{
					type: 'textinput',
					label: 'Description',
					id: 'description',
					default: '',
				},
				{
					type: 'textinput',
					label: 'Place',
					id: 'place',
					default: '',
				},
			],
			callback: async (action) => {
				const params: Record<string, unknown> = {}
				const author = String(action.options['author'] ?? '')
				const description = String(action.options['description'] ?? '')
				const place = String(action.options['place'] ?? '')
				if (author) params.author = author
				if (description) params.description = description
				if (place) params.place = place

				const cmd = buildSnapshotStore(params)
				await runCommand(client, logger, 'Snapshot Store', cmd)
			},
		},

		// ===== Snapshot Delete =====
		snapshot_delete: {
			name: 'Snapshot Delete',
			description: 'Delete a snapshot by UUID',
			options: [
				{
					type: 'textinput',
					label: 'Snapshot UUID',
					id: 'uuid',
					required: true,
				},
			],
			callback: async (action) => {
				const cmd = buildSnapshotDelete(String(action.options['uuid']))
				await runCommand(client, logger, 'Snapshot Delete', cmd)
			},
		},

		// ===== Snapshot Get Database =====
		snapshot_get_database: {
			name: 'Snapshot Get Database',
			description: 'Retrieve the full snapshot database from the device',
			options: [],
			callback: async () => {
				const cmd = buildSnapshotGetDatabase()
				await runCommand(client, logger, 'Snapshot Get Database', cmd)
			},
		},

		// ===== Rearm Priority Patch =====
		read_priority_list: {
			name: 'Read Priority List',
			description: 'Read priority source list for one Input DSP or Aux Mixer patch (0x91, optional firmware support)',
			options: [
				{
					type: 'dropdown',
					label: 'Channel Type',
					id: 'channelType',
					default: ChannelType.InputDsp,
					choices: [
						{ id: ChannelType.InputDsp, label: 'Input DSP (0..15)' },
						{ id: ChannelType.AuxMixer, label: 'Aux Mixer (0..7)' },
					],
				},
				{
					type: 'number',
					label: 'Channel Index',
					id: 'channelIndex',
					default: 0,
					min: 0,
					max: 15,
				},
			],
			callback: async (action) => {
				const channelType = Number(action.options['channelType'])
				const channelIndex = Number(action.options['channelIndex'])
				const cmd = buildReadPriorityListCommand(channelType, channelIndex)
				await runCommand(client, logger, 'Read Priority List', cmd, {
					parser: parsePriorityListResponse,
				})
			},
		},

		rearm_priority: {
			name: 'Rearm Priority Patch',
			description:
				'Force a priority patch back to automatic mode (clear manual override) so the highest-available source becomes active',
			options: [
				{
					type: 'dropdown',
					label: 'Channel Type',
					id: 'channelType',
					default: ChannelType.InputDsp,
					choices: [
						{ id: ChannelType.InputDsp, label: 'Input DSP (0..15)' },
						{ id: ChannelType.AuxMixer, label: 'Aux Mixer (0..7)' },
					],
				},
				{
					type: 'number',
					label: 'Channel Index',
					id: 'channelIndex',
					default: 0,
					min: 0,
					max: 15,
				},
			],
			callback: async (action) => {
				const channelType = Number(action.options['channelType'])
				const channelIndex = Number(action.options['channelIndex'])
				const cmd = buildRearmPriorityCommand(channelType, channelIndex)
				await runCommand(client, logger, 'Rearm Priority Patch', cmd)
			},
		},

		rearm_all_input_priority: {
			name: 'Rearm All Input DSP Priority Patches',
			description: 'Send 0x90 rearm to all 16 Input DSP priority patches',
			options: [],
			callback: async () => {
				for (let i = 0; i < 16; i++) {
					await runCommand(
						client,
						logger,
						`Rearm Input DSP Priority ${i}`,
						buildRearmPriorityCommand(ChannelType.InputDsp, i),
					)
				}
			},
		},

		rearm_all_aux_priority: {
			name: 'Rearm All Aux Mixer Priority Patches',
			description: 'Send 0x90 rearm to all 8 Aux Mixer priority patches',
			options: [],
			callback: async () => {
				for (let i = 0; i < 8; i++) {
					await runCommand(
						client,
						logger,
						`Rearm Aux Mixer Priority ${i}`,
						buildRearmPriorityCommand(ChannelType.AuxMixer, i),
					)
				}
			},
		},
	}
}
