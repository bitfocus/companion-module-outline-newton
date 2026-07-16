import { combineRgb, type CompanionPresetDefinitions } from '@companion-module/base'
import { UI } from './style.js'

export function getPresetDefinitions(): CompanionPresetDefinitions {
	const presets: CompanionPresetDefinitions = {}

	// ===== Connection Status =====
	// The advanced feedback colors the button itself (green connected / red
	// not connected): no layered style overrides to configure.
	presets['connection'] = {
		type: 'button',
		category: 'Status',
		name: 'Connection Status',
		style: {
			text: '$(outline-newton:connection_state)',
			size: '14',
			color: combineRgb(255, 255, 255),
			bgcolor: UI.bgNeutral,
		},
		steps: [
			{
				down: [],
				up: [],
			},
		],
		feedbacks: [
			{
				feedbackId: 'connection_monitor',
				options: {},
			},
		],
	}

	// ===== Input patch (Hardware-to-Logic priority) =====
	// One template button per function. The monitor feedback takes a single
	// input number (1-16) and drives everything itself: it replaces the
	// '#channel' placeholder text with "IN <n>" and colors the button from the
	// device state (0x2B active source vs 0x91 channel list).
	presets['priority_input_monitor'] = {
		type: 'button',
		category: 'Input patch',
		name: 'Monitor Input',
		style: {
			text: 'IN\\n#channel',
			size: '14',
			color: combineRgb(255, 255, 255),
			bgcolor: UI.bgNeutral,
		},
		steps: [{ down: [], up: [] }],
		feedbacks: [
			{
				feedbackId: 'input_patch_monitor',
				options: { patchIndex: 1 },
			},
		],
	}

	// The rearm label feedback carries the single input number: it writes
	// "REARM IN <n>" on the button and feeds the 'rearm_this_input' action.
	presets['priority_input_rearm'] = {
		type: 'button',
		category: 'Input patch',
		name: 'Rearm Input',
		style: {
			text: 'REARM\\n#channel',
			size: '14',
			color: combineRgb(255, 255, 255),
			bgcolor: UI.blue,
		},
		steps: [
			{
				down: [{ actionId: 'rearm_this_input', options: {} }],
				up: [],
			},
		],
		feedbacks: [
			{
				feedbackId: 'input_patch_rearm_label',
				options: { patchIndex: 1 },
			},
		],
	}

	// ===== Clock =====
	// Same pattern as Input patch: the monitor feedback and the rearm label
	// feedback each take one clock selection (Master / WC Out 1 / WC Out 2)
	// and drive the whole button, label included.
	presets['clock_monitor'] = {
		type: 'button',
		category: 'Clock',
		name: 'Monitor Clock',
		style: {
			text: 'CLOCK',
			size: '14',
			color: combineRgb(255, 255, 255),
			bgcolor: UI.bgNeutral,
		},
		steps: [{ down: [], up: [] }],
		feedbacks: [
			{
				feedbackId: 'clock_monitor',
				options: { clockType: 0 },
			},
		],
	}

	presets['clock_rearm'] = {
		type: 'button',
		category: 'Clock',
		name: 'Rearm Clock',
		style: {
			text: 'REARM\\nCLOCK',
			size: '14',
			color: combineRgb(255, 255, 255),
			bgcolor: UI.blue,
		},
		steps: [
			{
				down: [{ actionId: 'rearm_this_clock', options: {} }],
				up: [],
			},
		],
		feedbacks: [
			{
				feedbackId: 'clock_rearm_label',
				options: { clockType: 0 },
			},
		],
	}

	// ===== Levels & Mute =====
	// Each button monitors one channel: set the channel type and number in the
	// feedback options. The gain button shows the live dB value; the mute button
	// turns red when muted, green when open. Their state comes from preset audio.
	presets['channel_gain'] = {
		type: 'button',
		category: 'Levels & Mute',
		name: 'Channel Gain',
		style: {
			text: 'GAIN\\n#channel',
			size: 'auto',
			color: combineRgb(255, 255, 255),
			bgcolor: UI.bgNeutral,
		},
		steps: [{ down: [], up: [] }],
		feedbacks: [
			{
				feedbackId: 'channel_gain',
				options: { channelType: 0, channel: 1 },
			},
		],
	}

	// Level trim buttons: pick channel type, channel and the dB step in the
	// action options. Every press reads the device's current 0x21 state first,
	// so they work without a separate gain feedback and preserve live mute.
	presets['level_up'] = {
		type: 'button',
		category: 'Levels & Mute',
		name: 'Level Up',
		style: {
			text: 'LEVEL\\n+',
			size: '18',
			color: combineRgb(255, 255, 255),
			bgcolor: UI.bgPanel,
		},
		steps: [
			{
				down: [{ actionId: 'adjust_gain', options: { channelType: 0, channel: 1, direction: 'up', deltaDb: 1 } }],
				up: [],
			},
		],
		feedbacks: [],
	}

	presets['level_down'] = {
		type: 'button',
		category: 'Levels & Mute',
		name: 'Level Down',
		style: {
			text: 'LEVEL\\n-',
			size: '18',
			color: combineRgb(255, 255, 255),
			bgcolor: UI.bgPanel,
		},
		steps: [
			{
				down: [{ actionId: 'adjust_gain', options: { channelType: 0, channel: 1, direction: 'down', deltaDb: 1 } }],
				up: [],
			},
		],
		feedbacks: [],
	}

	// Mute key: one pair of options (type + channel) in the feedback drives the
	// state color AND tells the press action which channel to toggle.
	presets['channel_mute'] = {
		type: 'button',
		category: 'Levels & Mute',
		name: 'Channel Mute',
		style: {
			text: 'TOGGLE MUTE\\n#channel',
			size: 'auto',
			color: combineRgb(255, 255, 255),
			bgcolor: UI.bgNeutral,
		},
		steps: [
			{
				down: [{ actionId: 'mute_this_channel', options: { mode: 'toggle' } }],
				up: [],
			},
		],
		feedbacks: [
			{
				feedbackId: 'channel_mute',
				options: { channelType: 0, channel: 1 },
			},
		],
	}

	// ===== Snapshots =====
	// The label feedback carries the snapshot selection (by name, read live
	// from the device database): it writes the snapshot name on the button and
	// feeds the 'apply_this_snapshot' action.
	presets['snapshot_apply'] = {
		type: 'button',
		category: 'Snapshots',
		name: 'Apply Snapshot',
		style: {
			text: 'APPLY\\n#snapshot',
			size: 'auto',
			color: combineRgb(255, 255, 255),
			bgcolor: UI.indigo,
		},
		steps: [
			{
				down: [{ actionId: 'apply_this_snapshot', options: { fadingTime: 2000, mode: 'Direct' } }],
				up: [],
			},
		],
		feedbacks: [
			{
				feedbackId: 'snapshot_apply_label',
				options: { uuid: '' },
			},
		],
	}

	// ===== Metering =====
	// The meter feedback draws the whole button: black background with the
	// red/orange/green/blue gradient revealed by the live level.
	presets['meter'] = {
		type: 'button',
		category: 'Metering',
		name: 'Meter',
		style: {
			text: '',
			size: '14',
			color: combineRgb(255, 255, 255),
			bgcolor: combineRgb(0, 0, 0),
			// The drawn VU meter uses the full button height.
			show_topbar: false,
		},
		steps: [{ down: [], up: [] }],
		feedbacks: [
			{
				feedbackId: 'meter',
				options: { meterType: 0, meterMode: 'rms', channel: 1 },
			},
		],
	}

	presets['priority_rearm_all'] = {
		type: 'button',
		category: 'Input patch',
		name: 'Rearm All Inputs',
		style: {
			text: 'REARM\\nALL',
			size: '14',
			color: combineRgb(255, 255, 255),
			bgcolor: UI.blue,
		},
		steps: [
			{
				down: [{ actionId: 'rearm_all_inputs', options: {} }],
				up: [],
			},
		],
		feedbacks: [],
	}

	return presets
}
