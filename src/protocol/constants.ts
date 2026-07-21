// ===== Network Ports =====
export const PORT_UDP = 6666 // Legacy UDP discovery
export const PORT_METERS = 6667 // Newton UDP meter/status server
export const PORT_TCP = 6668 // Newton TCP control server
export const PORT_BROADCAST = 6669 // UDP broadcast notifications
export const PORT_UDP_COMMAND = 6670 // Secondary UDP command server
export const PORT_STATUS = 6671 // UDP status server

// ===== Legacy Command IDs (first message byte) =====
export enum LegacyCmd {
	Gain = 0x01,
	Delay = 0x02,
	Iir = 0x03,
	LimiterRms = 0x04,
	LimiterPseudoPeak = 0x05,
	Mute = 0x06,
	Polarity = 0x07,
	MatrixAssign = 0x09,
	StorePreset = 0x0a,
	Pan = 0x0b,
	DeviceId = 0x0c,
	ChangePreset = 0x0e,
	ExportPreset = 0x10,
	ChannelName = 0x1a,
	GroupName = 0x1b,
	LinkUpdate = 0x1c,
	Fader = 0x1d,
	ReadNetwork = 0x1e,
	FindDevice = 0x1f,
	SaveNetwork = 0x20,
	ImportAudioPresetInfo = 0x21,
	ImportDevicePresetInfo = 0x22,
	SetLink = 0x23,
	ImportSignals = 0x2b,
	Exist = 0x2c,
	SynchPriority = 0x2d,
	ReadSynchPriority = 0x2e,
	ImportPresetNth = 0x2f,
	RearLed = 0x30,
	PowerLed = 0x31,
	ReadPowerLed = 0x32,
	ReadRearLed = 0x33,
	LinkDigital = 0x34,
	ReadLinkDigital = 0x35,
	SaveMacAddress = 0x36,
	ImportSerial = 0x37,
	SaveSerial = 0x38,
	ClearClip = 0x39,
	UpdateFirmware = 0x3a,
	UpdateApp = 0x3b,
	UpdateData = 0x3c,
	ClonePresets = 0x3d,
	ImportDescription = 0x3e,
	SaveDescription = 0x3f,
	ImportFirmware = 0x40,
	SaveFirmware = 0x41,
	ImportBitstream = 0x42,
	SaveBitstream = 0x43,
	ImportMacAddress = 0x44,
	SetSensitivity = 0x45,
	GetSensitivity = 0x46,
	SetLed = 0x47,
	GetLed = 0x48,
	SetAes3 = 0x49,
	GetAes3 = 0x4a,
	SetFan = 0x4b,
	GetFan = 0x4c,
	SetProcessingClock = 0x80,
	GetProcessingClock = 0x81,
	RearmPriority = 0x90,
	ReadPriorityList = 0x91,
}

// ===== Processing clock (0x80/0x81) =====
export enum ClockType {
	Master = 0x00,
	WordClockOut1 = 0x01,
	WordClockOut2 = 0x02,
}
export const CLOCK_TYPE_COUNT = 3
export const CLOCK_LIST_LENGTH = 16

/** Documented Clock List source names, index = protocol clock value 0-15. */
export const CLOCK_SOURCE_NAMES = [
	'INT24',
	'INT22',
	'WC',
	'AES 1-2',
	'AES 3-4',
	'AES 5-6',
	'AES 7-8',
	'AES 9-10',
	'AES 11-12',
	'AES 13-14',
	'AES 15-16',
	'MADI CX',
	'MADI OPT',
	'DANTE',
	'VSYNC',
	'NONE',
] as const

// 0x2B blob: per-clock-type blocks of 16 status bytes + 1 "selected" byte,
// Master at 615, Word Clock Out 1 at 632, Word Clock Out 2 at 649. The
// selected byte (base+16) holds the definitive Clock List value post-backup.
export const SIGNALS_CLOCK_STATUS_BASE = 615
export const SIGNALS_CLOCK_BLOCK_SIZE = 17

// Offset within the 0x2B (ImportSignals) response where the priority patch
// state lives: 24 bytes = 16 InputDsp + 8 AuxMixer; each byte is the currently
// active source channel (post-backup) for that priority patch.
export const SIGNALS_PRIORITY_PATCH_OFFSET = 666
export const SIGNALS_PRIORITY_PATCH_LENGTH = 24
export const SIGNALS_INPUT_DSP_PRIORITY_COUNT = 16
export const SIGNALS_AUX_MIXER_PRIORITY_COUNT = 8
/** Protocol sentinel used when a priority patch has no active/configured source. */
export const PRIORITY_SOURCE_NONE = 0xd8
/** Clock List value used when no processing clock source is selected. */
export const CLOCK_SOURCE_NONE = 0x0f

