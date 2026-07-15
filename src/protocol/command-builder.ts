import {
	CLOCK_LIST_LENGTH,
	ChannelType,
	ClockType,
	FIXED_BYTE_0x33,
	FIXED_BYTE_0x66,
	LegacyCmd,
	clampGainDb,
	SPC_CRC_SIZE,
	SPC_HEADER,
	SPC_HEADER_SIZE,
	SnapshotCmd,
} from './constants.js'
import { appendCrc16 } from './crc16.js'
import type {
	DelayParams,
	FaderParams,
	GainParams,
	MatrixParams,
	PolarityParams,
	SnapshotApplyParams,
	SnapshotStoreParams,
	SnapshotUpdateMetadataParams,
} from './types.js'

// ===== Legacy Commands =====

/**
 * Build a Gain command (0x01) - 11 bytes total.
 * [0]: cmd 0x01
 * [1]: channel type
 * [2-5]: channel index (int32 LE)
 * [6-9]: gain in dB (float32 LE), clamped to the device-safe write range
 * [10]: mute (0=no mute, 1=mute)
 */
export function buildGainCommand(params: GainParams): Buffer {
	const buf = Buffer.alloc(11)
	buf[0] = LegacyCmd.Gain
	buf[1] = params.channelType
	buf.writeInt32LE(params.channelIndex, 2)
	buf.writeFloatLE(clampGainDb(params.gainDb), 6)
	buf[10] = params.mute ? 1 : 0
	return buf
}

/**
 * Build a Mute command (0x06) - 3 bytes total.
 * [0]: cmd 0x06
 * [1]: 0x33 fixed
 * [2]: mute value (0x00=unmute, 0x01=mute)
 */
export function buildMuteCommand(mute: boolean): Buffer {
	const buf = Buffer.alloc(3)
	buf[0] = LegacyCmd.Mute
	buf[1] = FIXED_BYTE_0x33
	buf[2] = mute ? 0x01 : 0x00
	return buf
}

/**
 * Build a Delay command (0x02) - 11 bytes total.
 * [0]: cmd 0x02
 * [1]: channel type
 * [2-5]: channel index (int32 LE)
 * [6-9]: delay in samples (int32 LE)
 * [10]: bypass (0=process, 1=bypass)
 */
export function buildDelayCommand(params: DelayParams): Buffer {
	const buf = Buffer.alloc(11)
	buf[0] = LegacyCmd.Delay
	buf[1] = params.channelType
	buf.writeInt32LE(params.channelIndex, 2)
	buf.writeInt32LE(params.delaySamples, 6)
	buf[10] = params.bypass ? 1 : 0
	return buf
}

/**
 * Build a Change Preset command (0x0E) - 3 bytes total.
 * [0]: cmd 0x0E
 * [1]: 0x33 fixed
 * [2]: preset number
 */
export function buildChangePresetCommand(presetNumber: number): Buffer {
	const buf = Buffer.alloc(3)
	buf[0] = LegacyCmd.ChangePreset
	buf[1] = FIXED_BYTE_0x33
	buf[2] = presetNumber & 0xff
	return buf
}

/**
 * Build a Polarity command (0x07) - 7 bytes total.
 * [0]: cmd 0x07
 * [1]: channel type
 * [2-5]: channel index (int32 LE)
 * [6]: polarity (0=normal, 1=inverted)
 */
export function buildPolarityCommand(params: PolarityParams): Buffer {
	const buf = Buffer.alloc(7)
	buf[0] = LegacyCmd.Polarity
	buf[1] = params.channelType
	buf.writeInt32LE(params.channelIndex, 2)
	buf[6] = params.inverted ? 1 : 0
	return buf
}

/**
 * Build a Fader command (0x1D) - 66 bytes for 16 channels.
 * Sets gain for all channels of a given channel type.
 * [0]: cmd 0x1D
 * [1]: channel type
 * [2..65]: 16 float32 LE gain values, each clamped to the device-safe write range
 */
export function buildFaderCommand(params: FaderParams): Buffer {
	if (params.gains.length !== 16) {
		throw new RangeError('Fader command requires exactly 16 gain values')
	}
	const buf = Buffer.alloc(2 + params.gains.length * 4)
	buf[0] = LegacyCmd.Fader
	buf[1] = params.channelType
	for (let i = 0; i < params.gains.length; i++) {
		buf.writeFloatLE(clampGainDb(params.gains[i]), 2 + i * 4)
	}
	return buf
}

/**
 * Build a Matrix Assignment command (0x09) - 5 bytes total.
 * [0]: cmd 0x09
 * [1]: 0x33 fixed
 * [2]: 0x66 fixed
 * [3]: output channel
 * [4]: input value
 */
