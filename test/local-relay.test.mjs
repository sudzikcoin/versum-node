/**
 * 0.4.8 — the pure rules of relaying every kind: the ComfyUI workflow we ship, the image numbers, the units a
 * speech call sells, the .srt we build, the risk rule on an MCP tool, and the self-test that keeps the scanner
 * from offering what the relay cannot carry.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { imageParams, WORKFLOW, comfyCheckpoints, comfyImages, generateA1111 } from '../lib/local-image.mjs'
import { riskyTool, toolRows, argvOf } from '../lib/local-mcp.mjs'
import { srtOf, audioMinutes, transcribeLocal } from '../lib/local-relay.mjs'
import { selfTest, silentWav, canShare, servicesForHub, parseShares, unitOf, fromWhisperOpenAI } from '../lib/local-scan.mjs'

test('0.4.8: the image numbers are clamped and the seed is repeatable', () => {
  const p = imageParams({ prompt: 'a watercolour fox', width: 515, height: 9999, steps: 500, seed: 7 })
  assert.equal(p.width, 512, 'rounded down to a multiple of 8')
  assert.equal(p.height, 2048); assert.equal(p.steps, 100); assert.equal(p.seed, 7); assert.equal(p.count, 1)
  assert.throws(() => imageParams({}), /needs a prompt/)
})

test('0.4.8: the shipped ComfyUI workflow is a plain txt2img graph with the owner\'s checkpoint', () => {
  const w = WORKFLOW('sd15.safetensors', imageParams({ prompt: 'a fox', negative: 'blurry', seed: 1 }))
  assert.equal(w['1'].inputs.ckpt_name, 'sd15.safetensors')
  assert.equal(w['2'].inputs.text, 'a fox'); assert.equal(w['3'].inputs.text, 'blurry')
  assert.equal(w['5'].class_type, 'KSampler'); assert.deepEqual(w['5'].inputs.positive, ['2', 0])
  assert.equal(w['7'].class_type, 'SaveImage')
  assert.deepEqual(comfyCheckpoints({ CheckpointLoaderSimple: { input: { required: { ckpt_name: [['sd15.safetensors', 'other.ckpt']] } } } }), ['sd15.safetensors', 'other.ckpt'])
  assert.deepEqual(comfyImages({ outputs: { 7: { images: [{ filename: 'versum_00001_.png', subfolder: '', type: 'output' }] } } }), [{ filename: 'versum_00001_.png', subfolder: '', type: 'output' }])
})

test('0.4.8: A1111 is driven through /sdapi/v1/txt2img and its base64 becomes PNG bytes', async () => {
  let seen = null
  const fetchImpl = async (url, opts) => { seen = { url, body: JSON.parse(opts.body) }; return { ok: true, json: async () => ({ images: [Buffer.from('PNGDATA').toString('base64')] }) } }
  const out = await generateA1111({ provider: 'a1111', base_url: 'http://127.0.0.1:7860', model: 'sd15' }, { prompt: 'a fox', steps: 12 }, fetchImpl)
  assert.match(seen.url, /\/sdapi\/v1\/txt2img$/)
  assert.equal(seen.body.steps, 12); assert.equal(seen.body.override_settings.sd_model_checkpoint, 'sd15')
  assert.equal(out.files.length, 1); assert.equal(out.files[0].name, 'image-1.png'); assert.equal(out.files[0].bytes.toString(), 'PNGDATA')
})

test('0.4.8: a transcription gives the text, the .txt and the .srt, and sells minutes of audio', async () => {
  const body = { text: 'hello there', segments: [{ start: 0, end: 1.5, text: 'hello' }, { start: 1.5, end: 3, text: 'there' }] }
  const fetchImpl = async () => ({ ok: true, text: async () => JSON.stringify(body) })
  const emitted = []
  const out = await transcribeLocal({ provider: 'whisper_openai', base_url: 'http://127.0.0.1:8910', model: 'whisper' }, { audio_base64: silentWav(20).toString('base64'), file_name: 'clip.wav' }, (d) => emitted.push(d), fetchImpl)
  assert.equal(emitted.join(''), 'hello there')
  assert.deepEqual(out.files.map((f) => f.name), ['clip.txt', 'clip.srt'])
  assert.match(out.files[1].bytes.toString(), /00:00:00,000 --> 00:00:01,500/)
  assert.equal(out.usage.units, out.usage.audio_minutes)
  assert.equal(audioMinutes({ duration_s: 20 }), 0.333333, '20 seconds is a third of a minute, 6 decimals')
  assert.match(srtOf([{ start: 61.25, end: 62, text: 'x' }]), /00:01:01,250/)
})

test('0.4.8: a tool that touches files is marked risky and starts unticked', () => {
  assert.equal(riskyTool({ name: 'read_text_file', description: 'Read a file' }), true)
  assert.equal(riskyTool({ name: 'run_command', description: 'Run a shell command' }), true)
  assert.equal(riskyTool({ name: 'get_current_time', description: 'The current time in a timezone' }), false)
  const rows = toolRows([{ name: 'get_current_time', description: 'now' }, { name: 'x' }, { description: 'no name' }])
  assert.equal(rows.length, 2, 'a tool without a name is dropped')
  assert.deepEqual(argvOf('npx -y "@modelcontextprotocol/server-filesystem" /tmp/x'), ['npx', '-y', '@modelcontextprotocol/server-filesystem', '/tmp/x'])
})

test('0.4.8: the self-test decides what may be shared — a ComfyUI with no checkpoint is greyed with the reason', async () => {
  const empty = async () => ({ ok: true, json: async () => ({ CheckpointLoaderSimple: { input: { required: { ckpt_name: [[]] } } } }) })
  const bad = await selfTest({ kind: 'image', provider: 'comfyui', base_url: 'http://127.0.0.1:8188', details: {} }, { fetchImpl: empty })
  assert.equal(bad.status, 'error'); assert.match(bad.reason, /no checkpoint installed/)
  assert.equal(canShare({ status: 'error' }), false)
  const good = async () => ({ ok: true, json: async () => ({ CheckpointLoaderSimple: { input: { required: { ckpt_name: [['sd15.safetensors']] } } } }) })
  const ok = await selfTest({ kind: 'image', provider: 'comfyui', base_url: 'http://127.0.0.1:8188', details: {} }, { fetchImpl: good })
  assert.equal(ok.status, 'ready'); assert.equal(ok.details.checkpoint, 'sd15.safetensors'); assert.ok(ok.latency_ms >= 0)
  const mcpUntested = await selfTest({ kind: 'mcp', name: 'fs', details: {} }, { fetchImpl: async () => ({ ok: false }) })
  assert.equal(mcpUntested.status, 'starting'); assert.match(mcpUntested.reason, /never started before that/)
  // a service that failed cannot be ticked, by the form's own rule
  assert.throws(() => parseShares({ x: { shared: true, price_usd: 1 } }, [{ service_id: 'x', kind: 'image', status: 'error', status_reason: 'no checkpoint installed', details: {} }]), /no checkpoint installed/)
})

test('0.4.8: the heartbeat carries the unit per kind, the status, the pause and only the ticked MCP tools', () => {
  const services = [
    { service_id: 'comfyui', kind: 'image', provider: 'comfyui', name: 'ComfyUI', model: 'comfyui', status: 'ready', last_latency_ms: 40, details: {} },
    { service_id: 'mcp:Cursor:fs', kind: 'mcp', provider: 'mcp_config', name: 'fs', model: 'fs', status: 'ready', details: { tools: [{ name: 'read_text_file', title: 'r', description: 'd', input_schema: {}, risky: true }, { name: 'list_allowed_directories', title: 'l', description: 'd', input_schema: {}, risky: false }] } },
  ]
  const shares = { comfyui: { shared: true, price_usd: 0.02, daily_cap_usd: 2, paused: true, timeout_seconds: 300 }, 'mcp:Cursor:fs': { shared: true, price_usd: 0.005, tools: ['list_allowed_directories'] } }
  const out = servicesForHub(services, shares)
  assert.equal(out[0].price_unit, 'per_image'); assert.equal(out[0].paused, true); assert.equal(out[0].daily_cap_usd, 2); assert.equal(out[0].timeout_seconds, 300)
  assert.equal(out[1].price_unit, 'per_call'); assert.equal(out[1].tools.length, 1, 'only the ticked tool is offered'); assert.equal(out[1].tools_found, 2)
  assert.equal(unitOf('audio'), 'per_audio_minute')
  assert.equal(fromWhisperOpenAI(8910)[0].details.path, '/v1/audio/transcriptions')
})
