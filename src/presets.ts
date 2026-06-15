import { combineRgb, type CompanionPresetDefinitions } from '@companion-module/base'

export function getPresetDefinitions(): CompanionPresetDefinitions {
	const presets: CompanionPresetDefinitions = {}

	// ===== Mute / Unmute (Input DSP Ch0) =====
	presets['mute_on'] = {
		type: 'button',
		category: 'Mute',
		name: 'Mute Input Ch0',
		style: {
			text: 'MUTE\\nIN 0',
			size: '14',
			color: combineRgb(255, 255, 255),
			bgcolor: combineRgb(255, 0, 0),
		},
		steps: [
			{
				down: [{ actionId: 'set_mute', options: { channelType: 0, channelIndex: 0, gainDb: 0, mute: 1 } }],
				up: [],
			},
		],
		feedbacks: [],
	}

	presets['mute_off'] = {
		type: 'button',
		category: 'Mute',
		name: 'Unmute Input Ch0',
		style: {
			text: 'UNMUTE\\nIN 0',
			size: '14',
			color: combineRgb(255, 255, 255),
			bgcolor: combineRgb(0, 100, 0),
		},
		steps: [
			{
				down: [{ actionId: 'set_mute', options: { channelType: 0, channelIndex: 0, gainDb: 0, mute: 0 } }],
				up: [],
			},
		],
		feedbacks: [],
	}

	// ===== Preset Recall Buttons (0-7) =====
	for (let i = 0; i < 8; i++) {
		presets[`preset_${i}`] = {
			type: 'button',
			category: 'Presets',
			name: `Preset ${i}`,
			style: {
				text: `PRESET\\n${i}`,
				size: '14',
				color: combineRgb(255, 255, 255),
				bgcolor: combineRgb(0, 0, 100),
			},
			steps: [
				{
					down: [{ actionId: 'change_preset', options: { preset: i } }],
					up: [],
				},
			],
			feedbacks: [
				{
					feedbackId: 'preset_active',
					options: { preset: i },
					style: {
						bgcolor: combineRgb(0, 128, 0),
						color: combineRgb(255, 255, 255),
					},
				},
			],
		}
	}

	// ===== Connection Status =====
	presets['connection'] = {
		type: 'button',
		category: 'Status',
		name: 'Connection Status',
		style: {
			text: '$(outline-newton:connection_state)',
			size: '14',
			color: combineRgb(255, 255, 255),
			bgcolor: combineRgb(100, 0, 0),
		},
		steps: [
			{
				down: [],
				up: [],
			},
		],
		feedbacks: [
			{
				feedbackId: 'connection_status',
				options: {},
				style: {
					bgcolor: combineRgb(0, 128, 0),
					color: combineRgb(255, 255, 255),
				},
			},
		],
	}

	// ===== Priority Patch Operator Buttons =====
	for (let i = 0; i < 16; i++) {
		presets[`priority_input_${i}_status`] = {
			type: 'button',
			category: 'Priority Patch',
			name: `Input Priority ${i} Status`,
			style: {
				text: `IN PRI ${i}\\n$(outline-newton:priority_in_${i})`,
				size: '14',
				color: combineRgb(255, 255, 255),
				bgcolor: combineRgb(40, 40, 40),
			},
			steps: [{ down: [], up: [] }],
			feedbacks: [
				{
					feedbackId: 'priority_overridden',
					options: { channelType: 0, patchIndex: i, highestSource: i },
					style: {
						bgcolor: combineRgb(200, 100, 0),
						color: combineRgb(255, 255, 255),
					},
				},
			],
		}

		presets[`priority_input_${i}_rearm`] = {
			type: 'button',
			category: 'Priority Patch',
			name: `Rearm Input Priority ${i}`,
			style: {
				text: `REARM\\nIN PRI ${i}`,
				size: '14',
				color: combineRgb(255, 255, 255),
				bgcolor: combineRgb(90, 60, 0),
			},
			steps: [
				{
					down: [{ actionId: 'rearm_priority', options: { channelType: 0, channelIndex: i } }],
					up: [],
				},
			],
			feedbacks: [],
		}
	}

	for (let i = 0; i < 8; i++) {
		presets[`priority_aux_${i}_status`] = {
			type: 'button',
			category: 'Priority Patch',
			name: `Aux Priority ${i} Status`,
			style: {
				text: `AUX PRI ${i}\\n$(outline-newton:priority_aux_${i})`,
				size: '14',
				color: combineRgb(255, 255, 255),
				bgcolor: combineRgb(40, 40, 40),
			},
			steps: [{ down: [], up: [] }],
			feedbacks: [
				{
					feedbackId: 'priority_overridden',
					options: { channelType: 6, patchIndex: i, highestSource: i },
					style: {
						bgcolor: combineRgb(200, 100, 0),
						color: combineRgb(255, 255, 255),
					},
				},
			],
		}

		presets[`priority_aux_${i}_rearm`] = {
			type: 'button',
			category: 'Priority Patch',
			name: `Rearm Aux Priority ${i}`,
			style: {
				text: `REARM\\nAUX PRI ${i}`,
				size: '14',
				color: combineRgb(255, 255, 255),
				bgcolor: combineRgb(90, 60, 0),
			},
			steps: [
				{
					down: [{ actionId: 'rearm_priority', options: { channelType: 6, channelIndex: i } }],
					up: [],
				},
			],
			feedbacks: [],
		}
	}

	presets['selected_priority_status'] = {
		type: 'button',
		category: 'Priority Patch',
		name: 'Selected Priority Status',
		style: {
			text: 'PRI SEL\\n$(outline-newton:priority_selected_active)',
			size: '14',
			color: combineRgb(255, 255, 255),
			bgcolor: combineRgb(40, 40, 40),
		},
		steps: [{ down: [], up: [] }],
		feedbacks: [
			{
				feedbackId: 'priority_backup_active',
				options: {},
				style: {
					bgcolor: combineRgb(200, 100, 0),
					color: combineRgb(255, 255, 255),
				},
			},
			{
				feedbackId: 'priority_manual_forced',
				options: {},
				style: {
					bgcolor: combineRgb(120, 70, 180),
					color: combineRgb(255, 255, 255),
				},
			},
		],
	}

	return presets
}
