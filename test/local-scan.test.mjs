import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fromOllama, fromOpenAiModels, fromImageServer, fromWhisper, fromMcpConfig, servicesForHub, parseShares, taskOf, isExcluded, EXCLUDED, scanLocalServices, SHARE_LINE } from '../lib/local-scan.mjs'
import { messagesOf } from '../lib/local-relay.mjs'

test('0.4.7: Ollama tags → LLM services with a stable id, a task family and no secrets', () => {
  const s = fromOllama({ models: [{ name: 'qwen2.5:14b', size: 9e9, details: { family: 'qwen2', parameter_size: '14.8B', quantization_level: 'Q4_K_M' } }, { name: 'qwen2.5-coder:7b', details: {} }, { name: 'nomic-embed-text', details: {} }] })
  assert.equal(s.length, 3)
  assert.deepEqual([s[0].service_id, s[0].kind, s[0].provider, s[0].port, s[0].task], ['ollama:qwen2.5:14b', 'llm', 'ollama', 11434, 'chat'])
  assert.equal(s[0].details.parameter_size, '14.8B'); assert.equal(s[1].task, 'code'); assert.equal(s[2].task, 'embeddings')
})
test('0.4.7: OpenAI-compatible /v1/models, A1111, ComfyUI and a Whisper OpenAPI', () => {
  const lm = fromOpenAiModels({ data: [{ id: 'llama-3.1-8b-instruct', owned_by: 'lmstudio', max_model_len: 8192 }] }, 'lmstudio', 1234)
  assert.equal(lm[0].service_id, 'lmstudio:1234:llama-3.1-8b-instruct'); assert.equal(lm[0].details.context, 8192); assert.equal(lm[0].base_url, 'http://127.0.0.1:1234/v1')
  assert.equal(fromImageServer([{ model_name: 'sd_xl_base_1.0' }], 'a1111', 7860)[0].kind, 'image')
  assert.equal(fromImageServer({ devices: [{ name: 'cuda:0', vram_total: 1 }] }, 'comfyui', 8188)[0].name, 'ComfyUI')
  assert.equal(fromWhisper({ info: { title: 'Whisper ASR' }, paths: { '/asr': {}, '/detect-language': {} } })[0].task, 'speech-to-text')
  assert.deepEqual(fromWhisper({ paths: { '/health': {} } }), [])
})
test('0.4.7: MCP configs are read, never started; env values never copied; subscription apps excluded', () => {
  const s = fromMcpConfig('Claude Desktop', { mcpServers: { github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_TOKEN: 'ghp_secret' } }, remote: { url: 'https://mcp.example.com/mcp' }, chatgpt: { command: 'chatgpt-mcp' } } })
  assert.equal(s.length, 2)
  assert.equal(s[0].details.command, 'npx -y @modelcontextprotocol/server-github'); assert.equal(s[0].details.env_keys, 1); assert.match(s[0].details.tools, /never started/)
  assert.equal(JSON.stringify(s).includes('ghp_secret'), false)
  assert.equal(s[1].base_url, 'https://mcp.example.com/mcp')
  assert.ok(isExcluded('Claude Desktop') && isExcluded('codex') && !isExcluded('qwen2.5') && EXCLUDED.length >= 6)
})
test('0.4.7: nothing is shared by default; the heartbeat list carries prices only for ticked rows', () => {
  const services = fromOllama({ models: [{ name: 'a' }, { name: 'b' }] })
  const none = servicesForHub(services, {})
  assert.ok(none.every((x) => x.shared === false && x.price_usd === null)); assert.equal(none[0].price_unit, 'per_1k_tokens')
  const some = servicesForHub(services, { 'ollama:a': { shared: true, price_usd: 0.002, daily_cap_usd: 5 } })
  assert.deepEqual([some[0].shared, some[0].price_usd, some[0].daily_cap_usd, some[1].shared], [true, 0.002, 5, false])
  assert.equal(servicesForHub(services, { 'ollama:a': { shared: true, price_usd: null } })[0].shared, false, 'ticked without a price is not shared')
})
test('0.4.7: the page form → config.local_shares, refusing a share without a price and unknown ids', () => {
  const services = fromOllama({ models: [{ name: 'a' }] })
  assert.deepEqual(parseShares({ 'ollama:a': { shared: true, price_usd: '0.001', daily_cap_usd: '' } }, services), { 'ollama:a': { shared: true, price_usd: 0.001, daily_cap_usd: null, paused: false, timeout_seconds: null } })
  assert.throws(() => parseShares({ 'ollama:a': { shared: true, price_usd: '' } }, services), /set a price/)
  assert.deepEqual(parseShares({ 'ollama:zzz': { shared: true, price_usd: 1 } }, services), {})
  assert.equal(taskOf('whisper-large'), 'speech-to-text'); assert.equal(taskOf('deepseek-coder'), 'code'); assert.equal(taskOf('llava'), 'vision')
  assert.match(SHARE_LINE, /Nothing leaves this computer/)
})
test('0.4.7: the scan probes only loopback and reads only the editor configs it is given', async () => {
  const calls = []
  const fetchImpl = async (url) => { calls.push(url); if (url.includes(':11434')) return { ok: true, text: async () => JSON.stringify({ models: [{ name: 'qwen2.5:0.5b' }] }) }; return { ok: false } }
  const r = await scanLocalServices({ fetchImpl, readFileImpl: async () => { throw new Error('no file') } })
  assert.ok(calls.every((u) => u.startsWith('http://127.0.0.1:')))
  assert.equal(r.services.length, 1); assert.equal(r.services[0].service_id, 'ollama:qwen2.5:0.5b'); assert.deepEqual(r.ports, [11434])
})
test('0.4.7: relay messages from an OpenAI request or a bare prompt', () => {
  assert.deepEqual(messagesOf({ messages: [{ role: 'user', content: 'hi' }] }), [{ role: 'user', content: 'hi' }])
  assert.deepEqual(messagesOf({ prompt: 'hello' }), [{ role: 'user', content: 'hello' }])
})
