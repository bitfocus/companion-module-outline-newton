/* eslint-disable n/no-unpublished-import */
import assert from 'node:assert/strict'
import dgram from 'node:dgram'
import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { ChannelType, SnapshotCmd } from '../dist/protocol/constants.js'
import {
	buildDelayCommand,
	buildFaderCommand,
	buildGainCommand,
	buildGetClockCommand,
	buildImportAudioPresetCommand,
	buildReadPriorityListCommand,
	buildRearmClockCommand,
	buildRearmPriorityCommand,
	buildSPC,
	buildSnapshotGetDatabase,
} from '../dist/protocol/command-builder.js'
import {
	MessageAccumulator,
	PRESET_AUDIO_RESPONSE_LENGTH,
	isFirmwareAtLeast,
	parseClockSelected,
	parseClockStateResponse,
	parseLegacyResponse,
	parsePresetAudioGains,
	parsePriorityListResponse,
	parsePriorityPatchState,
	parseSPR,
} from '../dist/protocol/command-parser.js'
import { verifyCrc16 } from '../dist/protocol/crc16.js'
import { NewtonTcpClient } from '../dist/protocol/tcp-client.js'
import { appendCrc16 } from '../dist/protocol/crc16.js'
import { decodeStatusMeters, VuListener } from '../dist/protocol/vu-listener.js'
import { UpgradeScripts } from '../dist/upgrades.js'
import { getFeedbackDefinitions } from '../dist/feedbacks.js'
import { getActionDefinitions } from '../dist/actions.js'
import { getVariableDefinitions } from '../dist/variables.js'
import { SETTINGS, getConfigFields, getInteractivityProfile, normalizeInteractivity } from '../dist/config.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

class FakeSocket extends EventEmitter {
	isConnected = true
	destroyed = false
	sent = []
	constructor(sendImplementation = () => Promise.resolve(true)) {
		super()
		this.sendImplementation = sendImplementation
	}
	sendImplementation
	send(data) {
		this.sent.push(Buffer.from(data))
		return this.sendImplementation(data)
	}
	destroy() {
		this.destroyed = true
		this.isConnected = false
	}
}

function buildSpr(command, payload = {}) {
	const payloadBytes = Buffer.from(JSON.stringify(payload))
	const frame = Buffer.alloc(8 + payloadBytes.length + 2)
	frame[0] = 0xf1
	frame[1] = 0
	frame.writeUInt16BE(command, 2)
	frame.writeUInt16BE(frame.length, 4)
	frame.writeUInt16BE(0x3300, 6)
	payloadBytes.copy(frame, 8)
	appendCrc16(frame)
	return frame
}

test('builds gain command with little-endian int32 and float32', () => {
	const cmd = buildGainCommand({
		channelType: ChannelType.InputDsp,
		channelIndex: 0,
		gainDb: -6,
		mute: false,
	})
	assert.equal(cmd.toString('hex'), '0100000000000000c0c000')
})

test('shows action feedback only for the matching last action result', () => {
	const state = { lastActionName: 'Set Gain', lastActionStatus: 'unknown' }
	const definitions = getFeedbackDefinitions(() => state)
	const success = definitions.last_action_success
	const error = definitions.last_action_error
	const matching = { options: { actionName: 'Set Gain' } }

	assert.equal(success.callback(matching), false)
	assert.equal(error.callback(matching), false)

	state.lastActionStatus = 'success'
	assert.equal(success.callback(matching), true)
	assert.equal(error.callback(matching), false)

	state.lastActionName = 'Set Delay'
	assert.equal(success.callback(matching), false)
	assert.equal(success.callback({ options: { actionName: '' } }), true)

	state.lastActionName = 'Set Gain'
	state.lastActionStatus = 'error'
	assert.equal(success.callback(matching), false)
	assert.equal(error.callback(matching), true)
})

test('keeps action-result colors independent for two controls using the same action', () => {
	const state = {
		lastActionName: 'Set Gain',
		lastActionStatus: 'success',
		lastActionResults: new Map([
			['button-green', { name: 'Set Gain', success: true, responseHex: '3300', controlId: 'button-green' }],
			[
				'button-red',
				{
					name: 'Set Gain',
					success: false,
					responseHex: '6600',
					error: 'device returned an error',
					controlId: 'button-red',
				},
			],
		]),
	}
	const definitions = getFeedbackDefinitions(() => state)
	const options = { actionName: 'Set Gain' }

	assert.equal(definitions.last_action_success.callback({ controlId: 'button-green', options }), true)
	assert.equal(definitions.last_action_error.callback({ controlId: 'button-green', options }), false)
	assert.equal(definitions.last_action_success.callback({ controlId: 'button-red', options }), false)
	assert.equal(definitions.last_action_error.callback({ controlId: 'button-red', options }), true)
	// A control with no result must not inherit the global result from another button.
	assert.equal(definitions.last_action_success.callback({ controlId: 'button-new', options }), false)
})

test('maps the Newton legacy ACK to green and a non-ACK to red', async () => {
	const reports = []
	const logger = { log: () => undefined, reportActionResult: (result) => reports.push(result) }
	const action = {
		controlId: 'gain-button',
		options: { channelType: ChannelType.InputDsp, channelIndex: 0, gainDb: -20, mute: false },
	}

	const successfulClient = {
		sendCommandExpect: async () => ({ success: true, rx: Buffer.from('3300', 'hex') }),
	}
	await getActionDefinitions(successfulClient, logger).set_gain.callback(action)
	assert.deepEqual(reports.at(-1), {
		name: 'Set Gain',
		success: true,
		responseHex: '3300',
		error: undefined,
		controlId: 'gain-button',
	})

	const failingClient = {
		sendCommandExpect: async () => ({
			success: false,
			rx: Buffer.from('6600', 'hex'),
			error: 'device returned an error',
		}),
	}
	await getActionDefinitions(failingClient, logger).set_gain.callback(action)
	assert.deepEqual(reports.at(-1), {
		name: 'Set Gain',
		success: false,
		responseHex: '6600',
		error: 'device returned an error',
		controlId: 'gain-button',
	})
})

test('restored snapshot database action sends Get Database and reports its control', async () => {
	const sent = []
	const reports = []
	const reply = buildSpr(SnapshotCmd.GetDatabase, { snaplist: [] })
	const client = {
		sendCommandExpect: async (cmd) => {
			sent.push(Buffer.from(cmd))
			return { success: true, rx: reply }
		},
	}
	const logger = { log: () => undefined, reportActionResult: (result) => reports.push(result) }
	const actions = getActionDefinitions(client, logger)

	await actions.snapshot_get_database.callback({ controlId: 'snapshot-button', options: {} })

	assert.deepEqual(sent, [buildSnapshotGetDatabase()])
	assert.equal(reports.at(-1).name, 'Refresh Snapshot Database')
	assert.equal(reports.at(-1).success, true)
	assert.equal(reports.at(-1).controlId, 'snapshot-button')

	const loadedEmpty = getActionDefinitions(
		client,
		logger,
		new Map(),
		new Map(),
		[],
		new Map(),
		new Map(),
		() => undefined,
		() => false,
		() => true,
	)
	const choices = loadedEmpty.snapshot_apply_selected.options.find((option) => option.id === 'uuid').choices
	assert.equal(choices[0].label, 'No snapshots on device')
})

test('uses the documented ChannelType mapping', () => {
	assert.deepEqual(
		{
			input: ChannelType.InputDsp,
			output: ChannelType.OutputDsp,
			aux: ChannelType.AuxMixer,
			matrix: ChannelType.MatrixMixer,
			trimmer: ChannelType.Trimmer,
			outputGroup: ChannelType.OutputGroup,
		},
		{ input: 0, output: 1, aux: 2, matrix: 3, trimmer: 4, outputGroup: 5 },
	)
})

test('offers named interactivity profiles and normalizes old configurations to Medium', () => {
	assert.deepEqual(getInteractivityProfile('low'), {
		meterPollInterval: 1000,
		presetAudioPollInterval: 5000,
	})
	assert.deepEqual(getInteractivityProfile('medium'), {
		meterPollInterval: 200,
		presetAudioPollInterval: 2000,
	})
	assert.deepEqual(getInteractivityProfile('high'), {
		meterPollInterval: 80,
		presetAudioPollInterval: 1000,
	})
	assert.equal(SETTINGS.priorityMetadataPollInterval, 1000)
	assert.equal(normalizeInteractivity('unexpected'), 'medium')

	const field = getConfigFields().find((entry) => entry.id === 'interactivity')
	assert.deepEqual(
		field.choices.map((choice) => ({ id: choice.id, label: choice.label })),
		[
			{ id: 'low', label: 'Low' },
			{ id: 'medium', label: 'Medium' },
			{ id: 'high', label: 'High' },
		],
	)
})

