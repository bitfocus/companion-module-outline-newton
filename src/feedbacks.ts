import { combineRgb, type CompanionFeedbackDefinitions } from '@companion-module/base'
import { ChannelType } from './protocol/constants.js'
import type { NewtonState } from './protocol/types.js'

export function getFeedbackDefinitions(getState: () => NewtonState): CompanionFeedbackDefinitions {
	return {
		mute_active: {
			type: 'boolean',
			name: 'Mute Active',
			description: 'Indicates when the device mute is active',
			defaultStyle: {
				bgcolor: combineRgb(255, 0, 0),
				color: combineRgb(255, 255, 255),
			},
			options: [],
			callback: () => {
				return getState().muteActive
			},
		},
		preset_active: {
			type: 'boolean',
			name: 'Preset Active',
			description: 'Indicates when a specific preset is active',
			defaultStyle: {
				bgcolor: combineRgb(0, 128, 0),
				color: combineRgb(255, 255, 255),
			},
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
			callback: (feedback) => {
				return getState().currentPreset === feedback.options['preset']
			},
		},
		connection_status: {
			type: 'boolean',
			name: 'Device Connected',
			description: 'Indicates when the device is connected',
			defaultStyle: {
				bgcolor: combineRgb(0, 128, 0),
				color: combineRgb(255, 255, 255),
			},
			options: [],
			callback: () => {
				return getState().connected
			},
		},
		priority_active_source: {
			type: 'boolean',
			name: 'Priority Patch - Active Source Equals',
			description:
				'True when the priority patch for the chosen channel is currently routed to the chosen source channel. Useful to highlight the active source on a button.',
			defaultStyle: {
				bgcolor: combineRgb(0, 128, 0),
				color: combineRgb(255, 255, 255),
			},
			options: [
				{
					type: 'dropdown',
					label: 'Channel Type',
					id: 'channelType',
					default: ChannelType.InputDsp,
					choices: [
						{ id: ChannelType.InputDsp, label: 'Input DSP' },
						{ id: ChannelType.AuxMixer, label: 'Aux Mixer' },
					],
				},
				{
					type: 'number',
					label: 'Patch Index',
					id: 'patchIndex',
					default: 0,
					min: 0,
					max: 15,
				},
				{
					type: 'number',
					label: 'Expected Source Channel',
					id: 'expectedSource',
					default: 0,
					min: 0,
					max: 255,
				},
			],
			callback: (feedback) => {
				const s = getState()
				const channelType = Number(feedback.options['channelType'])
				const idx = Number(feedback.options['patchIndex'])
				const expected = Number(feedback.options['expectedSource'])
				const arr = channelType === Number(ChannelType.AuxMixer) ? s.priorityAuxMixer : s.priorityInputDsp
				return arr[idx] === expected
			},
		},
		priority_overridden: {
			type: 'boolean',
			name: 'Priority Patch - Source Differs From Highest',
			description:
				'True when the active source for a priority patch is NOT the highest-priority source (i.e. backup or manual override is in effect). Highlight to remind operator to rearm.',
			defaultStyle: {
				bgcolor: combineRgb(200, 100, 0),
				color: combineRgb(255, 255, 255),
			},
			options: [
				{
					type: 'dropdown',
					label: 'Channel Type',
					id: 'channelType',
					default: ChannelType.InputDsp,
					choices: [
						{ id: ChannelType.InputDsp, label: 'Input DSP' },
						{ id: ChannelType.AuxMixer, label: 'Aux Mixer' },
					],
				},
				{
					type: 'number',
					label: 'Patch Index',
					id: 'patchIndex',
					default: 0,
					min: 0,
					max: 15,
				},
				{
					type: 'number',
					label: 'Highest Priority Source (the one expected when healthy)',
					id: 'highestSource',
					default: 0,
					min: 0,
					max: 255,
				},
			],
			callback: (feedback) => {
				const s = getState()
				const channelType = Number(feedback.options['channelType'])
				const idx = Number(feedback.options['patchIndex'])
				const expected = Number(feedback.options['highestSource'])
				const arr = channelType === Number(ChannelType.AuxMixer) ? s.priorityAuxMixer : s.priorityInputDsp
				const cur = arr[idx]
				return cur !== undefined && cur >= 0 && cur !== expected
			},
		},
		priority_backup_active: {
			type: 'boolean',
			name: 'Priority Patch - Backup Active',
			description: 'True when configured monitored priority patch is not on its expected highest source.',
			defaultStyle: {
				bgcolor: combineRgb(200, 100, 0),
				color: combineRgb(255, 255, 255),
			},
			options: [],
			callback: () => {
				const s = getState()
				const current = s.prioritySelectedActive
				const highest = s.prioritySelectedList?.sources[0]
				return current >= 0 && highest !== undefined && current !== highest
			},
		},
		priority_manual_forced: {
			type: 'boolean',
			name: 'Priority Patch - Manual Forced',
			description: 'True when the selected priority list reports manual/forced mode.',
			defaultStyle: {
				bgcolor: combineRgb(120, 70, 180),
				color: combineRgb(255, 255, 255),
			},
			options: [],
			callback: () => {
				return getState().prioritySelectedList?.isForced ?? false
			},
		},
	}
}
