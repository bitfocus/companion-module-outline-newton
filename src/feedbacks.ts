import { combineRgb, type CompanionFeedbackDefinitions, type CompanionInputFieldDropdown } from '@companion-module/base'
import { CLOCK_SOURCE_NAMES, ChannelType, ClockType, MIN_SNAPSHOT_FIRMWARE } from './protocol/constants.js'
import { findSnapshot, snapshotPlaceholderLabel } from './snapshots.js'
import { UI } from './style.js'
import type { NewtonState, SnapshotInfo } from './protocol/types.js'

/**
 * One outcome resolution for both status feedbacks so they can never
 * disagree. Scope 'this' (the default): only the button's own action result
 * counts — pressing elsewhere leaves this lamp untouched. Scope 'global':
 * the module-wide last action, which is what configurations saved before
 * the scope option existed rely on (an upgrade script marks them 'global').
 */
function resolveLastActionOutcome(
	feedback: { controlId?: string; options: { [key: string]: unknown } },
	state: NewtonState,
): { status: string; name: string } {
	const scope = feedback.options['scope'] === 'global' ? 'global' : 'this'
	if (scope === 'this' && feedback.controlId) {
		const result = state.lastActionResults?.get(feedback.controlId)
		if (result) return { status: result.success ? 'success' : 'error', name: result.name }
		return { status: 'unknown', name: '' }
	}
	return { status: state.lastActionStatus, name: state.lastActionName }
}

const LAST_ACTION_SCOPE_OPTION: CompanionInputFieldDropdown = {
	type: 'dropdown',
	label: 'Watch',
	id: 'scope',
	default: 'this',
	choices: [
		{ id: 'this', label: 'Actions on this button' },
		{ id: 'global', label: 'Any action (module-wide)' },
	],
}

// Short operator-facing labels per clock type (Master, WC Out 1, WC Out 2).
const CLOCK_TYPE_LABELS = ['MCLK', 'WCK 1', 'WCK 2'] as const

const CLOCK_TYPE_CHOICES = [
	{ id: ClockType.Master, label: 'Master Clock' },
	{ id: ClockType.WordClockOut1, label: 'Word Clock Out 1' },
	{ id: ClockType.WordClockOut2, label: 'Word Clock Out 2' },
]

function clockSourceName(value: number | undefined): string {
	if (value === undefined || value < 0) return '--'
	return CLOCK_SOURCE_NAMES[value] ?? `CLK ${value}`
}

// Meter bands: below -60 dB everything is dark; from -60 to -40 only the
// blue "signal" LED is lit; from -40 dB up the gradient bar lights
// proportionally. Warning/alarm follow the Newton panel LED thresholds
// (0xAA defaults: warning -12 dB, alarm -6 dB).
const SIGNAL_FLOOR_DB = -60
const METER_BAR_FLOOR_DB = -40
const METER_WARNING_DB = -12
const METER_ALARM_DB = -6
// Height of the binary blue "signal" strip at the bottom of the bar.
const SIGNAL_STRIP_PX = 10

/** Continuous green -> yellow -> red gradient anchored to the LED thresholds. */
function meterColorAt(db: number): [number, number, number] {
	if (db >= METER_ALARM_DB) return [255, 0, 0]
	if (db >= METER_WARNING_DB) {
		const t = (db - METER_WARNING_DB) / (METER_ALARM_DB - METER_WARNING_DB)
		return [255, Math.round(255 * (1 - t)), 0]
	}
	const t = (db - METER_BAR_FLOOR_DB) / (METER_WARNING_DB - METER_BAR_FLOOR_DB)
	return [Math.round(255 * Math.max(0, t)), 255, 0]
}

// Minimal 5x7 pixel font for the meter label column (VU, IN/OUT, digits, RMS/PK).
const METER_FONT: Record<string, readonly string[]> = {
	'0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
	'1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
	'2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
	'3': ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
	'4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
	'5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
	'6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
	'7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
	'8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
	'9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
	I: ['01110', '00100', '00100', '00100', '00100', '00100', '01110'],
	K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
	M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
	N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
	O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
	P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
	R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
	S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
	T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
	U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
	V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
}