export function buildMatrixCommand(params: MatrixParams): Buffer {
	const buf = Buffer.alloc(5)
	buf[0] = LegacyCmd.MatrixAssign
	buf[1] = FIXED_BYTE_0x33
	buf[2] = FIXED_BYTE_0x66
	buf[3] = params.outputChannel & 0xff
	buf[4] = params.inputValue & 0xff
	return buf
}

/**
 * Build a Pan command (0x0B).
 * [0]: cmd 0x0B
 * [1]: channel type
 * [2-5]: channel index (int32 LE)
 * [6-9]: pan value (float32 LE, 0=left, 0.5=center, 1=right)
 */
export function buildPanCommand(channelType: ChannelType, channelIndex: number, panValue: number): Buffer {
	const buf = Buffer.alloc(10)
	buf[0] = LegacyCmd.Pan
	buf[1] = channelType
	buf.writeInt32LE(channelIndex, 2)
	buf.writeFloatLE(panValue, 6)
	return buf
}

/**
 * Build a Store Preset command (0x0A) - 3 bytes total.
 * [0]: cmd 0x0A
 * [1]: 0x33 fixed
 * [2]: preset number
 */
export function buildStorePresetCommand(presetNumber: number): Buffer {
	const buf = Buffer.alloc(3)
	buf[0] = LegacyCmd.StorePreset
	buf[1] = FIXED_BYTE_0x33
	buf[2] = presetNumber & 0xff
	return buf
}

/**
 * Build an Exist command (0x2C) - 3 bytes total.
 * Used for device discovery/ping.
 * [0]: cmd 0x2C
 * [1]: 0x33 fixed
 * [2]: 0x66 fixed
 */
export function buildExistCommand(): Buffer {
	const buf = Buffer.alloc(3)
	buf[0] = LegacyCmd.Exist
	buf[1] = FIXED_BYTE_0x33
	buf[2] = FIXED_BYTE_0x66
	return buf
}

/**
 * Build an Import Description command (0x3E) - 3 bytes total.
 * Reads the device description.
 */
export function buildImportDescriptionCommand(): Buffer {
	const buf = Buffer.alloc(3)
	buf[0] = LegacyCmd.ImportDescription
	buf[1] = FIXED_BYTE_0x33
	buf[2] = FIXED_BYTE_0x66
	return buf
}

/**
 * Build an Import Firmware version command (0x40) - 3 bytes total.
 */
export function buildImportFirmwareCommand(): Buffer {
	const buf = Buffer.alloc(3)
	buf[0] = LegacyCmd.ImportFirmware
	buf[1] = FIXED_BYTE_0x33
	buf[2] = FIXED_BYTE_0x66
	return buf
}

/**
 * Build an Import Serial command (0x37) - 3 bytes total.
 */
export function buildImportSerialCommand(): Buffer {
	const buf = Buffer.alloc(3)
	buf[0] = LegacyCmd.ImportSerial
	buf[1] = FIXED_BYTE_0x33
	buf[2] = FIXED_BYTE_0x66
	return buf
}

/**
 * Build a Set LED command (0x47) - 4 bytes total.
 * [0]: cmd 0x47
 * [1]: LED index
 * [2]: color component (0=R, 1=G, 2=B)
 * [3]: value (0=off, 1=on)
 */
export function buildSetLedCommand(ledIndex: number, colorComponent: number, value: boolean): Buffer {
	const buf = Buffer.alloc(4)
	buf[0] = LegacyCmd.SetLed
	buf[1] = ledIndex & 0xff
	buf[2] = colorComponent & 0xff
	buf[3] = value ? 0x01 : 0x00
	return buf
}

/**
 * Build an Import Audio Preset command (0x21) - 3 bytes total.
 * The response is [0x33, 0x00] followed by the full 393216-byte audio preset,
 * which carries every processing parameter (gains, mutes, filters, ...).
 */
export function buildImportAudioPresetCommand(): Buffer {
	const buf = Buffer.alloc(3)
	buf[0] = LegacyCmd.ImportAudioPresetInfo
	buf[1] = FIXED_BYTE_0x33
	buf[2] = FIXED_BYTE_0x66
	return buf
}

/**
 * Build an Import Signals command (0x2B) - 3 bytes total.
 * Reads the 1024-byte signals/LEDs blob.
 * Bytes [666-689] contain the current source channel for each priority patch.
 */
export function buildImportSignalsCommand(): Buffer {
	const buf = Buffer.alloc(3)
	buf[0] = LegacyCmd.ImportSignals
	buf[1] = FIXED_BYTE_0x33
	buf[2] = FIXED_BYTE_0x66
	return buf
}

/**
 * Build a Read Hardware-to-Logic priority list command (0x91) - 4 bytes total.
 * [0]: cmd 0x91
 * [1]: 0x33 fixed
 * [2]: 0x66 fixed
 * [3]: InputDsp channel index (0..15)
 *
 * Response contains the priority list for the requested channel:
 * highest priority ch, 2nd, 3rd, lowest priority ch, isForced, forced ch.
 */