test('builds Delay as 11 bytes with sample count and bypass', () => {
	assert.equal(
		buildDelayCommand({
			channelType: ChannelType.InputDsp,
			channelIndex: 1,
			delaySamples: 600,
			bypass: true,
		}).toString('hex'),
		'0200010000005802000001',
	)
})

test('builds the 66-byte Fader command without a count byte', () => {
	const gains = Array.from({ length: 16 }, (_, index) => index / 10)
	const command = buildFaderCommand({ channelType: ChannelType.InputDsp, gains })
	assert.equal(command.length, 66)
	assert.equal(command.subarray(0, 2).toString('hex'), '1d00')
	assert.equal(command.readFloatLE(2).toFixed(1), '0.0')
	assert.equal(command.readFloatLE(62).toFixed(1), '1.5')
	assert.throws(() => buildFaderCommand({ channelType: ChannelType.InputDsp, gains: [0] }))
})

test('builds documented H2L priority read and read-modify-write rearm packets', () => {
	assert.equal(buildReadPriorityListCommand(7).toString('hex'), '91336607')
	assert.equal(
		buildRearmPriorityCommand(7, { sources: [8, 0, 216, 216], isForced: false, forcedChannel: 0 }, 2).toString('hex'),
		'903366070800d8d800000102',
	)
	assert.throws(() => buildRearmPriorityCommand(0, { sources: [1], isForced: false, forcedChannel: 0 }, 0))
})

test('parses legacy OK and ERR responses', () => {
	assert.deepEqual(parseLegacyResponse(Buffer.from('33000102', 'hex')), {
		success: true,
		command: 0x33,
		payload: Buffer.from('0102', 'hex'),
	})
	assert.equal(parseLegacyResponse(Buffer.from('6600', 'hex')).success, false)
})

test('builds and parses CRC-valid SPR JSON payload', () => {
	const spc = buildSPC(SnapshotCmd.Store, { author: 'test' })
	assert.equal(spc[0], 0xf0)
	assert.equal(verifyCrc16(spc), true)

	const spr = buildSpr(SnapshotCmd.GetDatabase, { count: 1 })
	const parsed = parseSPR(spr)
	assert.equal(parsed.success, true)
	assert.equal(parsed.command, SnapshotCmd.GetDatabase)
	assert.deepEqual(parsed.payload, { count: 1 })
	assert.throws(() => buildSPC(SnapshotCmd.Store, { description: 'x'.repeat(65528) }), /16-bit frame limit/)
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

test('parses the raw six-byte H2L response', () => {
	assert.deepEqual(parsePriorityListResponse(Buffer.from([8, 0, 216, 216, 1, 8])), {
		sources: [8, 0, 216, 216],
		isForced: true,
		forcedChannel: 8,
	})
})

test('fixed legacy framing reassembles a fragmented 1024-byte status frame even with a long gap', async () => {
	const messages = []
	const acc = new MessageAccumulator(
		(data) => messages.push(data),
		() => undefined,
	)
	acc.setResponseFraming('legacyFixedLength', 1024)
	const data = Buffer.alloc(1024, 0xaa)
	data[0] = 0xf1 // Raw status data must not be misidentified as SPR.
	acc.feed(data.subarray(0, 500))
	await sleep(50)
	acc.feed(data.subarray(500))
	assert.equal(messages.length, 1)
	assert.deepEqual(messages[0], data)
})

test('SPR framing discards malformed prefixes and waits for a CRC-valid frame', () => {
	const messages = []
	const acc = new MessageAccumulator(
		() => undefined,
		(data) => messages.push(data),
	)
	acc.setResponseFraming('spr')
	const valid = buildSpr(SnapshotCmd.Store, { ok: true })
	acc.feed(Buffer.concat([Buffer.from([0xf1, 0, 0, 1, 0, 0]), valid]))
	assert.equal(messages.length, 1)
	assert.deepEqual(messages[0], valid)
})

test('accumulator drops an over-limit stream and recovers for the next legacy response', async () => {
	const messages = []
	const acc = new MessageAccumulator(
		(data) => messages.push(data),
		() => undefined,
	)
	for (let i = 0; i < 65; i++) acc.feed(Buffer.alloc(1024, 0xaa))
	await sleep(40)
	assert.equal(messages.length, 0)
	acc.feed(Buffer.from('3300', 'hex'))
	await sleep(40)
	assert.deepEqual(messages, [Buffer.from('3300', 'hex')])
})

test('decodes documented 1024-byte VU status peak and RMS meters as dB', () => {
	const packet = Buffer.alloc(1024)
	packet.writeFloatLE(1, 0) // input peak ch1
	packet.writeFloatLE(0.1, 4) // input peak ch2
	packet.writeFloatLE(0.5, 192) // output peak ch1
	packet.writeFloatLE(0.1, 128) // input RMS ch1
	packet.writeFloatLE(0.01, 320) // output RMS ch1
	const decoded = decodeStatusMeters(packet)
	assert.equal(decoded.format, 'status-1024-peak-db')
	assert.equal(decoded.inputDsp[0], 0)
	assert.equal(decoded.inputDsp[1].toFixed(2), '-20.00')
	assert.equal(decoded.outputDsp[0].toFixed(2), '-6.02')
	assert.equal(decoded.inputDsp[2], -144)
	assert.equal(decoded.inputDspRms[0].toFixed(2), '-20.00')
	assert.equal(decoded.outputDspRms[0].toFixed(2), '-40.00')
	assert.equal(decoded.inputDspRms[1], -144)
	assert.equal(decodeStatusMeters(Buffer.alloc(16)), null)
})

test('VU poller queries Newton UDP port 6667 from an OS-chosen local port', async () => {
	const server = dgram.createSocket('udp4')
	await new Promise((resolve, reject) => server.bind(0, '127.0.0.1', (error) => (error ? reject(error) : resolve())))
	const port = server.address().port
	let sourcePort
	const responseSent = new Promise((resolve, reject) => {
		server.once('message', (request, rinfo) => {
			try {
				assert.equal(request.toString('hex'), '2b3366')
				sourcePort = rinfo.port
			} catch (error) {
				reject(error)
				return
			}
			const packet = Buffer.alloc(1024)
			packet.writeFloatLE(1, 0)
			server.send(packet, rinfo.port, rinfo.address, (error) => (error ? reject(error) : resolve()))
		})
	})
	const listener = new VuListener('127.0.0.1', port, 1000)
	const levelsReceived = new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error('UDP meter response was not received')), 1000)
		listener.once('vuLevels', (levels) => {
			clearTimeout(timer)
			resolve(levels)
		})
		listener.once('error', (error) => {
			clearTimeout(timer)
			reject(error)
		})
	})

	try {
		listener.start()
		const [levels] = await Promise.all([levelsReceived, responseSent])
		assert.equal(levels.inputDsp[0], 0)
		assert.notEqual(sourcePort, port)
	} finally {
		listener.stop()
		await new Promise((resolve) => server.close(resolve))
	}
})

