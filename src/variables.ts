import type { CompanionVariableDefinition } from '@companion-module/base'
import { SIGNALS_AUX_MIXER_PRIORITY_COUNT, SIGNALS_INPUT_DSP_PRIORITY_COUNT } from './protocol/constants.js'

const VU_INPUT_CHANNELS = 16
const VU_OUTPUT_CHANNELS = 16

export function getVariableDefinitions(): CompanionVariableDefinition[] {
	const defs: CompanionVariableDefinition[] = [
		{ variableId: 'connection_state', name: 'Connection State' },
		{ variableId: 'current_preset', name: 'Current Preset Number' },
		{ variableId: 'device_name', name: 'Device Name/Description' },
		{ variableId: 'firmware_version', name: 'Firmware Version' },
		{ variableId: 'serial_number', name: 'Serial Number' },
		{ variableId: 'mute_state', name: 'Mute State (on/off)' },
		{ variableId: 'last_error', name: 'Last Error' },
		{ variableId: 'last_command', name: 'Last Command' },
		{ variableId: 'last_response_hex', name: 'Last Response Hex' },
		{ variableId: 'last_priority_update', name: 'Last Priority Update' },
		{ variableId: 'last_vu_update', name: 'Last VU Update' },
		{ variableId: 'snapshot_count', name: 'Snapshot Count' },
		{ variableId: 'last_snapshot_response', name: 'Last Snapshot Response' },
		{ variableId: 'last_applied_snapshot', name: 'Last Applied Snapshot' },
		{ variableId: 'priority_selected_active', name: 'Selected Priority Patch - Active Source' },
		{ variableId: 'priority_selected_highest', name: 'Selected Priority Patch - Highest Source' },
		{ variableId: 'priority_selected_forced', name: 'Selected Priority Patch - Forced Mode' },
		{ variableId: 'priority_selected_forced_channel', name: 'Selected Priority Patch - Forced Channel' },
		{ variableId: 'priority_selected_overridden', name: 'Selected Priority Patch - Overridden' },
		{ variableId: 'priority_read_list_status', name: 'Priority Read List Status' },
		{ variableId: 'vu_selected', name: 'Selected VU Level' },
		{ variableId: 'vu_selected_peak', name: 'Selected VU Peak' },
		{ variableId: 'vu_selected_clip', name: 'Selected VU Clip' },
		{ variableId: 'vu_raw_length', name: 'VU Raw Packet Length' },
		{ variableId: 'vu_raw_first_hex', name: 'VU Raw First Bytes' },
		{ variableId: 'vu_format', name: 'VU Format Status' },
	]

	// Priority patch state (current active source channel for each patch).
	for (let i = 0; i < SIGNALS_INPUT_DSP_PRIORITY_COUNT; i++) {
		defs.push({
			variableId: `priority_in_${i}`,
			name: `Priority Patch InputDsp ${i} - Active Source`,
		})
	}
	for (let i = 0; i < SIGNALS_AUX_MIXER_PRIORITY_COUNT; i++) {
		defs.push({
			variableId: `priority_aux_${i}`,
			name: `Priority Patch AuxMixer ${i} - Active Source`,
		})
	}

	// VU meter levels (one variable per channel).
	for (let i = 0; i < VU_INPUT_CHANNELS; i++) {
		defs.push({ variableId: `vu_in_${i}`, name: `VU Input DSP ${i}` })
	}
	for (let i = 0; i < VU_OUTPUT_CHANNELS; i++) {
		defs.push({ variableId: `vu_out_${i}`, name: `VU Output DSP ${i}` })
	}

	return defs
}
