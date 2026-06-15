import { Regex, type SomeCompanionConfigField } from '@companion-module/base'
import { ChannelType, PORT_METERS, PORT_TCP } from './protocol/constants.js'

export interface ModuleConfig {
	host: string
	port: number
	pollInterval: number
	commandTimeoutMs: number
	debugLevel: 'off' | 'errors' | 'verbose'
	enableVu: boolean
	vuPort: number
	vuMonitorChannelType: ChannelType
	vuMonitorChannelIndex: number
	enablePriorityPolling: boolean
	priorityPollInterval: number
	priorityMonitorChannelType: ChannelType
	priorityMonitorChannelIndex: number
	priorityMonitorHighestSource: number
}

export const DEFAULT_CONFIG: ModuleConfig = {
	host: '',
	port: PORT_TCP,
	pollInterval: 5000,
	commandTimeoutMs: 5000,
	debugLevel: 'errors',
	enableVu: false,
	vuPort: PORT_METERS,
	vuMonitorChannelType: ChannelType.InputDsp,
	vuMonitorChannelIndex: 0,
	enablePriorityPolling: true,
	priorityPollInterval: 1000,
	priorityMonitorChannelType: ChannelType.InputDsp,
	priorityMonitorChannelIndex: 0,
	priorityMonitorHighestSource: 0,
}

export function getConfigFields(): SomeCompanionConfigField[] {
	return [
		{
			type: 'textinput',
			id: 'host',
			label: 'Device IP Address',
			width: 8,
			regex: Regex.IP,
			required: true,
		},
		{
			type: 'number',
			id: 'port',
			label: 'TCP Port',
			width: 4,
			min: 1,
			max: 65535,
			default: PORT_TCP,
		},
		{
			type: 'number',
			id: 'pollInterval',
			label: 'Status Poll Interval (ms)',
			width: 4,
			min: 500,
			max: 30000,
			default: 5000,
		},
		{
			type: 'number',
			id: 'commandTimeoutMs',
			label: 'Command Timeout (ms)',
			width: 4,
			min: 500,
			max: 30000,
			default: 5000,
		},
		{
			type: 'dropdown',
			id: 'debugLevel',
			label: 'Debug Logging',
			width: 4,
			default: 'errors',
			choices: [
				{ id: 'off', label: 'Off' },
				{ id: 'errors', label: 'Errors only' },
				{ id: 'verbose', label: 'Verbose hex' },
			],
		},
		{
			type: 'checkbox',
			id: 'enablePriorityPolling',
			label: 'Enable Priority Patch Polling',
			width: 6,
			default: true,
		},
		{
			type: 'number',
			id: 'priorityPollInterval',
			label: 'Priority Poll Interval (ms)',
			width: 6,
			min: 200,
			max: 10000,
			default: 1000,
		},
		{
			type: 'dropdown',
			id: 'priorityMonitorChannelType',
			label: 'Priority Monitor Type',
			width: 4,
			default: ChannelType.InputDsp,
			choices: [
				{ id: ChannelType.InputDsp, label: 'Input DSP' },
				{ id: ChannelType.AuxMixer, label: 'Aux Mixer' },
			],
		},
		{
			type: 'number',
			id: 'priorityMonitorChannelIndex',
			label: 'Priority Monitor Index',
			width: 4,
			min: 0,
			max: 15,
			default: 0,
		},
		{
			type: 'number',
			id: 'priorityMonitorHighestSource',
			label: 'Priority Expected Highest Source',
			width: 4,
			min: 0,
			max: 255,
			default: 0,
		},
		{
			type: 'checkbox',
			id: 'enableVu',
			label: 'Enable VU Meter Listener (UDP 6667)',
			width: 4,
			default: false,
		},
		{
			type: 'number',
			id: 'vuPort',
			label: 'VU Local UDP Port',
			width: 4,
			min: 1,
			max: 65535,
			default: PORT_METERS,
		},
		{
			type: 'dropdown',
			id: 'vuMonitorChannelType',
			label: 'VU Monitor Type',
			width: 4,
			default: ChannelType.InputDsp,
			choices: [
				{ id: ChannelType.InputDsp, label: 'Input DSP' },
				{ id: ChannelType.OutputDsp, label: 'Output DSP' },
			],
		},
		{
			type: 'number',
			id: 'vuMonitorChannelIndex',
			label: 'VU Monitor Index',
			width: 4,
			min: 0,
			max: 15,
			default: 0,
		},
	]
}