// Signal-LED blue and the dimming factor used for the unlit "track".
const SIGNAL_BLUE: readonly [number, number, number] = [0, 90, 255]
const TRACK_DIM = 0.16
// LED-segment look: every 4th bar row is a 1 px dark gap.
const LED_SEGMENT_PITCH = 4

function dimColor([r, g, b]: readonly [number, number, number], factor: number): [number, number, number] {
	return [Math.round(r * factor), Math.round(g * factor), Math.round(b * factor)]
}

/**
 * Draw the meter button as a raw RGBA buffer.
 *
 * Left: the level bar over the -40..0 dB range. The full gradient scale is
 * always visible as a dimmed "track"; the live level lights it up from the
 * bottom (crop, never scale), split into LED-like segments. Below, separated
 * by a dark gap, the binary blue "signal" strip: all lit above -60 dB, dim
 * track below — so between -60 and -40 only the signal LED is on.
 *
 * Right: the label column — VU on top, then IN/OUT, the channel number and
 * the meter mode (RMS/PK), one row under the other.
 */
function drawMeterButton(
	width: number,
	height: number,
	db: number | undefined,
	labelRows: readonly (readonly [string, readonly [number, number, number]])[],
): Uint8Array {
	const buffer = new Uint8Array(width * height * 4)
	for (let i = 3; i < buffer.length; i += 4) buffer[i] = 255

	const setPixel = (x: number, y: number, r: number, g: number, b: number): void => {
		if (x < 0 || y < 0 || x >= width || y >= height) return
		const offset = (y * width + x) * 4
		buffer[offset] = r
		buffer[offset + 1] = g
		buffer[offset + 2] = b
	}

	// ----- bar geometry: small margins, LED zone, gap, signal strip -----
	const barX0 = 2
	const barWidth = Math.max(4, Math.floor(width / 2) - 4)
	const strip = Math.min(SIGNAL_STRIP_PX, height)
	const stripGap = height > strip + 4 ? 2 : 0
	const zoneHeight = Math.max(0, height - strip - stripGap)

	const fraction = db === undefined ? 0 : Math.max(0, Math.min(1, (db - METER_BAR_FLOOR_DB) / -METER_BAR_FLOOR_DB))
	const firstLitRow = zoneHeight - Math.round(fraction * zoneHeight)

	for (let y = 0; y < zoneHeight; y++) {
		// Fixed dB position per row: the level crops the gradient, never scales it.
		if (y % LED_SEGMENT_PITCH === LED_SEGMENT_PITCH - 1) continue // segment gap
		const rowDb = ((zoneHeight - y) / zoneHeight) * -METER_BAR_FLOOR_DB + METER_BAR_FLOOR_DB
		const color = meterColorAt(rowDb)
		const [r, g, b] = y >= firstLitRow && db !== undefined ? color : dimColor(color, TRACK_DIM)
		for (let x = barX0; x < barX0 + barWidth; x++) setPixel(x, y, r, g, b)
	}

	// Binary signal strip: fully lit above the threshold, dim track below.
	const signalLit = db !== undefined && db >= SIGNAL_FLOOR_DB
	const [sr, sg, sb] = signalLit ? SIGNAL_BLUE : dimColor(SIGNAL_BLUE, TRACK_DIM)
	for (let y = height - strip; y < height; y++) {
		for (let x = barX0; x < barX0 + barWidth; x++) setPixel(x, y, sr, sg, sb)
	}

	// ----- label column: short horizontal rows stacked top to bottom -----
	const scale = Math.max(1, Math.floor(height / 72))
	const rowHeight = 7 * scale
	const rowGap = 3 * scale
	const totalTextHeight = labelRows.length * rowHeight + (labelRows.length - 1) * rowGap
	const columnStart = barX0 + barWidth
	const xCenter = columnStart + Math.floor((width - columnStart) / 2)
	let rowTop = Math.max(0, Math.floor((height - totalTextHeight) / 2))
	for (const [text, [r, g, b]] of labelRows) {
		const chars = [...text]
		const textWidth = chars.length * 6 * scale - scale
		let x0 = xCenter - Math.floor(textWidth / 2)
		for (const ch of chars) {
			const glyph = METER_FONT[ch]
			if (glyph) {
				for (let gy = 0; gy < 7; gy++) {
					for (let gx = 0; gx < 5; gx++) {
						if (glyph[gy][gx] !== '1') continue
						for (let sy = 0; sy < scale; sy++) {
							for (let sx = 0; sx < scale; sx++) {
								setPixel(x0 + gx * scale + sx, rowTop + gy * scale + sy, r, g, b)
							}
						}
					}
				}
			}
			x0 += 6 * scale
		}
		rowTop += rowHeight + rowGap
	}
	return buffer
}