export function buildReadPriorityListCommand(channelIndex: number): Buffer {
	const buf = Buffer.alloc(4)
	buf[0] = LegacyCmd.ReadPriorityList
	buf[1] = FIXED_BYTE_0x33
	buf[2] = FIXED_BYTE_0x66
	buf[3] = channelIndex & 0xff
	return buf
}

/**
 * Build a Hardware-to-Logic priority update/rearm command (0x90) - 12 bytes.
 * [0]: cmd 0x90
 * [1]: 0x33 fixed
 * [2]: 0x66 fixed
 * [3]: InputDsp channel index (0..15)
 * [4-7]: four priority sources from highest to lowest
 * [8]: retain forced/manual mode from the preceding 0x91 read
 * [9]: retain forced channel from the preceding 0x91 read
 * [10]: rearm flag (1)
 * [11]: rearm slot (0..3)
 *
 * The protocol has no short "rearm" form: callers must read the current
 * list first and preserve its priority/forced bytes in this full update.
 */
export function buildRearmPriorityCommand(
	channelIndex: number,
	priority: { sources: number[]; isForced: boolean; forcedChannel: number },
	rearmIndex: number,
): Buffer {
	if (priority.sources.length !== 4) {
		throw new Error('Priority list must contain exactly four source channels')
	}
	const buf = Buffer.alloc(12)
	buf[0] = LegacyCmd.RearmPriority
	buf[1] = FIXED_BYTE_0x33
	buf[2] = FIXED_BYTE_0x66
	buf[3] = channelIndex & 0xff
	for (let i = 0; i < 4; i++) buf[4 + i] = priority.sources[i] & 0xff
	buf[8] = priority.isForced ? 1 : 0
	buf[9] = priority.forcedChannel & 0xff
	buf[10] = 1
	buf[11] = rearmIndex & 0xff
	return buf
}

/**
 * Build a Get Processing Clock command (0x81) - 4 bytes total.
 * [0]: cmd 0x81
 * [1]: 0x33 fixed
 * [2]: 0x66 fixed
 * [3]: clock type (0=Master, 1=Word Clock Out 1, 2=Word Clock Out 2)
 *
 * Response is 19 bytes: [0-15] priority list (Clock List values),
 * [16] isForced, [17] forced index into the list, [18] is48.
 */
export function buildGetClockCommand(clockType: ClockType): Buffer {
	const buf = Buffer.alloc(4)
	buf[0] = LegacyCmd.GetProcessingClock
	buf[1] = FIXED_BYTE_0x33
	buf[2] = FIXED_BYTE_0x66
	buf[3] = clockType & 0xff
	return buf
}

/**
 * Build a processing-clock rearm command (0x80) - 25 bytes total.
 * [0]: cmd 0x80
 * [1]: 0x33 fixed
 * [2]: 0x66 fixed
 * [3]: clock type
 * [4-19]: 16-byte priority list, preserved from the preceding 0x81 read
 * [20]: isForced (preserved)
 * [21]: forced clock VALUE per Clock List (0x81 returns an index; convert)
 * [22]: is48 (preserved)
 * [23]: isRearm = 1
 * [24]: rearm slot (0..13)
 *
 * Like H2L, the protocol has no short rearm form: the current settings are
 * read first and written back unchanged with the rearm flag set.
 */
export function buildRearmClockCommand(
	clockType: ClockType,
	clock: { list: number[]; isForced: boolean; forcedIndex: number; is48: boolean },
	rearmIndex: number,
): Buffer {
	if (clock.list.length !== CLOCK_LIST_LENGTH) {
		throw new Error('Clock priority list must contain exactly 16 entries')
	}
	const buf = Buffer.alloc(25)
	buf[0] = LegacyCmd.SetProcessingClock
	buf[1] = FIXED_BYTE_0x33
	buf[2] = FIXED_BYTE_0x66
	buf[3] = clockType & 0xff
	for (let i = 0; i < CLOCK_LIST_LENGTH; i++) buf[4 + i] = clock.list[i] & 0xff
	buf[20] = clock.isForced ? 1 : 0
	buf[21] = clock.isForced ? (clock.list[clock.forcedIndex] ?? 0) & 0xff : 0
	buf[22] = clock.is48 ? 1 : 0
	buf[23] = 1
	buf[24] = rearmIndex & 0xff
	return buf
}

/**
 * Build a Set Sensitivity command (0x45) - 4 bytes total.
 * [0]: cmd 0x45
 * [1]: 0x33 fixed
 * [2]: input channel pair
 * [3]: sensitivity (0=20dB, 1=26dB)
 */