// ===== Special Protocol =====
export const SPC_HEADER = 0xf0
export const SPR_HEADER = 0xf1

// Special Protocol command IDs (snapshot)
export enum SnapshotCmd {
	Store = 0x0001,
	Delete = 0x0002,
	GetDatabase = 0x0003,
	Apply = 0x0004,
	RecallSafeGet = 0x0005,
	RecallSafeSet = 0x0006,
	GetRecallArea = 0x0007,
	UpdateMetadata = 0x0008,
	SetRecallArea = 0x0009,
	Clone = 0x000a,
}

/**
 * First firmware with the snapshot command set. Older firmware (e.g. 0.97)
 * answers any snapshot SPC request with a plain legacy [0x66, 0x00] error.
 */
export const MIN_SNAPSHOT_FIRMWARE = '0.98'

/**
 * Device-safety gain window: every gain written to the device is clamped to
 * [-80, +6] dB as a PA-safety net — values outside this range must never
 * reach the wire, whatever their source (operator input, cached device
 * reads, trigger expressions).
 */
export const GAIN_MIN_DB = -80
export const GAIN_MAX_DB = 6

/** Clamp a finite dB gain to the device-safe write range; malformed values fail closed. */
export function clampGainDb(gainDb: number): number {
	if (!Number.isFinite(gainDb)) throw new RangeError('Gain must be a finite number')
	return Math.min(GAIN_MAX_DB, Math.max(GAIN_MIN_DB, gainDb))
}

// ===== Reply Codes =====
export const REPLY_OK = 0x33
export const REPLY_ERR = 0x66
export const SPR_NOERR = 0x3300
export const SPR_WERR = 0x6600

// ===== Channel Types =====
export enum ChannelType {
	InputDsp = 0x00,
	OutputDsp = 0x01,
	AuxMixer = 0x02,
	MatrixMixer = 0x03,
	Trimmer = 0x04,
	OutputGroup = 0x05,
}

// ===== Snapshot Apply Modes =====
export enum SnapshotApplyMode {
	Direct = 'Direct',
	ThroughZero = 'ThroughZero',
}

// ===== Snapshot Parts (recall areas) =====
export const SNAPSHOT_PARTS = {
	ALL: '/',
	DSP: '/DSP',
	DSP_INPUT: '/DSP/INPUT',
	DSP_INPUT_GAIN: '/DSP/INPUT/GAIN',
	DSP_INPUT_FILTER: '/DSP/INPUT/FILTER',
	DSP_OUTPUT: '/DSP/OUTPUT',
	DSP_OUTPUT_GAIN: '/DSP/OUTPUT/GAIN',
	DSP_OUTPUT_FILTER: '/DSP/OUTPUT/FILTER',
	DSP_MATRIX: '/DSP/MATRIX',
	DSP_AUXMIXER: '/DSP/AUXMIXER',
	INPUT_PATCH: '/INPUTPATCH',
	OUTPUT_PATCH: '/OUTPUTPATCH',
	CLOCK_CONFIG: '/CLOCKCONFIG',
	DIRECT_OUT: '/DIRECTOUT',
	MACHINE_CONF: '/MACHINECONF',
} as const

// ===== Fixed Protocol Values =====
export const FIXED_BYTE_0x33 = 0x33
export const FIXED_BYTE_0x66 = 0x66

// ===== CRC16 =====
export const CRC16_POLYNOMIAL = 0xa001
export const CRC16_INITIAL = 0x0000

// ===== SPC Message Structure Offsets =====
export const SPC_OFFSET_HEADER = 0 // 0xF0
export const SPC_OFFSET_EMPTY = 1 // 0x00
export const SPC_OFFSET_CMD_MSB = 2
export const SPC_OFFSET_CMD_LSB = 3
export const SPC_OFFSET_LEN_MSB = 4
export const SPC_OFFSET_LEN_LSB = 5
export const SPC_HEADER_SIZE = 6 // bytes before payload
export const SPC_CRC_SIZE = 2 // CRC at end
/** Snapshot addendum §4.2.2 maximum UTF-8 JSON payload length. */
export const SNAPSHOT_MAX_PAYLOAD_BYTES = 65_520

// ===== SPR Message Structure Offsets =====
export const SPR_OFFSET_HEADER = 0 // 0xF1
export const SPR_OFFSET_EMPTY = 1 // 0x00
export const SPR_OFFSET_CMD_MSB = 2
export const SPR_OFFSET_CMD_LSB = 3
export const SPR_OFFSET_LEN_MSB = 4
export const SPR_OFFSET_LEN_LSB = 5
export const SPR_OFFSET_REPLY_MSB = 6
export const SPR_OFFSET_REPLY_LSB = 7
export const SPR_HEADER_SIZE = 8 // bytes before payload (includes std reply)
export const SPR_CRC_SIZE = 2