/** Key into NewtonState.gainReads / the poll set for one channel. */
export function gainKey(channelType: number, channelIndex: number): string {
	return `${channelType}:${channelIndex}`
}

export function getFeedbackDefinitions(
	getState: () => NewtonState,
	// controlId -> input number written by the rearm label feedback; the
	// 'rearm_this_input' action reads it so one option drives the whole button.
	rearmTargets: Map<string, number> = new Map(),
	// feedback-instance id -> channel shown by Levels & Mute. main.ts uses the
	// subscription set to avoid preset-audio traffic while no level is visible.
	gainSubs: Map<string, { channelType: number; channelIndex: number }> = new Map(),
	// controlId -> clock type written by the clock rearm label feedback; the
	// 'rearm_this_clock' action reads it so one option drives the whole button.
	clockRearmTargets: Map<string, number> = new Map(),
	// controlId -> snapshot uuid written by the snapshot label feedback; the
	// 'apply_this_snapshot' action reads it so one selection drives the button.
	snapshotTargets: Map<string, string> = new Map(),
	// Snapshot database entries for the by-name dropdown; definitions are
	// re-registered when the device list changes.
	snapshotList: SnapshotInfo[] = [],
	// controlId -> channel written by the mute feedback; the 'mute_this_channel'
	// action reads it so one pair of options drives the whole button.
	muteTargets: Map<string, { channelType: number; channelIndex: number }> = new Map(),
	// Number of per-button action-result feedbacks on each control. Success and
	// Error are commonly paired, so cleanup must wait for the last sibling.
	lastActionFeedbackRefs: Map<string, number> = new Map(),
): CompanionFeedbackDefinitions {
	const snapshotChoices = [
		{
			id: '',
			label: snapshotPlaceholderLabel(
				snapshotList.length,
				Boolean(getState().snapshotsUnsupported),
				Boolean(getState().snapshotDatabaseLoaded),
			),
		},
		...snapshotList.map((snapshot) => ({ id: snapshot.uuid, label: snapshot.name })),
	]
	// Register/refresh the channel shown by a gain or mute feedback.
	// Returns the resolved 0-based channel, or null if the options are invalid.
	const trackGainChannel = (feedback: {
		id: string
		options: Record<string, unknown>
	}): { channelType: number; channelIndex: number; label: string } | null => {
		const channel = Number(feedback.options['channel'])
		if (!Number.isInteger(channel) || channel < 1 || channel > 16) {
			gainSubs.delete(feedback.id)
			return null
		}
		const isOutput = Number(feedback.options['channelType']) === Number(ChannelType.OutputDsp)
		const channelType = isOutput ? Number(ChannelType.OutputDsp) : Number(ChannelType.InputDsp)
		const channelIndex = channel - 1
		gainSubs.set(feedback.id, { channelType, channelIndex })
		return { channelType, channelIndex, label: `${isOutput ? 'OUT' : 'IN'} ${channel}` }
	}
	const subscribeLastActionFeedback = (feedback: { controlId?: string; options: Record<string, unknown> }): void => {
		if (feedback.options['scope'] === 'global' || !feedback.controlId) return
		lastActionFeedbackRefs.set(feedback.controlId, (lastActionFeedbackRefs.get(feedback.controlId) ?? 0) + 1)
	}
	const unsubscribeLastActionFeedback = (feedback: { controlId?: string; options: Record<string, unknown> }): void => {
		if (feedback.options['scope'] === 'global' || !feedback.controlId) return
		const remaining = (lastActionFeedbackRefs.get(feedback.controlId) ?? 0) - 1
		if (remaining > 0) {
			lastActionFeedbackRefs.set(feedback.controlId, remaining)
			return
		}
		lastActionFeedbackRefs.delete(feedback.controlId)
		getState().lastActionResults?.delete(feedback.controlId)
	}

	return {
		mute_active: {
			type: 'boolean',
			name: 'Mute Active (deprecated)',
			description:
				'Deprecated compatibility feedback. Newton no longer exposes one global mute state; use Levels - Channel Mute for a channel-specific state.',
			defaultStyle: {
				bgcolor: combineRgb(255, 0, 0),
				color: combineRgb(255, 255, 255),
			},
			options: [],
			callback: () => false,
		},
		preset_active: {
			type: 'boolean',
			name: 'Preset Active (deprecated)',
			description:
				'Deprecated compatibility feedback. Newton is a signal matrix/hub and has no active device preset; this feedback always remains false.',
			defaultStyle: {
				bgcolor: combineRgb(0, 128, 0),
				color: combineRgb(255, 255, 255),
			},
			// Keep the historical option so saved 0.2.0 feedbacks remain editable,
			// while intentionally not restoring the removed current_preset state.
			options: [
				{
					type: 'number',
					label: 'Former Preset Number (ignored)',
					id: 'preset',
					default: 0,
					min: 0,
					max: 255,
				},
			],
			callback: () => false,
		},
		connection_status: {
			type: 'boolean',
			name: 'Device Connected',
			description: 'True while the device is connected. Useful for triggers.',
			defaultStyle: {
				bgcolor: combineRgb(0, 128, 0),
				color: combineRgb(255, 255, 255),
			},
			options: [],
			callback: () => {
				return getState().connected
			},
		},
		connection_monitor: {
			type: 'advanced',
			name: 'Connection - Monitor (auto label + color)',
			description: 'Shows NEWTON ONLINE (green) or OFFLINE (red) on the button. Nothing to configure.',
			options: [],
			callback: () => {
				return getState().connected
					? { text: 'NEWTON\nONLINE', bgcolor: UI.green, color: UI.textPrimary }
					: { text: 'NEWTON\nOFFLINE', bgcolor: UI.red, color: UI.textPrimary }
			},
		},
		last_action_success: {
			type: 'boolean',
			name: 'Last Newton Action - Success',
			description: 'True when the selected action last succeeded. Pair it with the Error feedback on the same button.',
			defaultStyle: {
				bgcolor: combineRgb(0, 128, 0),
				color: combineRgb(255, 255, 255),
			},
			options: [
				{
					type: 'textinput',
					label: 'Action name (blank = any action)',
					id: 'actionName',
					default: 'Set Gain',
				},
				LAST_ACTION_SCOPE_OPTION,
			],
			subscribe: subscribeLastActionFeedback,
			unsubscribe: unsubscribeLastActionFeedback,
			callback: (feedback) => {
				const actionName = String(feedback.options['actionName'] ?? '').trim()
				const { status, name } = resolveLastActionOutcome(feedback, getState())
				return status === 'success' && (!actionName || name === actionName)
			},
		},
		last_action_error: {
			type: 'boolean',
			name: 'Last Newton Action - Error',
			description:
				'True when the selected action last failed, timed out, or could not be sent. Pair it with the Success feedback on the same button.',
			defaultStyle: {
				bgcolor: combineRgb(180, 0, 0),
				color: combineRgb(255, 255, 255),
			},
			options: [
				{
					type: 'textinput',
					label: 'Action name (blank = any action)',
					id: 'actionName',
					default: 'Set Gain',
				},
				LAST_ACTION_SCOPE_OPTION,
			],
			subscribe: subscribeLastActionFeedback,
			unsubscribe: unsubscribeLastActionFeedback,
			callback: (feedback) => {
				const actionName = String(feedback.options['actionName'] ?? '').trim()
				const { status, name } = resolveLastActionOutcome(feedback, getState())
				return status === 'error' && (!actionName || name === actionName)
			},
		},
		input_patch_monitor: {
			type: 'advanced',
			name: 'Input Patch - Monitor (single input, auto label + color)',
			description:
				'One input number drives the button: shows "IN <n>", green while its top-priority source is playing, orange when a backup has taken over. Grey when unknown.',
			options: [
				{
					type: 'number',
					label: 'Input (1-16)',
					id: 'patchIndex',
					default: 1,
					min: 1,
					max: 16,
				},
			],
			callback: (feedback) => {
				const s = getState()
				// Operator numbering is 1-based; the protocol arrays are 0-based.
				const patchNumber = Number(feedback.options['patchIndex'])
				if (!Number.isInteger(patchNumber) || patchNumber < 1 || patchNumber > 16) return {}
				const text = `IN ${patchNumber}`
				const active = s.priorityInputDsp[patchNumber - 1]
				const first = s.priorityLists[patchNumber - 1]?.sources[0]
				if (active === undefined || active < 0 || first === undefined) {
					return { text }
				}
				if (active === first) {
					return { text, bgcolor: UI.green, color: UI.textPrimary }
				}
				return { text, bgcolor: UI.orange, color: UI.textPrimary }
			},
		},
		input_patch_rearm_label: {
			type: 'advanced',
			name: 'Input Patch - Rearm Button Label',
			description:
				'One input number drives the button: shows "REARM IN <n>" and tells the Rearm This Button Input action which input to rearm.',
			options: [
				{
					type: 'number',
					label: 'Input (1-16)',
					id: 'patchIndex',
					default: 1,
					min: 1,
					max: 16,
				},
			],
			subscribe: (feedback) => {
				const patchNumber = Number(feedback.options['patchIndex'])
				if (Number.isInteger(patchNumber) && patchNumber >= 1 && patchNumber <= 16) {
					rearmTargets.set(feedback.controlId, patchNumber)
				}
			},
			unsubscribe: (feedback) => {
				rearmTargets.delete(feedback.controlId)
			},
			callback: (feedback) => {
				const patchNumber = Number(feedback.options['patchIndex'])
				if (!Number.isInteger(patchNumber) || patchNumber < 1 || patchNumber > 16) {
					rearmTargets.delete(feedback.controlId)
					return {}
				}
				rearmTargets.set(feedback.controlId, patchNumber)
				return { text: `REARM\nIN ${patchNumber}` }
			},
		},
		meter: {
			type: 'advanced',
			name: 'Meter (Input/Output DSP)',
			description:
				'Live meter for one channel, with a VU / IN-OUT / channel / mode label. Below -60 dB dark; -60 to -40 dB only the blue signal LED; -40 to 0 dB the green/yellow/red bar lights proportionally.',
			options: [
				{
					type: 'dropdown',
					label: 'Meter Type',
					id: 'meterType',
					default: ChannelType.InputDsp,
					choices: [
						{ id: ChannelType.InputDsp, label: 'Input DSP' },
						{ id: ChannelType.OutputDsp, label: 'Output DSP' },
					],
				},
				{
					type: 'dropdown',
					label: 'Meter Mode',
					id: 'meterMode',
					default: 'rms',
					choices: [
						{ id: 'rms', label: 'RMS' },
						{ id: 'peak', label: 'Peak' },
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
			],
			callback: (feedback) => {
				const s = getState()
				// Operator numbering is 1-based; the protocol arrays are 0-based.
				const channel = Number(feedback.options['channel'])
				if (!Number.isInteger(channel) || channel < 1 || channel > 16) return {}
				const isOutput = Number(feedback.options['meterType']) === Number(ChannelType.OutputDsp)
				const isRms = feedback.options['meterMode'] === 'rms'
				const bank = isOutput ? (isRms ? s.vuOutputDspRms : s.vuOutputDsp) : isRms ? s.vuInputDspRms : s.vuInputDsp
				const db = bank[channel - 1]
				const width = feedback.image?.width ?? 72
				const height = feedback.image?.height ?? 72
				const white: [number, number, number] = [255, 255, 255]
				const grey: [number, number, number] = [165, 172, 185]
				const dim: [number, number, number] = [110, 118, 132]
				const labelRows = [
					['VU', white],
					[isOutput ? 'OUT' : 'IN', grey],
					[String(channel), white],
					[isRms ? 'RMS' : 'PK', dim],
				] as const
				return {
					bgcolor: combineRgb(0, 0, 0),
					imageBuffer: drawMeterButton(width, height, db, labelRows),
					imageBufferEncoding: { pixelFormat: 'RGBA' },
					imageBufferPosition: { x: 0, y: 0, width, height },
				}
			},
		},
		clock_monitor: {
			type: 'advanced',
			name: 'Clock - Monitor (auto label + color)',
			description:
				'One clock selection drives the button: shows the clock and its current source (e.g. "MCLK / WC"), green while its top-priority clock is running, orange when a backup has taken over. Grey when unknown.',
			options: [
				{
					type: 'dropdown',
					label: 'Clock',
					id: 'clockType',
					default: ClockType.Master,
					choices: CLOCK_TYPE_CHOICES,
				},
			],
			callback: (feedback) => {
				const s = getState()
				const clockType = Number(feedback.options['clockType'])
				if (!Number.isInteger(clockType) || clockType < 0 || clockType > 2) return {}
				const selected = s.clockSelected[clockType]
				const first = s.clockLists[clockType]?.list[0]
				const text = `${CLOCK_TYPE_LABELS[clockType]}\n${clockSourceName(selected)}`
				if (selected === undefined || selected < 0 || first === undefined) {
					return { text }
				}
				if (selected === first) {
					return { text, bgcolor: UI.green, color: UI.textPrimary }
				}
				return { text, bgcolor: UI.orange, color: UI.textPrimary }
			},
		},
		clock_rearm_label: {
			type: 'advanced',
			name: 'Clock - Rearm Button Label',
			description:
				'One clock selection drives the button: shows "REARM <clock>" and tells the Rearm This Button Clock action which clock to rearm.',
			options: [
				{
					type: 'dropdown',
					label: 'Clock',
					id: 'clockType',
					default: ClockType.Master,
					choices: CLOCK_TYPE_CHOICES,
				},
			],
			subscribe: (feedback) => {
				const clockType = Number(feedback.options['clockType'])
				if (Number.isInteger(clockType) && clockType >= 0 && clockType <= 2) {
					clockRearmTargets.set(feedback.controlId, clockType)
				}
			},
			unsubscribe: (feedback) => {
				clockRearmTargets.delete(feedback.controlId)
			},
			callback: (feedback) => {
				const clockType = Number(feedback.options['clockType'])
				if (!Number.isInteger(clockType) || clockType < 0 || clockType > 2) {
					clockRearmTargets.delete(feedback.controlId)
					return {}
				}
				clockRearmTargets.set(feedback.controlId, clockType)
				return { text: `REARM\n${CLOCK_TYPE_LABELS[clockType]}` }
			},
		},
		snapshot_apply_label: {
			type: 'advanced',
			name: 'Snapshot - Apply Button Label',
			description:
				'One snapshot selection drives the button: shows the snapshot name and tells the Apply This Button Snapshot action which snapshot to apply.',
			options: [
				{
					type: 'dropdown',
					label: 'Snapshot',
					id: 'uuid',
					default: '',
					choices: snapshotChoices,
				},
			],
			subscribe: (feedback) => {
				const uuid = String(feedback.options['uuid'] ?? '').trim()
				if (uuid) snapshotTargets.set(feedback.controlId, uuid)
			},
			unsubscribe: (feedback) => {
				snapshotTargets.delete(feedback.controlId)
			},
			callback: (feedback) => {
				// Old firmware (< 0.98) has no snapshots: say so on the button
				// instead of showing a snapshot name that can never be applied.
				if (getState().snapshotsUnsupported) {
					snapshotTargets.delete(feedback.controlId)
					return { text: `NO SNAPSHOT\nFW < ${MIN_SNAPSHOT_FIRMWARE}` }
				}
				const uuid = String(feedback.options['uuid'] ?? '').trim()
				if (!uuid) {
					snapshotTargets.delete(feedback.controlId)
					return { text: 'APPLY\n#snapshot' }
				}
				if (!getState().snapshotDatabaseLoaded) {
					snapshotTargets.set(feedback.controlId, uuid)
					return { text: 'SNAPSHOT\nLOADING…' }
				}
				const snapshot = findSnapshot(snapshotList, uuid)
				if (!snapshot) {
					snapshotTargets.delete(feedback.controlId)
					return { text: 'SNAPSHOT\nMISSING' }
				}
				snapshotTargets.set(feedback.controlId, uuid)
				return { text: `APPLY\n${snapshot.name}` }
			},
		},
		channel_gain: {
			type: 'advanced',
			name: 'Levels - Channel Gain',
			description:
				'Shows a channel\'s live gain on the button, e.g. "GAIN IN 3 / -6.0 dB". Refreshes from the complete 0x21 audio-preset payload while the feedback is in use; its cadence follows Interactivity.',
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
			],
			subscribe: (feedback) => {
				trackGainChannel(feedback)
			},
			unsubscribe: (feedback) => {
				gainSubs.delete(feedback.id)
			},
			callback: (feedback) => {
				const resolved = trackGainChannel(feedback)
				if (!resolved) return {}
				const read = getState().gainReads.get(gainKey(resolved.channelType, resolved.channelIndex))
				const value = read ? (read.muted ? 'MUTED' : `${read.gainDb.toFixed(1)} dB`) : '--'
				return { text: `GAIN ${resolved.label}\\n${value}` }
			},
		},
		channel_mute: {
			type: 'advanced',
			name: 'Levels - Channel Mute',
			description:
				"Shows a channel's mute state (red muted, green open) and tells the Mute This Button Channel action which channel to toggle. Refreshes from the complete 0x21 audio-preset payload while the feedback is in use; its cadence follows Interactivity.",
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
			],
			subscribe: (feedback) => {
				const resolved = trackGainChannel(feedback)
				if (resolved) {
					muteTargets.set(feedback.controlId, {
						channelType: resolved.channelType,
						channelIndex: resolved.channelIndex,
					})
				}
			},
			unsubscribe: (feedback) => {
				gainSubs.delete(feedback.id)
				muteTargets.delete(feedback.controlId)
			},
			callback: (feedback) => {
				const resolved = trackGainChannel(feedback)
				if (!resolved) {
					muteTargets.delete(feedback.controlId)
					return {}
				}
				muteTargets.set(feedback.controlId, {
					channelType: resolved.channelType,
					channelIndex: resolved.channelIndex,
				})
				const read = getState().gainReads.get(gainKey(resolved.channelType, resolved.channelIndex))
				if (!read) {
					return { text: `TOGGLE MUTE\\n${resolved.label}\\n--` }
				}
				return read.muted
					? {
							text: `TOGGLE MUTE\\n${resolved.label}\\nMUTED`,
							bgcolor: UI.red,
							color: UI.textPrimary,
						}
					: {
							text: `TOGGLE MUTE\\n${resolved.label}\\nUNMUTED`,
							bgcolor: UI.green,
							color: UI.textPrimary,
						}
			},
		},
	}
}