test('VU poller uses UDP 6667 with an ephemeral local port and does not use TCP status polling', async () => {
	const [source, mainSource] = await Promise.all([
		readFile(new URL('../src/protocol/vu-listener.ts', import.meta.url), 'utf8'),
		readFile(new URL('../src/main.ts', import.meta.url), 'utf8'),
	])
	assert.match(source, /new UDPHelper\(this\.host, this\.port\)/)
	assert.doesNotMatch(source, /new UDPHelper\(this\.host, this\.port,\s*\{/)
	assert.match(source, /socket\.send\(buildImportSignalsCommand\(\)\)/)
	assert.match(source, /const EXPIRY_MS = 3000/)
	assert.doesNotMatch(mainSource, /buildImportSignalsCommand/)
	assert.match(mainSource, /buildImportAudioPresetCommand/)
	assert.match(mainSource, /const interactivityChanged = this\.config\.interactivity !== nextInteractivity/)
	assert.match(mainSource, /if \(targetChanged \|\| interactivityChanged\) this\.stopVuListener\(\)/)
	assert.match(
		mainSource,
		/if \(targetChanged \|\| interactivityChanged \|\| !this\.vuListener\) this\.startVuListener\(\)/,
	)
})

test('does not let an unexpected SPR command resolve the active SPC request', async () => {
	const socket = new FakeSocket()
	const client = new NewtonTcpClient('newton', 6668, () => socket)
	client.connect()
	socket.emit('connect')
	const request = client.sendCommandExpect(buildSPC(SnapshotCmd.Store), { timeoutMs: 100 })
	await sleep(0)
	socket.emit('data', buildSpr(SnapshotCmd.GetDatabase, { count: 1 }))
	await sleep(5)
	socket.emit('data', buildSpr(SnapshotCmd.Store, { ok: true }))
	const result = await request
	assert.equal(result.success, true)
	assert.equal(parseSPR(result.rx).command, SnapshotCmd.Store)
	client.destroy()
})

test('timeout destroys the session and rejects queued commands before reconnecting', async () => {
	const sockets = []
	const client = new NewtonTcpClient('newton', 6668, () => {
		const socket = new FakeSocket()
		sockets.push(socket)
		return socket
	})
	client.connect()
	sockets[0].emit('connect')
	const first = client.sendCommandExpect(Buffer.from('0100', 'hex'), { name: 'first', timeoutMs: 10 })
	const queued = client.sendCommandExpect(Buffer.from('0200', 'hex'), { name: 'queued', timeoutMs: 100 })
	await assert.rejects(first, /first timeout/)
	await assert.rejects(queued, /first timeout/)
	assert.equal(sockets[0].destroyed, true)
	assert.equal(sockets.length, 2)

	// A late frame on the old socket is ignored. A fresh command works only on
	// the freshly connected session.
	sockets[0].emit('data', Buffer.from('3300', 'hex'))
	sockets[1].emit('connect')
	const fresh = client.sendCommandExpect(Buffer.from('0300', 'hex'), { timeoutMs: 100 })
	await sleep(0)
	sockets[1].emit('data', Buffer.from('3300', 'hex'))
	assert.equal((await fresh).success, true)
	client.destroy()
})

test('a late send rejection cannot reject the next active command', async () => {
	let rejectFirstSend
	let sendCount = 0
	const socket = new FakeSocket(() => {
		sendCount++
		if (sendCount === 1) {
			return new Promise((_resolve, reject) => {
				rejectFirstSend = reject
			})
		}
		return Promise.resolve(true)
	})
	const client = new NewtonTcpClient('newton', 6668, () => socket)
	client.connect()
	socket.emit('connect')
	const first = client.sendCommandExpect(Buffer.from('0100', 'hex'), { timeoutMs: 100 })
	await sleep(0)
	socket.emit('data', Buffer.from('3300', 'hex'))
	assert.equal((await first).success, true)

	const second = client.sendCommandExpect(Buffer.from('0200', 'hex'), { timeoutMs: 100 })
	await sleep(0)
	assert.equal(sendCount, 2)
	rejectFirstSend(new Error('late send failure'))
	socket.emit('data', Buffer.from('3300', 'hex'))
	assert.equal((await second).success, true)
	client.destroy()
})

test('upgrade retains legacy mute ids and migrates generated priority presets safely', () => {
	const result = UpgradeScripts[0](
		{ currentConfig: {} },
		{
			config: { priorityMonitorChannelType: 6, vuMonitorChannelType: 6 },
			actions: [
				{ id: 'a', controlId: 'c', actionId: 'set_mute', options: {} },
				{ id: 'b', controlId: 'c', actionId: 'rearm_priority', options: { channelType: 0, channelIndex: 3 } },
			],
			feedbacks: [
				{
					id: 'f',
					controlId: 'c',
					feedbackId: 'priority_overridden',
					options: { channelType: 0, patchIndex: 3, highestSource: 3 },
					isInverted: false,
				},
			],
		},
	)
	assert.equal(result.updatedConfig, null)
	assert.equal(result.updatedActions[0].actionId, 'legacy_unsafe_action')
	assert.deepEqual(result.updatedActions[1].options, { channelIndex: 3, rearmIndex: 0 })
	assert.equal(result.updatedFeedbacks[0].options.highestSource, 11)
})

test('upgrade blocks every removed 0.2 action instead of leaving an orphaned action id', () => {
	const removed = [
		'change_preset',
		'store_preset',
		'set_polarity',
		'set_matrix',
		'snapshot_apply',
		'snapshot_store',
		'snapshot_delete',
		'rearm_all_input_priority',
		'rearm_all_aux_priority',
	]
	const result = UpgradeScripts[0](
		{ currentConfig: {} },
		{
			config: null,
			actions: removed.map((actionId, index) => ({ id: String(index), controlId: 'c', actionId, options: {} })),
			feedbacks: [],
		},
	)
	assert.equal(result.updatedActions.length, removed.length)
	assert.ok(result.updatedActions.every((action) => action.actionId === 'legacy_unsafe_action'))
	assert.ok(
		result.updatedActions.every(
			(action) => typeof action.options.reason === 'string' && action.options.reason.length > 0,
		),
	)
})

test('upgrade preserves the restored snapshot database action id', () => {
	const result = UpgradeScripts[0](
		{ currentConfig: {} },
		{
			config: null,
			actions: [{ id: 'snapshot-refresh', controlId: 'c', actionId: 'snapshot_get_database', options: {} }],
			feedbacks: [],
		},
	)
	assert.equal(result.updatedActions[0].actionId, 'snapshot_get_database')
})

test('upgrade strips stored legacy config fields down to the device IP', () => {
	const stripConfig = UpgradeScripts[1]
	const result = stripConfig(
		{ currentConfig: {} },
		{
			config: { host: '192.168.2.30', port: 9999, commandTimeoutMs: 0, priorityPollInterval: 0, vuPort: 0 },
			actions: [],
			feedbacks: [],
		},
	)
	assert.deepEqual(result.updatedConfig, { host: '192.168.2.30', interactivity: 'medium' })

	const noConfig = stripConfig({ currentConfig: {} }, { config: null, actions: [], feedbacks: [] })
	assert.equal(noConfig.updatedConfig, null)
})

test('upgrade shifts priority input numbering from 0-based to 1-based', () => {
	const renumber = UpgradeScripts[2]
	const result = renumber(
		{ currentConfig: {} },
		{
			config: null,
			actions: [
				{ id: 'a', controlId: 'c', actionId: 'rearm_priority', options: { channelIndex: 3, rearmIndex: 0 } },
				{ id: 'b', controlId: 'c', actionId: 'read_priority_list', options: { channelIndex: 0 } },
				{ id: 'c', controlId: 'c', actionId: 'change_preset', options: { preset: 2 } },
			],
			feedbacks: [
				{
					id: 'f',
					controlId: 'c',
					feedbackId: 'priority_overridden',
					options: { channelType: 0, patchIndex: 3, highestSource: 11 },
					isInverted: false,
				},
				{
					id: 'g',
					controlId: 'c',
					feedbackId: 'connection_status',
					options: {},
					isInverted: false,
				},
			],
		},
	)
	assert.deepEqual(
		result.updatedActions.map((a) => a.options),
		[{ channelIndex: 4, rearmIndex: 0 }, { channelIndex: 1 }],
	)
	assert.deepEqual(
		result.updatedFeedbacks.map((f) => f.options),
		[{ channelType: 0, patchIndex: 4, highestSource: 11 }],
	)
})

test('upgrade drops manual expected-source options from priority feedbacks', () => {
	const strip = UpgradeScripts[3]
	const result = strip(
		{ currentConfig: {} },
		{
			config: null,
			actions: [],
			feedbacks: [
				{
					id: 'f',
					controlId: 'c',
					feedbackId: 'priority_overridden',
					options: { channelType: 0, patchIndex: 4, highestSource: 11 },
					isInverted: false,
				},
				{
					id: 'g',
					controlId: 'c',
					feedbackId: 'priority_active_source',
					options: { channelType: 2, patchIndex: 3, expectedSource: 2 },
					isInverted: false,
				},
			],
		},
	)
	assert.deepEqual(
		result.updatedFeedbacks.map((f) => f.options),
		[{ patchIndex: 4 }, { patchIndex: 0 }],
	)
})

test('input patch monitor feedback writes the label and colors from device state', () => {
	const state = {
		priorityInputDsp: [9, 5],
		priorityLists: [
			{ sources: [9, 1, 216, 216], isForced: false, forcedChannel: 0 },
			{ sources: [9, 5, 216, 216], isForced: false, forcedChannel: 0 },
		],
	}
	const monitor = getFeedbackDefinitions(() => state).input_patch_monitor

	const green = monitor.callback({ options: { patchIndex: 1 } })
	assert.equal(green.text, 'IN 1')
	assert.ok(green.bgcolor !== undefined)

	const orange = monitor.callback({ options: { patchIndex: 2 } })
	assert.equal(orange.text, 'IN 2')
	assert.notEqual(orange.bgcolor, green.bgcolor)

	// No channel list yet for input 3: label only, neutral colors.
	assert.deepEqual(monitor.callback({ options: { patchIndex: 3 } }), { text: 'IN 3' })
})

test('upgrade converts styled boolean priority feedbacks to the advanced monitor', () => {
	const convert = UpgradeScripts[4]
	const result = convert(
		{ currentConfig: {} },
		{
			config: null,
			actions: [],
			feedbacks: [
				{ id: 'f', controlId: 'c', feedbackId: 'priority_overridden', options: { patchIndex: 4 }, isInverted: false },
				{ id: 'g', controlId: 'c', feedbackId: 'priority_backup_active', options: {}, isInverted: false },
				{ id: 'h', controlId: 'c', feedbackId: 'connection_status', options: {}, isInverted: false },
			],
		},
	)
	assert.deepEqual(
		result.updatedFeedbacks.map((f) => ({ feedbackId: f.feedbackId, options: f.options })),
		[
			{ feedbackId: 'input_patch_monitor', options: { patchIndex: 4 } },
			{ feedbackId: 'input_patch_monitor', options: { patchIndex: 1 } },
		],
	)
})

test('upgrade strips the removed rearm slot option from stored actions', () => {
	const strip = UpgradeScripts[5]
	const result = strip(
		{ currentConfig: {} },
		{
			config: null,
			actions: [
				{ id: 'a', controlId: 'c', actionId: 'rearm_priority', options: { channelIndex: 3, rearmIndex: 2 } },
				{ id: 'b', controlId: 'c', actionId: 'rearm_priority', options: { channelIndex: 5 } },
			],
			feedbacks: [],
		},
	)
	assert.deepEqual(
		result.updatedActions.map((a) => a.options),
		[{ channelIndex: 3 }],
	)
})

test('rearm-this-input action targets the input registered by the label feedback', async () => {
	const rearmTargets = new Map()
	const label = getFeedbackDefinitions(() => ({}), rearmTargets).input_patch_rearm_label

	assert.deepEqual(label.callback({ controlId: 'ctrl1', options: { patchIndex: 5 } }), { text: 'REARM\nIN 5' })
	assert.equal(rearmTargets.get('ctrl1'), 5)

	const sent = []
	const client = {
		sendCommandExpect: async (cmd, opts = {}) => {
			sent.push(Buffer.from(cmd).toString('hex'))
			const rx = cmd[0] === 0x91 ? Buffer.from([8, 0, 216, 216, 0, 0]) : Buffer.from('3300', 'hex')
			return { success: true, rx, parsed: opts.parser ? opts.parser(rx) : undefined }
		},
	}
	const logger = { log: () => undefined, reportActionResult: () => undefined }
	const actions = getActionDefinitions(client, logger, rearmTargets)

	await actions.rearm_this_input.callback({ controlId: 'ctrl1', options: {} })
	assert.equal(sent[0], '91336604')
	assert.equal(sent[1], '903366040800d8d800000100')

	// Without a label feedback on the control the action must not send anything.
	sent.length = 0
	await actions.rearm_this_input.callback({ controlId: 'ctrl-unknown', options: {} })
	assert.deepEqual(sent, [])

	label.unsubscribe({ controlId: 'ctrl1', options: { patchIndex: 5 } })
	assert.equal(rearmTargets.has('ctrl1'), false)
})

test('meter feedback draws the half-width bar, vertical label and binary signal strip', () => {
	const WIDTH = 20
	const HEIGHT = 72
	const px = (buf, x, y) => [...buf.slice((y * WIDTH + x) * 4, (y * WIDTH + x) * 4 + 4)]
	const render = (db, options = { meterType: 0, meterMode: 'peak', channel: 1 }) =>
		getFeedbackDefinitions(() => ({
			vuInputDsp: [db],
			vuOutputDsp: [db],
			vuInputDspRms: [db],
			vuOutputDspRms: [db],
		})).meter.callback({
			options,
			image: { width: WIDTH, height: HEIGHT },
		})

	// 0 dB → bar fully lit: alarm red at the top (bar starts at x=2 with a
	// margin), LED segment gap every 4th row, blue signal strip at the bottom.
	const full = render(0)
	assert.equal(full.imageBuffer.length, WIDTH * HEIGHT * 4)
	assert.deepEqual(px(full.imageBuffer, 2, 0), [255, 0, 0, 255])
	assert.deepEqual(px(full.imageBuffer, 2, 3), [0, 0, 0, 255]) // segment gap row
	assert.deepEqual(px(full.imageBuffer, 0, 0), [0, 0, 0, 255]) // left margin
	assert.deepEqual(px(full.imageBuffer, 2, HEIGHT - 1), [0, 90, 255, 255])

	// -30 dB → top of the zone shows the dimmed track, lower zone lit green,
	// strip fully lit.
	const half = render(-30)
	assert.deepEqual(px(half.imageBuffer, 2, 0), [41, 0, 0, 255]) // dim red track
	assert.equal(px(half.imageBuffer, 2, 58)[1], 255) // lit green near the bottom
	assert.deepEqual(px(half.imageBuffer, 2, HEIGHT - 1), [0, 90, 255, 255])

	// Between -60 and -40 → only the signal LED lights, the bar stays on the
	// dim track (fraction 0 below the -40 dB bar floor).
	const signalOnly = render(-50)
	assert.deepEqual(px(signalOnly.imageBuffer, 2, 0), [41, 0, 0, 255])
	assert.ok(px(signalOnly.imageBuffer, 2, 58)[1] < 255) // no lit green rows
	assert.deepEqual(px(signalOnly.imageBuffer, 2, HEIGHT - 1), [0, 90, 255, 255])

	// Below the -60 dB signal threshold → whole bar shows only the dim track,
	// signal strip dim too (visible scale, nothing lit).
	const silent = render(-70)
	assert.deepEqual(px(silent.imageBuffer, 2, 0), [41, 0, 0, 255])
	assert.deepEqual(px(silent.imageBuffer, 2, HEIGHT - 1), [0, 14, 41, 255])

	// The right column carries the white label pixels (VU + channel).
	const hasWhite = (buf) => {
		for (let y = 0; y < HEIGHT; y++) {
			for (let x = WIDTH / 2; x < WIDTH; x++) {
				const [r, g, b] = px(buf, x, y)
				if (r === 255 && g === 255 && b === 255) return true
			}
		}
		return false
	}
	assert.ok(hasWhite(full.imageBuffer))
	assert.ok(hasWhite(render(-70, { meterType: 1, meterMode: 'peak', channel: 13 }).imageBuffer))
})

test('builds clock get/rearm packets and parses the 19-byte clock state', () => {
	assert.equal(buildGetClockCommand(1).toString('hex'), '81336601')

	const reply = Buffer.from([2, 3, 4, 5, 6, 7, 8, 9, 10, 13, 12, 11, 14, 0, 1, 15, 1, 2, 0])
	const parsed = parseClockStateResponse(reply)
	assert.deepEqual(parsed.list, [2, 3, 4, 5, 6, 7, 8, 9, 10, 13, 12, 11, 14, 0, 1, 15])
	assert.equal(parsed.isForced, true)
	assert.equal(parsed.forcedIndex, 2)
	assert.equal(parsed.is48, false)
	assert.equal(parseClockStateResponse(Buffer.alloc(4)), null)

	// Rearm preserves the list, converts the forced index to a Clock List value
	// and sets isRearm=1 slot 0.
	const rearm = buildRearmClockCommand(0, parsed, 0)
	assert.equal(rearm.length, 25)
	assert.equal(
		rearm.toString('hex'),
		'80336600' + '02030405060708090a0d0c0b0e00010f' + '01' + '04' + '00' + '01' + '00',
	)

	// Selected clocks come from blob bytes 631/648/665.
	const blob = Buffer.alloc(1024)
	blob[631] = 2
	blob[648] = 3
	blob[665] = 15
	assert.deepEqual(parseClockSelected(blob), [2, 3, 15])
})

test('clock monitor feedback labels the clock and colors from list vs selected', () => {
	const state = {
		clockSelected: [2, 4, -1],
		clockLists: [
			{ list: [2, 3, 4, 5, 6, 7, 8, 9, 10, 13, 12, 11, 14, 0, 1, 15], isForced: false, forcedIndex: 0, is48: false },
			{ list: [2, 3, 4, 5, 6, 7, 8, 9, 10, 13, 12, 11, 14, 0, 1, 15], isForced: false, forcedIndex: 0, is48: false },
			null,
		],
	}
	const monitor = getFeedbackDefinitions(() => state).clock_monitor

	// Master on its first clock (WC=2) → green, label shows source name.
	const green = monitor.callback({ options: { clockType: 0 } })
	assert.equal(green.text, 'MCLK\nWC')
	assert.ok(green.bgcolor !== undefined)

	// WC Out 1 fell back (selected 4 != first 2) → orange.
	const orange = monitor.callback({ options: { clockType: 1 } })
	assert.equal(orange.text, 'WCK 1\nAES 3-4')
	assert.notEqual(orange.bgcolor, green.bgcolor)

	// WC Out 2 unknown → neutral label only.
	assert.deepEqual(monitor.callback({ options: { clockType: 2 } }), { text: 'WCK 2\n--' })
})

test('rearm-this-clock action targets the clock registered by the label feedback', async () => {
	const clockRearmTargets = new Map()
	const label = getFeedbackDefinitions(() => ({}), new Map(), new Map(), clockRearmTargets).clock_rearm_label
	assert.deepEqual(label.callback({ controlId: 'c1', options: { clockType: 2 } }), { text: 'REARM\nWCK 2' })
	assert.equal(clockRearmTargets.get('c1'), 2)

	const sent = []
	const client = {
		sendCommandExpect: async (cmd, opts = {}) => {
			sent.push(Buffer.from(cmd).toString('hex'))
			const rx =
				cmd[0] === 0x81
					? Buffer.from([2, 3, 4, 5, 6, 7, 8, 9, 10, 13, 12, 11, 14, 0, 1, 15, 0, 0, 1])
					: Buffer.from('3300', 'hex')
			return { success: true, rx, parsed: opts.parser ? opts.parser(rx) : undefined }
		},
	}
	const logger = { log: () => undefined, reportActionResult: () => undefined }
	const actions = getActionDefinitions(client, logger, new Map(), clockRearmTargets)

	await actions.rearm_this_clock.callback({ controlId: 'c1', options: {} })
	assert.equal(sent[0], '81336602')
	// Not forced → forced value 0; is48 preserved; isRearm 1 slot 0.
	assert.equal(sent[1], '80336602' + '02030405060708090a0d0c0b0e00010f' + '00' + '00' + '01' + '01' + '00')

	sent.length = 0
	await actions.rearm_this_clock.callback({ controlId: 'c-unknown', options: {} })
	assert.deepEqual(sent, [])
})

test('snapshot apply by name uses the device list for the dropdown and applies by uuid', async () => {
	const snapshotList = [
		{ uuid: '00000034-40c8-6d88-8c0b-59899f12d260', name: 'Show opening' },
		{ uuid: '00000034-414a-6780-9012-94668ffac841', name: 'Interval' },
	]
	const sent = []
	const client = {
		sendCommandExpect: async (cmd) => {
			sent.push(Buffer.from(cmd))
			return { success: true, rx: Buffer.alloc(0) }
		},
	}
	const logger = { log: () => undefined, reportActionResult: () => undefined }
	const actions = getActionDefinitions(client, logger, new Map(), new Map(), snapshotList)

	// The dropdown lists a placeholder plus one entry per device snapshot, by name.
	const choices = actions.snapshot_apply_selected.options.find((o) => o.id === 'uuid').choices
	assert.deepEqual(choices.map((c) => c.label).slice(1), ['Show opening', 'Interval'])
	assert.equal(choices[1].id, snapshotList[0].uuid)

	await actions.snapshot_apply_selected.callback({
		options: { uuid: snapshotList[1].uuid, fadingTime: 2000, mode: 'Direct' },
	})
	assert.equal(sent.length, 1)
	const payload = JSON.parse(sent[0].subarray(6, sent[0].length - 2).toString('utf-8'))
	assert.deepEqual(payload, { uuid: snapshotList[1].uuid, fading_time: 2000, mode: 'Direct' })

	// A UUID removed from the live database must not be sent just because it
	// survived in an older Companion control configuration.
	sent.length = 0
	await actions.snapshot_apply_selected.callback({
		options: { uuid: 'deleted-uuid', fadingTime: 2000, mode: 'Direct' },
	})
	assert.deepEqual(sent, [])

	// No selection → no command sent.
	sent.length = 0
	await actions.snapshot_apply_selected.callback({ options: { uuid: '', fadingTime: 2000, mode: 'Direct' } })
	assert.deepEqual(sent, [])
})

test('snapshot label feedback writes the name and feeds the apply action', async () => {
	const snapshotList = [{ uuid: '00000034-40c8-6d88-8c0b-59899f12d260', name: 'Show opening' }]
	const snapshotTargets = new Map()
	const label = getFeedbackDefinitions(
		() => ({}),
		new Map(),
		new Map(),
		new Map(),
		snapshotTargets,
		snapshotList,
	).snapshot_apply_label

	// The dropdown lists the device snapshots by name.
	assert.deepEqual(label.options[0].choices.map((c) => c.id).slice(1), [snapshotList[0].uuid])

	// Selecting writes the snapshot name on the button and registers the target.
	assert.deepEqual(label.callback({ controlId: 's1', options: { uuid: snapshotList[0].uuid } }), {
		text: 'APPLY\nShow opening',
	})
	assert.equal(snapshotTargets.get('s1'), snapshotList[0].uuid)

	// No selection → placeholder text, no target.
	assert.deepEqual(label.callback({ controlId: 's2', options: { uuid: '' } }), { text: 'APPLY\n#snapshot' })
	assert.equal(snapshotTargets.has('s2'), false)

	const sent = []
	const client = {
		sendCommandExpect: async (cmd) => {
			sent.push(Buffer.from(cmd))
			return { success: true, rx: Buffer.alloc(0) }
		},
	}
	const logger = { log: () => undefined, reportActionResult: () => undefined }
	const actions = getActionDefinitions(client, logger, new Map(), new Map(), snapshotList, snapshotTargets)

	await actions.apply_this_snapshot.callback({ controlId: 's1', options: { fadingTime: 0, mode: 'ThroughZero' } })
	assert.equal(sent.length, 1)
	const payload = JSON.parse(sent[0].subarray(6, sent[0].length - 2).toString('utf-8'))
	assert.deepEqual(payload, { uuid: snapshotList[0].uuid, fading_time: 0, mode: 'ThroughZero' })

	// A button without the label feedback sends nothing.
	sent.length = 0
	await actions.apply_this_snapshot.callback({ controlId: 's-unknown', options: { fadingTime: 0, mode: 'Direct' } })
	assert.deepEqual(sent, [])
})

test('a deleted snapshot clears its button target and cannot be applied', async () => {
	const snapshotTargets = new Map([['stale-button', 'deleted-uuid']])
	const label = getFeedbackDefinitions(
		() => ({ snapshotDatabaseLoaded: true }),
		new Map(),
		new Map(),
		new Map(),
		snapshotTargets,
		[],
	).snapshot_apply_label
	assert.deepEqual(label.callback({ controlId: 'stale-button', options: { uuid: 'deleted-uuid' } }), {
		text: 'SNAPSHOT\nMISSING',
	})
	assert.equal(snapshotTargets.has('stale-button'), false)

	// Defend at action time too, in case the device list changed after the
	// feedback last rendered.
	snapshotTargets.set('stale-button', 'deleted-uuid')
	const sent = []
	const reports = []
	const actions = getActionDefinitions(
		{
			sendCommandExpect: async (cmd) => {
				sent.push(Buffer.from(cmd))
				return { success: true, rx: Buffer.alloc(0) }
			},
		},
		{ log: () => undefined, reportActionResult: (result) => reports.push(result) },
		new Map(),
		new Map(),
		[],
		snapshotTargets,
		new Map(),
		() => undefined,
		() => false,
		() => true,
	)
	await actions.apply_this_snapshot.callback({
		controlId: 'stale-button',
		options: { fadingTime: 2000, mode: 'Direct' },
	})
	assert.deepEqual(sent, [])
	assert.equal(snapshotTargets.has('stale-button'), false)
	assert.match(reports.at(-1).error, /no longer exists/)
})

test('channel gain/mute feedbacks subscribe channels and render device reads', () => {
	const state = { gainReads: new Map() }
	const gainSubs = new Map()
	const muteTargets = new Map()
	const defs = getFeedbackDefinitions(() => state, new Map(), gainSubs, new Map(), new Map(), [], muteTargets)

	// Subscribing an Output DSP channel 5 registers protocol channel 4.
	defs.channel_gain.subscribe({ id: 'g1', options: { channelType: 1, channel: 5 } })
	assert.deepEqual([...gainSubs.values()], [{ channelType: 1, channelIndex: 4 }])

	// No read yet → placeholder, GAIN-prefixed label.
	assert.deepEqual(defs.channel_gain.callback({ id: 'g1', options: { channelType: 1, channel: 5 } }), {
		text: 'GAIN OUT 5\\n--',
	})

	state.gainReads.set('1:4', { gainDb: -6, muted: false })
	assert.deepEqual(defs.channel_gain.callback({ id: 'g1', options: { channelType: 1, channel: 5 } }), {
		text: 'GAIN OUT 5\\n-6.0 dB',
	})

	// Mute feedback: MUTE-prefixed label, green OPEN / red MUTED, and it
	// registers the channel for the mute action on the same control.
	const open = defs.channel_mute.callback({ id: 'm1', controlId: 'ctrl9', options: { channelType: 1, channel: 5 } })
	assert.equal(open.text, 'TOGGLE MUTE\\nOUT 5\\nUNMUTED')
	assert.ok(open.bgcolor !== undefined)
	assert.deepEqual(muteTargets.get('ctrl9'), { channelType: 1, channelIndex: 4 })
	state.gainReads.set('1:4', { gainDb: -6, muted: true })
	const muted = defs.channel_mute.callback({ id: 'm1', controlId: 'ctrl9', options: { channelType: 1, channel: 5 } })
	assert.equal(muted.text, 'TOGGLE MUTE\\nOUT 5\\nMUTED')
	assert.notEqual(muted.bgcolor, open.bgcolor)

	// Unsubscribing stops the channel being polled and drops the mute target.
	defs.channel_gain.unsubscribe({ id: 'g1', options: {} })
	defs.channel_mute.unsubscribe({ id: 'm1', controlId: 'ctrl9', options: {} })
	assert.equal(gainSubs.size, 0)
	assert.equal(muteTargets.size, 0)
})

test('mute-this-channel toggles from the cached state preserving the gain', async () => {
	const sent = []
	const client = {
		sendCommandExpect: async (cmd) => {
			sent.push(Buffer.from(cmd))
			return { success: true, rx: Buffer.from('3300', 'hex') }
		},
	}
	const reads = []
	const logger = {
		log: () => undefined,
		reportActionResult: () => undefined,
		reportGainRead: (t, i, s) => reads.push(s),
	}
	// Cached state comes from the interactivity-controlled 0x21 audio-preset poll (no 0x01 "get").
	const gains = new Map([['1:4', { gainDb: -4.5, muted: false }]])
	const getGainRead = (t, i) => gains.get(`${t}:${i}`)
	const muteTargets = new Map([['ctrl9', { channelType: 1, channelIndex: 4 }]])
	const actions = getActionDefinitions(client, logger, new Map(), new Map(), [], new Map(), muteTargets, getGainRead)

	await actions.mute_this_channel.callback({ controlId: 'ctrl9', options: { mode: 'toggle' } })
	// One single Set Gain write; gain preserved, mute set, optimistic report.
	assert.deepEqual(
		sent.map((c) => c.length),
		[11],
	)
	assert.equal(sent[0].readFloatLE(6).toFixed(1), '-4.5')
	assert.equal(sent[0][10], 1)
	assert.equal(reads.at(-1).muted, true)

	// The poll confirms the new state; toggling again unmutes.
	gains.set('1:4', { gainDb: -4.5, muted: true })
	sent.length = 0
	await actions.mute_this_channel.callback({ controlId: 'ctrl9', options: { mode: 'toggle' } })
	assert.equal(sent[0][10], 0)

	// Unknown control or channel never read → nothing sent.
	sent.length = 0
	await actions.mute_this_channel.callback({ controlId: 'nope', options: { mode: 'toggle' } })
	gains.clear()
	await actions.mute_this_channel.callback({ controlId: 'ctrl9', options: { mode: 'toggle' } })
	assert.deepEqual(sent, [])
})

test('failed gain and mute writes do not optimistically replace the cached device state', async () => {
	const client = {
		sendCommandExpect: async () => ({ success: false, rx: Buffer.from('6600', 'hex'), error: 'device returned error' }),
	}
	const reads = []
	const logger = {
		log: () => undefined,
		reportActionResult: () => undefined,
		reportGainRead: (_type, _index, read) => reads.push(read),
	}
	const gains = new Map([['1:4', { gainDb: -4.5, muted: false }]])
	const muteTargets = new Map([['ctrl9', { channelType: 1, channelIndex: 4 }]])
	const actions = getActionDefinitions(
		client,
		logger,
		new Map(),
		new Map(),
		[],
		new Map(),
		muteTargets,
		(type, index) => gains.get(`${type}:${index}`),
	)
	await actions.mute_this_channel.callback({ controlId: 'ctrl9', options: { mode: 'toggle' } })
	await actions.adjust_gain.callback({
		options: { channelType: 1, channel: 5, direction: 'up', deltaDb: 1 },
	})
	assert.deepEqual(reads, [])
})

test('legacy mute feedback and protocol-indexed variable IDs remain available', () => {
	const defs = getFeedbackDefinitions(() => ({}))
	assert.equal(defs.mute_active.callback({ options: {} }), false)
	assert.equal('preset_active' in defs, false)

	const ids = new Set(getVariableDefinitions().map((definition) => definition.variableId))
	assert.equal(ids.has('current_preset'), false)
	// Legacy IDs are 1-based exactly as 1.0.0 published them.
	for (const id of [
		'priority_in_1',
		'priority_in_16',
		'priority_input_1',
		'priority_input_16',
		'priority_aux_1',
		'priority_aux_input_8',
		'vu_in_1',
		'vu_input_16',
		'vu_out_1',
		'vu_output_16',
	]) {
		assert.equal(ids.has(id), true, id)
	}
	assert.equal(ids.has('priority_in_0'), false)
	assert.equal(ids.has('vu_in_0'), false)
})

test('a command timeout marks the connection as lost (pulled-cable detection)', async () => {
	// Each connect() builds a fresh socket, exactly like the real TCPHelper factory.
	const sockets = []
	const events = []
	const client = new NewtonTcpClient('newton', 6668, () => {
		const socket = new FakeSocket()
		sockets.push(socket)
		return socket
	})
	client.on('disconnected', () => events.push('disconnected'))
	client.on('connected', () => events.push('connected'))
	client.connect()
	sockets.at(-1).emit('connect')
	assert.deepEqual(events, ['connected'])

	// A pulled cable produces no FIN/RST: the command just times out. The
	// client must flag the link as lost so ONLINE buttons flip immediately.
	const pending = client.sendCommandExpect(Buffer.from('0100', 'hex'), { timeoutMs: 30 })
	await assert.rejects(pending, /timeout/)
	assert.deepEqual(events, ['connected', 'disconnected'])
	assert.equal(sockets.length, 2) // old socket destroyed, a new one is retrying

	// When the device is back, the normal connected flow resumes.
	sockets.at(-1).emit('connect')
	assert.deepEqual(events, ['connected', 'disconnected', 'connected'])
	client.destroy()
})

test('reads the full 384 KiB audio preset through the tcp client pipeline', async () => {
	const socket = new FakeSocket()
	const client = new NewtonTcpClient('newton', 6668, () => socket)
	client.connect()
	socket.emit('connect')

	const pending = client.sendCommandExpect(buildImportAudioPresetCommand(), {
		timeoutMs: 2000,
		expectedLength: PRESET_AUDIO_RESPONSE_LENGTH,
		isSuccess: (data) => data.length === PRESET_AUDIO_RESPONSE_LENGTH && data[0] === 0x33,
		parser: parsePresetAudioGains,
	})
	await sleep(0)

	const response = Buffer.alloc(PRESET_AUDIO_RESPONSE_LENGTH)
	response[0] = 0x33
	response.writeFloatLE(-12, 2 + 1008) // input DSP ch1 gain
	for (let offset = 0; offset < response.length; offset += 32768) {
		socket.emit('data', response.subarray(offset, Math.min(offset + 32768, response.length)))
	}

	const result = await pending
	assert.equal(result.success, true)
	assert.deepEqual(result.parsed.inputDsp[0], { gainDb: -12, muted: false })
	client.destroy()
})

test('accumulator assembles fixed-length replies larger than the flood guard', () => {
	const messages = []
	const acc = new MessageAccumulator(
		(data) => messages.push(data),
		() => undefined,
	)
	acc.setResponseFraming('legacyFixedLength', PRESET_AUDIO_RESPONSE_LENGTH)
	const total = Buffer.alloc(PRESET_AUDIO_RESPONSE_LENGTH)
	total[0] = 0x33
	for (let offset = 0; offset < total.length; offset += 65536) {
		acc.feed(total.subarray(offset, Math.min(offset + 65536, total.length)))
	}
	assert.equal(messages.length, 1)
	assert.equal(messages[0].length, PRESET_AUDIO_RESPONSE_LENGTH)
})

test('builds the 0x21 request and parses gain/mute banks from the audio preset blob', () => {
	assert.equal(buildImportAudioPresetCommand().toString('hex'), '213366')

	const response = Buffer.alloc(PRESET_AUDIO_RESPONSE_LENGTH)
	response[0] = 0x33
	const gainBase = 2 + 1008
	// Input DSP ch1: -6 dB muted. Output DSP ch3 (entry 16+2): +3 dB open.
	response.writeFloatLE(-6, gainBase)
	response[gainBase + 4] = 1
	response.writeFloatLE(3, gainBase + (16 + 2) * 5)

	const parsed = parsePresetAudioGains(response)
	assert.deepEqual(parsed.inputDsp[0], { gainDb: -6, muted: true })
	assert.deepEqual(parsed.outputDsp[2], { gainDb: 3, muted: false })
	assert.deepEqual(parsed.inputDsp[1], { gainDb: 0, muted: false })

	// Too short or error replies parse to null.
	assert.equal(parsePresetAudioGains(Buffer.alloc(100)), null)
	const err = Buffer.alloc(PRESET_AUDIO_RESPONSE_LENGTH)
	err[0] = 0x66
	assert.equal(parsePresetAudioGains(err), null)
})

test('level up/down nudges the cached gain and writes it back', async () => {
	const sent = []
	const client = {
		sendCommandExpect: async (cmd) => {
			sent.push(Buffer.from(cmd))
			return { success: true, rx: Buffer.from('3300', 'hex') }
		},
	}
	const reads = []
	const logger = {
		log: () => undefined,
		reportActionResult: () => undefined,
		reportGainRead: (t, i, s) => reads.push(s),
	}
	// Cached state comes from the interactivity-controlled 0x21 audio-preset poll (no 0x01 "get").
	const gains = new Map([
		['1:2', { gainDb: -6, muted: false }],
		['0:0', { gainDb: 11.5, muted: false }],
	])
	const getGainRead = (t, i) => gains.get(`${t}:${i}`)
	const actions = getActionDefinitions(client, logger, new Map(), new Map(), [], new Map(), new Map(), getGainRead)

	await actions.adjust_gain.callback({
		options: { channelType: 1, channel: 3, direction: 'up', deltaDb: 2.5 },
	})
	// One single Set Gain write, no read round-trips.
	assert.deepEqual(
		sent.map((c) => c.length),
		[11],
	)
	assert.equal(sent[0][1], 1) // Output DSP
	assert.equal(sent[0].readInt32LE(2), 2) // channel 3 → protocol 2
	assert.equal(sent[0].readFloatLE(6).toFixed(1), '-3.5') // -6 + 2.5
	assert.equal(sent[0][10], 0) // mute preserved
	assert.equal(reads.at(-1).gainDb.toFixed(1), '-3.5')

	// Clamped at +6 upward.
	sent.length = 0
	await actions.adjust_gain.callback({
		options: { channelType: 0, channel: 1, direction: 'up', deltaDb: 24 },
	})
	assert.equal(sent[0].readFloatLE(6).toFixed(1), '6.0')

	// Down direction subtracts.
	sent.length = 0
	gains.set('0:0', { gainDb: -6, muted: false })
	await actions.adjust_gain.callback({
		options: { channelType: 0, channel: 1, direction: 'down', deltaDb: 1 },
	})
	assert.equal(sent[0].readFloatLE(6).toFixed(1), '-7.0')

	// Channel never read yet → refuse to write blindly.
	sent.length = 0
	await actions.adjust_gain.callback({
		options: { channelType: 0, channel: 9, direction: 'up', deltaDb: 1 },
	})
	assert.deepEqual(sent, [])
})

test('meter feedback reads the peak or rms bank per the selected mode', () => {
	const WIDTH = 20
	const HEIGHT = 72
	const px = (buf, x, y) => [...buf.slice((y * WIDTH + x) * 4, (y * WIDTH + x) * 4 + 4)]
	// Peak channel loud (0 dB), RMS channel silent (below -60): only the mode
	// matching the selected bank must light the bar.
	const defs = getFeedbackDefinitions(() => ({
		vuInputDsp: [0],
		vuOutputDsp: [0],
		vuInputDspRms: [-70],
		vuOutputDspRms: [-70],
	}))
	const image = { width: WIDTH, height: HEIGHT }

	const peak = defs.meter.callback({ options: { meterType: 0, meterMode: 'peak', channel: 1 }, image })
	assert.deepEqual(px(peak.imageBuffer, 2, 0), [255, 0, 0, 255]) // full bar lit

	const rms = defs.meter.callback({ options: { meterType: 0, meterMode: 'rms', channel: 1 }, image })
	assert.deepEqual(px(rms.imageBuffer, 2, 0), [41, 0, 0, 255]) // only the dim track
})

test('firmware gate compares numeric segments and reports unparseable strings as unknown', () => {
	assert.equal(isFirmwareAtLeast('0.97', '0.98'), false)
	assert.equal(isFirmwareAtLeast('0.98', '0.98'), true)
	assert.equal(isFirmwareAtLeast('0.98.1', '0.98'), true)
	assert.equal(isFirmwareAtLeast('1.0', '0.98'), true)
	assert.equal(isFirmwareAtLeast('0.100', '0.98'), true)
	assert.equal(isFirmwareAtLeast('V0.97b2', '0.98'), false)
	assert.equal(isFirmwareAtLeast('unknown', '0.98'), null)
	assert.equal(isFirmwareAtLeast('', '0.98'), null)
})

test('spr framing surfaces the leading legacy [66 00] rejection from pre-0.98 firmware', () => {
	const legacy = []
	const spr = []
	const acc = new MessageAccumulator(
		(data) => legacy.push(Buffer.from(data)),
		(data) => spr.push(Buffer.from(data)),
	)
	acc.setResponseFraming('spr')
	// Fragmented across TCP segments like any 2-byte legacy reply can be.
	acc.feed(Buffer.from([0x66]))
	assert.equal(legacy.length, 0)
	acc.feed(Buffer.from([0x00]))
	assert.deepEqual(legacy, [Buffer.from([0x66, 0x00])])
	assert.equal(spr.length, 0)

	// Once the turn starts with non-legacy bytes, a stray status-looking pair
	// inside junk stays junk (the pre-existing discard behaviour).
	legacy.length = 0
	acc.setResponseFraming('spr')
	acc.feed(Buffer.from([0x01, 0x33, 0x00]))
	assert.equal(legacy.length, 0)
})

test('a legacy [66 00] resolves an SPC snapshot request instead of tearing down the link', async () => {
	const sockets = []
	const client = new NewtonTcpClient('newton', 6668, () => {
		const socket = new FakeSocket()
		sockets.push(socket)
		return socket
	})
	client.connect()
	sockets[0].emit('connect')
	const pending = client.sendCommandExpect(buildSnapshotGetDatabase(), {
		name: 'Snapshot Get Database',
		timeoutMs: 200,
	})
	await sleep(0)
	sockets[0].emit('data', Buffer.from('6600', 'hex'))
	const result = await pending
	assert.equal(result.success, false)
	assert.equal(result.rx.toString('hex'), '6600')

	// The connection survives the rejection and the next command works.
	assert.equal(sockets.length, 1)
	assert.equal(sockets[0].destroyed, false)
	const next = client.sendCommandExpect(Buffer.from('0100', 'hex'), { timeoutMs: 200 })
	await sleep(0)
	sockets[0].emit('data', Buffer.from('3300', 'hex'))
	assert.equal((await next).success, true)
	client.destroy()
})

test('a legacy [66 00] rejects fixed-length reads without reconnecting', async () => {
	const sockets = []
	const client = new NewtonTcpClient('newton', 6668, () => {
		const socket = new FakeSocket()
		sockets.push(socket)
		return socket
	})
	client.connect()
	sockets[0].emit('connect')

	const rejected = client.sendCommandExpect(Buffer.from('91336600', 'hex'), {
		name: 'Read Priority List',
		timeoutMs: 200,
		expectedLength: 6,
		isSuccess: (data) => data.length === 6,
	})
	await sleep(0)
	sockets[0].emit('data', Buffer.from('6600', 'hex'))
	const result = await rejected
	assert.equal(result.success, false)
	assert.equal(result.rx.toString('hex'), '6600')
	assert.equal(sockets.length, 1)
	assert.equal(sockets[0].destroyed, false)

	// The cleanly resolved rejection leaves the queue usable for the next read.
	const next = client.sendCommandExpect(Buffer.from('010000000000', 'hex'), { timeoutMs: 200 })
	await sleep(0)
	sockets[0].emit('data', Buffer.from('3300', 'hex'))
	assert.equal((await next).success, true)
	client.destroy()
})

test('a fragmented raw fixed-length reply beginning with [66 00] is not mistaken for an error', async () => {
	const messages = []
	const accumulator = new MessageAccumulator(
		(data) => messages.push(Buffer.from(data)),
		() => undefined,
	)
	accumulator.setResponseFraming('legacyFixedLength', 6, true)
	accumulator.feed(Buffer.from('6600', 'hex'))
	accumulator.feed(Buffer.from('01020304', 'hex'))
	assert.deepEqual(messages, [Buffer.from('660001020304', 'hex')])
})

test('snapshot actions fail fast on pre-0.98 firmware without sending', async () => {
	const sent = []
	const client = {
		sendCommandExpect: async (cmd) => {
			sent.push(Buffer.from(cmd))
			return { success: true, rx: Buffer.alloc(0) }
		},
	}
	const results = []
	const logger = { log: () => undefined, reportActionResult: (r) => results.push(r) }
	const snapshotTargets = new Map([['control-1', 'uuid-1']])
	const actions = getActionDefinitions(
		client,
		logger,
		new Map(),
		new Map(),
		[],
		snapshotTargets,
		new Map(),
		() => undefined,
		() => true,
	)

	// The by-name dropdown placeholder explains the firmware requirement.
	const choices = actions.snapshot_apply_selected.options.find((o) => o.id === 'uuid').choices
	assert.match(choices[0].label, /firmware 0\.98/)

	await actions.snapshot_apply_selected.callback({
		options: { uuid: 'uuid-1', fadingTime: 2000, mode: 'Direct' },
	})
	await actions.apply_this_snapshot.callback({
		controlId: 'control-1',
		options: { fadingTime: 2000, mode: 'Direct' },
	})
	assert.deepEqual(sent, [])
	assert.equal(results.length, 2)
	assert.ok(results.every((r) => r.success === false && /firmware 0\.98/.test(r.error)))
})

test('snapshot label feedback reports missing firmware support', () => {
	const label = getFeedbackDefinitions(
		() => ({ snapshotsUnsupported: true }),
		new Map(),
		new Map(),
		new Map(),
		new Map(),
		[{ uuid: 'u-1', name: 'Show opening' }],
		new Map(),
	).snapshot_apply_label
	const style = label.callback({ controlId: 'c1', options: { uuid: 'u-1' } })
	assert.equal(style.text, 'NO SNAPSHOT\nFW < 0.98')
})

test('every gain write is clamped to the device-safe -80..+6 dB window', async () => {
	// The builder is the choke point: out-of-range and non-finite values.
	const gain = (gainDb) => buildGainCommand({ channelType: 0, channelIndex: 0, gainDb, mute: false }).readFloatLE(6)
	assert.equal(gain(20), 6)
	assert.equal(gain(-100), -80)
	assert.equal(gain(Number.NaN), -80)
	assert.equal(gain(-4.5), -4.5)
	const fader = buildFaderCommand({ channelType: 0, gains: [30, -200, ...Array(14).fill(0)] })
	assert.equal(fader.readFloatLE(2), 6)
	assert.equal(fader.readFloatLE(6), -80)

	// A mute toggle must not echo an out-of-range cached device gain.
	const sent = []
	const client = {
		sendCommandExpect: async (cmd) => {
			sent.push(Buffer.from(cmd))
			return { success: true, rx: Buffer.from('3300', 'hex') }
		},
	}
	const reads = []
	const logger = {
		log: () => undefined,
		reportActionResult: () => undefined,
		reportGainRead: (t, i, s) => reads.push(s),
	}
	const gains = new Map([['1:4', { gainDb: -90, muted: false }]])
	const getGainRead = (t, i) => gains.get(`${t}:${i}`)
	const muteTargets = new Map([['ctrl9', { channelType: 1, channelIndex: 4 }]])
	const actions = getActionDefinitions(client, logger, new Map(), new Map(), [], new Map(), muteTargets, getGainRead)
	await actions.mute_this_channel.callback({ controlId: 'ctrl9', options: { mode: 'toggle' } })
	assert.equal(sent[0].readFloatLE(6), -80)
	assert.equal(sent[0][10], 1)
	assert.equal(reads.at(-1).gainDb, -80)

	// Set Gain clamps trigger-injected values before building.
	sent.length = 0
	await actions.set_gain.callback({
		options: { channelType: 0, channelIndex: 0, gainDb: 18, mute: false },
	})
	assert.equal(sent[0].readFloatLE(6), 6)
})

test('scope option restores module-wide status lamps and the upgrade marks pre-scope feedbacks global', () => {
	const state = {
		lastActionName: 'Set Gain',
		lastActionStatus: 'success',
		lastActionResults: new Map(),
	}
	const definitions = getFeedbackDefinitions(() => state)

	// A dedicated lamp button (never ran an action itself) with scope 'global'
	// lights from an action run anywhere, like 1.0.0 did.
	assert.equal(
		definitions.last_action_success.callback({
			controlId: 'lamp-button',
			options: { actionName: 'Set Gain', scope: 'global' },
		}),
		true,
	)
	// Default scope stays per-button: same lamp without scope stays dark.
	assert.equal(
		definitions.last_action_success.callback({ controlId: 'lamp-button', options: { actionName: 'Set Gain' } }),
		false,
	)

	// Feedbacks saved before the option existed are migrated to 'global'.
	const upgraded = UpgradeScripts.at(-1)(
		{ currentConfig: {} },
		{
			config: null,
			actions: [],
			feedbacks: [
				{ id: 'f1', controlId: 'c1', feedbackId: 'last_action_error', options: { actionName: '' } },
				{
					id: 'f2',
					controlId: 'c2',
					feedbackId: 'last_action_success',
					options: { actionName: 'Set Gain', scope: 'this' },
				},
				{ id: 'f3', controlId: 'c3', feedbackId: 'input_patch_monitor', options: {} },
			],
		},
	)
	assert.equal(upgraded.updatedFeedbacks.length, 1)
	assert.equal(upgraded.updatedFeedbacks[0].id, 'f1')
	assert.equal(upgraded.updatedFeedbacks[0].options.scope, 'global')
})

test('snapshot label shows a loading state and keeps its target until the database is read', () => {
	const snapshotTargets = new Map()
	const label = getFeedbackDefinitions(
		() => ({ snapshotDatabaseLoaded: false }),
		new Map(),
		new Map(),
		new Map(),
		snapshotTargets,
		[],
	).snapshot_apply_label

	// Valid uuid, database not read yet: not "missing", and the target stays
	// registered so pressing the button right after connect can still work.
	assert.deepEqual(label.callback({ controlId: 'b1', options: { uuid: 'uuid-1' } }), {
		text: 'SNAPSHOT\nLOADING…',
	})
	assert.equal(snapshotTargets.get('b1'), 'uuid-1')

	// The apply action fails soft (retry) instead of claiming deletion.
	const reports = []
	const actions = getActionDefinitions(
		{ sendCommandExpect: async () => ({ success: true, rx: Buffer.alloc(0) }) },
		{ log: () => undefined, reportActionResult: (result) => reports.push(result) },
		new Map(),
		new Map(),
		[],
		snapshotTargets,
		new Map(),
		() => undefined,
		() => false,
		() => false,
	)
	return actions.apply_this_snapshot
		.callback({ controlId: 'b1', options: { fadingTime: 2000, mode: 'Direct' } })
		.then(() => {
			assert.match(reports.at(-1).error, /not been read/)
			assert.equal(snapshotTargets.has('b1'), true)
		})
})