export function buildSetSensitivityCommand(channelPair: number, is26dB: boolean): Buffer {
	const buf = Buffer.alloc(4)
	buf[0] = LegacyCmd.SetSensitivity
	buf[1] = FIXED_BYTE_0x33
	buf[2] = channelPair & 0xff
	buf[3] = is26dB ? 0x01 : 0x00
	return buf
}

// ===== Special Protocol Commands (SPC) =====

/**
 * Build a generic SPC (Special Protocol Command) message.
 *
 * Structure:
 * [0]: 0xF0 (SPC header)
 * [1]: 0x00 (empty)
 * [2-3]: CMD (16bit MSB first)
 * [4-5]: LEN (total message length, 16bit MSB first)
 * [6..N-3]: payload
 * [N-2..N-1]: CRC16 (LSB first)
 */
export function buildSPC(specialCmd: SnapshotCmd, jsonPayload?: Record<string, unknown>): Buffer {
	const payloadStr = jsonPayload ? JSON.stringify(jsonPayload) : ''
	const payloadBuf = Buffer.from(payloadStr, 'utf-8')

	const totalLen = SPC_HEADER_SIZE + payloadBuf.length + SPC_CRC_SIZE
	if (totalLen > 0xffff) {
		throw new RangeError(`SPC payload exceeds the 16-bit frame limit (${totalLen} bytes)`)
	}
	const buf = Buffer.alloc(totalLen)

	// Header
	buf[0] = SPC_HEADER
	buf[1] = 0x00
	// CMD - MSB first
	buf.writeUInt16BE(specialCmd, 2)
	// LEN - MSB first (total message length)
	buf.writeUInt16BE(totalLen, 4)

	// Payload
	if (payloadBuf.length > 0) {
		payloadBuf.copy(buf, SPC_HEADER_SIZE)
	}

	// CRC16 (LSB first) - calculated over everything except the CRC bytes
	appendCrc16(buf)

	return buf
}

/**
 * Build a Snapshot Store command.
 * Creates a new snapshot on the Newton device with the given metadata.
 */
export function buildSnapshotStore(params: SnapshotStoreParams): Buffer {
	return buildSPC(SnapshotCmd.Store, params)
}

/**
 * Build a Snapshot Delete command.
 * Deletes a snapshot identified by UUID.
 */
export function buildSnapshotDelete(uuid: string): Buffer {
	return buildSPC(SnapshotCmd.Delete, { uuid })
}

/**
 * Build a Snapshot Get Database command.
 * Retrieves the full snapshot database from the device.
 */
export function buildSnapshotGetDatabase(): Buffer {
	return buildSPC(SnapshotCmd.GetDatabase)
}

/**
 * Build a Snapshot Apply command.
 * Applies a snapshot with optional fading time, mode, and partial recall.
 */
export function buildSnapshotApply(params: SnapshotApplyParams): Buffer {
	const payload: Record<string, unknown> = { uuid: params.uuid }
	if (params.fadingTime !== undefined) {
		payload.fading_time = params.fadingTime
	}
	if (params.mode !== undefined) {
		payload.mode = params.mode
	}
	if (params.parts !== undefined) {
		payload.part = params.parts
	}
	return buildSPC(SnapshotCmd.Apply, payload)
}

/**
 * Build a Recall Safe Get command.
 * Retrieves the current recall-safe areas.
 */
export function buildRecallSafeGet(): Buffer {
	return buildSPC(SnapshotCmd.RecallSafeGet)
}

/**
 * Build a Recall Safe Set command.
 * Sets which areas are protected from snapshot recall.
 */
export function buildRecallSafeSet(parts: string[]): Buffer {
	return buildSPC(SnapshotCmd.RecallSafeSet, { part: parts })
}

/**
 * Build a Snapshot Update Metadata command.
 * Updates metadata fields for an existing snapshot.
 * Set a field to null to delete it.
 */
export function buildSnapshotUpdateMetadata(params: SnapshotUpdateMetadataParams): Buffer {
	return buildSPC(SnapshotCmd.UpdateMetadata, params)
}

/**
 * Build a Snapshot Clone command.
 * Clones an existing snapshot, optionally updating metadata.
 */
export function buildSnapshotClone(uuid: string, additionalMetadata?: Record<string, unknown>): Buffer {
	const payload: Record<string, unknown> = { uuid, ...additionalMetadata }
	return buildSPC(SnapshotCmd.Clone, payload)
}

/**
 * Build a Get Recall Area command.
 * Gets the last-used recall area for a specific snapshot.
 */
export function buildGetRecallArea(uuid: string): Buffer {
	return buildSPC(SnapshotCmd.GetRecallArea, { uuid })
}

/**
 * Build a Set Recall Area command.
 * Sets the recall area for a snapshot without applying it.
 */
export function buildSetRecallArea(uuid: string, parts: string[]): Buffer {
	return buildSPC(SnapshotCmd.SetRecallArea, { uuid, part: parts })
}
