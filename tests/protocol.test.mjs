/* eslint-disable n/no-unpublished-import */
import assert from 'node:assert/strict'
import test from 'node:test'

import { ChannelType, SnapshotCmd } from '../dist/protocol/constants.js'
import {
	buildDelayCommand,
	buildGainCommand,
	buildReadPresetCommand,
	buildRearmPriorityCommand,
	buildSPC,
} from '../dist/protocol/command-builder.js'
import {
	MessageAccumulator,
	parseLegacyResponse,
	parsePriorityPatchState,
	parseReadPresetResponse,
	parseSPR,
} from '../dist/protocol/command-parser.js'
import { verifyCrc16 } from '../dist/protocol/crc16.js'
import { VuListener } from '../dist/protocol/vu-listener.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('builds gain command with little-endian int32 and float32', () => {
	const cmd = buildGainCommand({
		channelType: ChannelType.InputDsp,
		channelIndex: 0,
		gainDb: -6,
		mute: false,
	})
	assert.equal(cmd.toString('hex'), '0100000000000000c0c000')
})

test('builds delay and rearm commands with little-endian int32', () => {
	assert.equal(
		buildDelayCommand({
			channelType: ChannelType.InputDsp,
			channelIndex: 1,
			delayMs: 12.5,
		}).toString('hex'),
		'02000100000000004841',
	)
	assert.equal(buildRearmPriorityCommand(ChannelType.InputDsp, 0).toString('hex'), '900000000000')
})

test('parses legacy OK and ERR responses', () => {
	assert.deepEqual(parseLegacyResponse(Buffer.from('33000102', 'hex')), {
		success: true,
		command: 0x33,
		payload: Buffer.from('0102', 'hex'),
	})
	assert.equal(parseLegacyResponse(Buffer.from('6600', 'hex')).success, false)
})

test('builds and parses current preset command', () => {
	assert.equal(buildReadPresetCommand().toString('hex'), '0833')
	assert.equal(parseReadPresetResponse(Buffer.from('330005', 'hex')), 5)
	assert.equal(parseReadPresetResponse(Buffer.from('6600', 'hex')), null)
})

test('builds SPC with valid CRC and parses SPR JSON payload', () => {
	const spc = buildSPC(SnapshotCmd.Store, { author: 'test' })
	assert.equal(spc[0], 0xf0)
	assert.equal(verifyCrc16(spc), true)

	const payload = Buffer.from(JSON.stringify({ count: 1 }), 'utf8')
	const spr = Buffer.alloc(8 + payload.length + 2)
	spr[0] = 0xf1
	spr[1] = 0x00
	spr.writeUInt16BE(SnapshotCmd.GetDatabase, 2)
	spr.writeUInt16BE(spr.length, 4)
	spr.writeUInt16BE(0x3300, 6)
	payload.copy(spr, 8)
	// Local append to avoid depending on a second writer in this parser test.
	let crc = 0
	for (let i = 0; i < spr.length - 2; i++) {
		crc ^= spr[i]
		for (let bit = 0; bit < 8; bit++) {
			crc = crc & 1 ? (crc >> 1) ^ 0xa001 : crc >> 1
		}
	}
	spr.writeUInt16LE(crc & 0xffff, spr.length - 2)

	const parsed = parseSPR(spr)
	assert.equal(parsed.success, true)
	assert.equal(parsed.command, SnapshotCmd.GetDatabase)
	assert.deepEqual(parsed.payload, { count: 1 })
})

test('parses priority patch state from 0x2B offset 666', () => {
	const data = Buffer.alloc(1024)
	for (let i = 0; i < 24; i++) data[666 + i] = i
	const parsed = parsePriorityPatchState(data)
	assert.deepEqual(
		parsed.inputDsp,
		Array.from({ length: 16 }, (_, i) => i),
	)
	assert.deepEqual(
		parsed.auxMixer,
		Array.from({ length: 8 }, (_, i) => i + 16),
	)
})

test('coalesces fragmented legacy 1024-byte response', async () => {
	const messages = []
	const acc = new MessageAccumulator(
		(data) => messages.push(data),
		() => undefined,
	)
	const data = Buffer.alloc(1024, 0xaa)
	acc.feed(data.subarray(0, 500))
	await sleep(5)
	acc.feed(data.subarray(500))
	await sleep(50)
	assert.equal(messages.length, 1)
	assert.equal(messages[0].length, 1024)
})

test('decodes known VU float32 packet and flags unknown short packet', () => {
	const listener = new VuListener()
	const packet = Buffer.alloc(2 + 32 * 4)
	for (let i = 0; i < 32; i++) packet.writeFloatLE(i / 10, 2 + i * 4)
	const decoded = listener.decodeVu(packet)
	assert.equal(decoded.format, 'float32-le-header2')
	assert.equal(decoded.inputDsp.length, 16)
	assert.equal(decoded.outputDsp.length, 16)
	assert.equal(decoded.inputDsp[1].toFixed(1), '0.1')

	const unknown = listener.decodeVu(Buffer.from('01020304', 'hex'))
	assert.equal(unknown.format, 'unknown')
})
