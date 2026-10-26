/**
 * 0.4.7 / 0.4.8 — what this computer already runs that a buyer could use: local model servers and local MCP servers.
 *
 * Fully local. Every probe is an HTTP GET to 127.0.0.1 on a well-known port (Ollama 11434, LM Studio 1234,
 * llama.cpp / vLLM / any OpenAI-compatible server on 8000 / 8080 / 5000, ComfyUI 8188, A1111 7860, a Whisper
 * server on 9000). MCP servers are READ from the editors' config files (Claude Desktop, Cursor, VS Code): name,
 * command and URL only — they are never started here, so their tool lists are not read until the owner shares
 * one. Nothing is sent anywhere by this module; the node sends the list to the hub as `local_services` on the
 * heartbeat, and nothing is offered for sale until the owner ticks a box on the local page.
 *
 * THE RULE (also in the README): subscription apps and cloud accounts are NEVER scanned or offered — ChatGPT,
 * Claude Desktop's own model access, Codex, Copilot, Gemini and the like — and no API key, token or credential
 * is ever read from the environment, a keychain or a config file. Only servers that run on this machine and
 * answer on a local port are candidates, because only those can be sold without reselling someone else's
 * subscription. EXCLUDED below is the deny list the scanner applies to MCP entries and process names.
 *
 * 0.4.8 — every kind is relayed, so every kind is SELF-TESTED before it may be sold: `selfTest` asks the local
 * service the one question the relay will ask it (a checkpoint for ComfyUI, /sdapi/v1/options for A1111, a quarter
 * second of silence for a speech server, tools/list for a shared MCP server) and sets status = ready | starting |
 * error with a reason and the latency. A service whose self-test fails is shown GREYED with that reason and cannot
 * be ticked — the scanner never offers what the relay cannot carry.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import os from 'node:os'

export const SCAN_EVERY_MS = 10 * 60 * 1000
export const PROBE_TIMEOUT_MS = 1500

/** Names (lower-case substrings) that are never scanned or offered: subscription apps and cloud accounts. */
export const EXCLUDED = ['chatgpt', 'openai-codex', 'codex', 'claude desktop', 'claude-desktop', 'anthropic', 'copilot', 'gemini', 'perplexity', 'cursor-cloud']
export const isExcluded = (name) => { const n = String(name ?? '').toLowerCase(); return EXCLUDED.some((x) => n.includes(x)) }

/** The ports and what answers there. */
export const PROBES = [
  { provider: 'ollama', port: 11434, path: '/api/tags' },
  { provider: 'lmstudio', port: 1234, path: '/v1/models' },
  { provider: 'openai_compat', port: 8000, path: '/v1/models' },
  { provider: 'openai_compat', port: 8080, path: '/v1/models' },
  { provider: 'openai_compat', port: 5000, path: '/v1/models' },
  { provider: 'comfyui', port: 8188, path: '/system_stats' },
  { provider: 'a1111', port: 7860, path: '/sdapi/v1/sd-models' },
  { provider: 'whisper', port: 9000, path: '/openapi.json' },
  // 0.4.8: a server that speaks OpenAI's /v1/audio/transcriptions (faster-whisper-server / speaches / whisper.cpp server)
  { provider: 'whisper_openai', port: 9000, path: '/' },
  { provider: 'whisper_openai', port: 8910, path: '/' },
  { provider: 'whisper_openai', port: 8911, path: '/' },
]

/** Pure: the task family of a model from its name — the catalog's filter and the "recommended for" rule. */
export function taskOf(model, kind = 'llm') {
  if (kind === 'audio') return 'speech-to-text'
  if (kind === 'image') return 'image'
  if (kind === 'mcp') return 'tool'
  const m = String(model ?? '').toLowerCase()
  if (/coder|codellama|starcoder|deepseek-coder|codestral|codegemma|qwen.*code/.test(m)) return 'code'
  if (/whisper/.test(m)) return 'speech-to-text'
  if (/embed|bge-|e5-|minilm|nomic/.test(m)) return 'embeddings'
  if (/translate|nllb|madlad|opus-mt|aya/.test(m)) return 'translate'
  if (/vision|llava|vl\b|-vl-|moondream|pixtral/.test(m)) return 'vision'
  return 'chat'
}

const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null)

/** Pure: Ollama's /api/tags body → services. */
export function fromOllama(body, port = 11434) {
  const out = []
  for (const m of Array.isArray(body?.models) ? body.models : []) {
    const name = String(m.name ?? m.model ?? '').trim()
    if (!name || isExcluded(name)) continue
    const d = m.details ?? {}
    out.push({ service_id: `ollama:${name}`, kind: 'llm', provider: 'ollama', name, model: name, port, base_url: `http://127.0.0.1:${port}`, task: taskOf(name),
      details: { family: d.family ?? null, parameter_size: d.parameter_size ?? null, quantization: d.quantization_level ?? null, size_bytes: num(m.size), context: null, api: 'ollama' } })
  }
  return out
}

/** Pure: an OpenAI-compatible /v1/models body → services. */
export function fromOpenAiModels(body, provider, port) {
  const out = []
  for (const m of Array.isArray(body?.data) ? body.data : []) {
    const name = String(m.id ?? '').trim()
    if (!name || isExcluded(name)) continue
    out.push({ service_id: `${provider}:${port}:${name}`, kind: 'llm', provider, name, model: name, port, base_url: `http://127.0.0.1:${port}/v1`, task: taskOf(name),
      details: { owned_by: m.owned_by ?? null, context: num(m.max_model_len ?? m.context_length ?? m.n_ctx), api: 'openai' } })
  }
  return out
}

/** Pure: A1111's model list → one image service per checkpoint; ComfyUI → one service (its workflows are the buyer's). */
export function fromImageServer(body, provider, port) {
  if (provider === 'a1111') {
    const out = []
    for (const m of Array.isArray(body) ? body : []) {
      const name = String(m.model_name ?? m.title ?? '').trim()
      if (!name) continue
      out.push({ service_id: `a1111:${name}`, kind: 'image', provider, name, model: name, port, base_url: `http://127.0.0.1:${port}`, task: 'image', details: { api: 'a1111' } })
    }
    return out
  }
  if (provider === 'comfyui' && body && typeof body === 'object') {
    const dev = Array.isArray(body.devices) ? body.devices[0] : null
    return [{ service_id: 'comfyui', kind: 'image', provider, name: 'ComfyUI', model: 'comfyui', port, base_url: `http://127.0.0.1:${port}`, task: 'image', details: { api: 'comfyui', device: dev?.name ?? null, vram_total: num(dev?.vram_total) } }]
  }
  return []
}

/** Pure: a Whisper server's OpenAPI → one speech-to-text service when an /asr or /transcribe path exists. */
export function fromWhisper(body, port = 9000) {
  const paths = Object.keys(body?.paths ?? {})
  const asr = paths.find((p) => /asr|transcri/i.test(p))
  if (!asr) return []
  return [{ service_id: `whisper:${port}`, kind: 'audio', provider: 'whisper', name: String(body?.info?.title ?? 'Whisper'), model: 'whisper', port, base_url: `http://127.0.0.1:${port}`, task: 'speech-to-text', details: { api: 'whisper-asr', path: asr } }]
}

/** Pure (0.4.8): a server that speaks OpenAI's /v1/audio/transcriptions — faster-whisper-server, speaches, whisper.cpp server. */
export const AUDIO_PATHS = ['/v1/audio/transcriptions', '/inference']
export function fromWhisperOpenAI(port, model = 'whisper', path = AUDIO_PATHS[0]) {
  return [{ service_id: `whisper-openai:${port}`, kind: 'audio', provider: 'whisper_openai', name: path === '/inference' ? 'whisper.cpp server' : 'Whisper (OpenAI API)', model, port, base_url: `http://127.0.0.1:${port}`, task: 'speech-to-text', details: { api: 'openai-audio', path } }]
}

/** Pure (0.4.8): the price unit a kind is sold in. */
export const UNIT_OF = { llm: 'per_1k_tokens', image: 'per_image', audio: 'per_audio_minute', mcp: 'per_call' }
export const unitOf = (kind) => UNIT_OF[kind] ?? 'per_call'
export const UNIT_WORDS = { per_1k_tokens: 'per 1,000 tokens', per_image: 'per image', per_audio_minute: 'per minute of audio', per_call: 'per call' }

/** Where the editors keep their MCP server lists. Read only; never started. */
export function mcpConfigPaths(platform = process.platform, home = os.homedir(), env = process.env) {
  const p = []
  if (platform === 'win32') { if (env.APPDATA) p.push({ app: 'Claude Desktop', path: join(env.APPDATA, 'Claude', 'claude_desktop_config.json') }) }
  else if (platform === 'darwin') p.push({ app: 'Claude Desktop', path: join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json') })
  else p.push({ app: 'Claude Desktop', path: join(home, '.config', 'Claude', 'claude_desktop_config.json') })
  p.push({ app: 'Cursor', path: join(home, '.cursor', 'mcp.json') })
  p.push({ app: 'VS Code', path: join(home, '.vscode', 'mcp.json') })
  p.push({ app: 'Claude Code', path: join(home, '.claude.json') })
  return p
}

/** Pure: one editor config → MCP services (name, command/url; tools "not read"). Keys and env values are dropped. */
export function fromMcpConfig(app, body) {
  const servers = body?.mcpServers ?? body?.servers ?? body?.mcp?.servers ?? {}
  const out = []
  for (const [name, s] of Object.entries(servers && typeof servers === 'object' ? servers : {})) {
    if (isExcluded(name) || !s || typeof s !== 'object') continue
    const command = typeof s.command === 'string' ? [s.command, ...(Array.isArray(s.args) ? s.args.map(String) : [])].join(' ') : null
    const url = typeof s.url === 'string' ? s.url : null
    if (!command && !url) continue
    // env of a server often carries a token: it is NOT copied anywhere — only the fact that env keys exist
    out.push({ service_id: `mcp:${app}:${name}`, kind: 'mcp', provider: 'mcp_config', name, model: name, port: null, base_url: url, task: 'tool',
      details: { app, command: command ? command.slice(0, 200) : null, url, env_keys: s.env && typeof s.env === 'object' ? Object.keys(s.env).length : 0, tools: 'not read — the server is never started here unless shared' } })
  }
  return out
}

async function probe(fetchImpl, port, path) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), PROBE_TIMEOUT_MS)
  try {
    const r = await fetchImpl(`http://127.0.0.1:${port}${path}`, { signal: ac.signal, headers: { accept: 'application/json' } })
    if (!r.ok) return null
    const text = await r.text()
    try { return JSON.parse(text) } catch { return null }
  } catch { return null } finally { clearTimeout(t) }
}

/** A quarter second of silence, 16 kHz mono PCM — the self-test a speech server is asked to transcribe. */
export function silentWav(seconds = 0.25, rate = 16000) {
  const n = Math.round(seconds * rate), data = 2 * n, buf = Buffer.alloc(44 + data)
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + data, 4); buf.write('WAVE', 8)
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34)
  buf.write('data', 36); buf.writeUInt32LE(data, 40)
  return buf
}

export const SELF_TEST_TIMEOUT_MS = 30_000

/**
 * 0.4.8 — can the relay actually carry this kind? One real question per kind, the same one the relay asks.
 * Returns { status: 'ready' | 'starting' | 'error', reason, latency_ms, details } — `details` is merged into the
 * service (ComfyUI's checkpoint list, a speech server's model). MCP servers are tested only when shared, because
 * testing one means starting it (see local-mcp.mjs); until then they are 'starting' with the reason in words.
 */
export async function selfTest(svc, { fetchImpl = fetch, mcpPool = null, timeoutMs = SELF_TEST_TIMEOUT_MS } = {}) {
  const t0 = Date.now()
  const done = (status, reason = null, details = {}) => ({ status, reason, latency_ms: Date.now() - t0, details })
  const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    if (svc.kind === 'llm') return done('ready')
    if (svc.kind === 'image' && svc.provider === 'comfyui') {
      const { comfyCheckpoints } = await import('./local-image.mjs')
      const r = await fetchImpl(`${svc.base_url}/object_info/CheckpointLoaderSimple`, { signal: ac.signal })
      if (!r.ok) return done('error', `ComfyUI answered ${r.status} when asked what it can load`)
      const ck = comfyCheckpoints(await r.json().catch(() => ({})))
      if (!ck.length) return done('error', 'ComfyUI has no checkpoint installed — put a model in models/checkpoints and rescan')
      return done('ready', null, { checkpoints: ck, checkpoint: svc.details?.checkpoint && ck.includes(svc.details.checkpoint) ? svc.details.checkpoint : ck[0] })
    }
    if (svc.kind === 'image' && svc.provider === 'a1111') {
      const r = await fetchImpl(`${svc.base_url}/sdapi/v1/options`, { signal: ac.signal })
      return r.ok ? done('ready') : done('error', `A1111 answered ${r.status} on /sdapi/v1/options`)
    }
    if (svc.kind === 'audio') {
      const form = new FormData()
      const wav = new Blob([silentWav()], { type: 'audio/wav' })
      if (svc.provider === 'whisper_openai') {
        const path = svc.details?.path ?? AUDIO_PATHS[0]
        form.append('file', wav, 'silence.wav'); form.append('model', String(svc.model ?? 'whisper-1')); form.append('response_format', 'json')
        const r = await fetchImpl(`${svc.base_url}${path}`, { method: 'POST', body: form, signal: ac.signal })
        return r.ok ? done('ready') : done('error', `the speech server answered ${r.status} on ${path}: ${(await r.text()).slice(0, 160)}`)
      }
      form.append('audio_file', wav, 'silence.wav')
      const r = await fetchImpl(`${svc.base_url}${svc.details?.path ?? '/asr'}?output=json`, { method: 'POST', body: form, signal: ac.signal })
      return r.ok ? done('ready') : done('error', `the speech server answered ${r.status} on ${svc.details?.path ?? '/asr'}`)
    }
    if (svc.kind === 'mcp') {
      if (!mcpPool) return done('starting', 'the tools are read when you share it — this server is never started before that')
      const tools = await mcpPool.tools(svc)
      if (!tools.length) return done('error', 'the server started but offers no tools')
      return done('ready', null, { tools })
    }
    return done('error', `${svc.kind} is not a kind this node can relay`)
  } catch (e) {
    return done('error', String(e?.message ?? e).split('\n')[0].slice(0, 300))
  } finally { clearTimeout(timer) }
}

/**
 * The scan. Returns { services, at, probed }. Deterministic order; each service's `service_id` is stable across
 * scans so the owner's share settings (config.local_shares) follow it. 0.4.8: every found service is self-tested
 * (`status`, `status_reason`, `last_latency_ms`); a shared MCP server is started so its tools can be listed.
 */
export async function scanLocalServices({ fetchImpl = fetch, platform = process.platform, home = os.homedir(), env = process.env, readFileImpl = readFile, shares = {}, mcpPool = null, test = true } = {}) {
  const services = []
  const seenPorts = new Set()
  for (const p of PROBES) {
    if (seenPorts.has(p.port) && p.provider === 'whisper_openai') continue   // 9000 already answered as whisper-asr
    const body = await probe(fetchImpl, p.port, p.path)
    if (body === null && p.provider !== 'whisper_openai') continue
    let found = []
    if (p.provider === 'ollama') found = fromOllama(body, p.port)
    else if (p.provider === 'lmstudio' || p.provider === 'openai_compat') found = fromOpenAiModels(body, p.provider, p.port)
    else if (p.provider === 'comfyui' || p.provider === 'a1111') found = fromImageServer(body, p.provider, p.port)
    else if (p.provider === 'whisper') found = fromWhisper(body, p.port)
    else if (p.provider === 'whisper_openai') found = await probeOpenAiAudio(fetchImpl, p.port)
    if (found.length) { seenPorts.add(p.port); services.push(...found) }
  }
  for (const c of mcpConfigPaths(platform, home, env)) {
    let text = null
    try { text = await readFileImpl(c.path, 'utf8') } catch { continue }
    try { services.push(...fromMcpConfig(c.app, JSON.parse(text))) } catch { /* not JSON: skip */ }
  }
  const out = services.slice(0, 60)
  if (test) for (const s of out) {
    const shared = shares?.[s.service_id]?.shared === true
    const t = await selfTest(s, { fetchImpl, mcpPool: s.kind === 'mcp' && shared ? mcpPool : null })
    s.status = t.status; s.status_reason = t.reason; s.last_latency_ms = t.latency_ms
    s.details = { ...(s.details ?? {}), ...(t.details ?? {}) }
  }
  return { services: out, at: new Date().toISOString(), probed: PROBES.length, ports: [...seenPorts] }
}

/**
 * Is a speech server on this port one the relay can drive? Ask it with a quarter second of silence, on each path a
 * real server uses: OpenAI's /v1/audio/transcriptions (faster-whisper-server, speaches) and whisper.cpp's
 * /inference. The first that answers 200 is the service; nothing else on the port is touched.
 */
async function probeOpenAiAudio(fetchImpl, port) {
  for (const path of AUDIO_PATHS) {
    const guess = fromWhisperOpenAI(port, 'whisper', path)
    const t = await selfTest(guess[0], { fetchImpl, timeoutMs: 20_000 })
    if (t.status === 'ready') return guess
  }
  return []
}

/**
 * Pure: may the owner tick this one? Only when its self-test passed — except an MCP server, which is never started
 * before it is shared, so it may be ticked while 'starting': the tick is the permission to start it and read its
 * tools, and nothing is offered to a buyer until a tool is ticked too.
 */
export const canShare = (s) => { const st = s?.status ?? 'ready'; return st === 'ready' || (st === 'starting' && s?.kind === 'mcp') }

/** Pure: the list the heartbeat sends — what was found plus the owner's share settings, never a key or an env value. */
export function servicesForHub(services, shares = {}) {
  return (services ?? []).map((s) => {
    const sh = shares[s.service_id] ?? {}
    const priced = sh.price_usd !== null && sh.price_usd !== undefined && sh.price_usd !== '' && Number.isFinite(Number(sh.price_usd)) && Number(sh.price_usd) >= 0
    const shared = sh.shared === true && priced && canShare(s)
    const tools = Array.isArray(s.details?.tools) ? s.details.tools : null
    const picked = Array.isArray(sh.tools) ? sh.tools.map(String) : []
    return { service_id: s.service_id, kind: s.kind, provider: s.provider, name: s.name, model: s.model, port: s.port, task: s.task,
      details: s.details ?? {},
      status: s.status ?? 'ready', status_reason: s.status_reason ?? null, last_latency_ms: s.last_latency_ms ?? null,
      shared, paused: sh.paused === true,
      price_usd: shared ? Number(sh.price_usd) : null, price_unit: unitOf(s.kind),
      daily_cap_usd: Number.isFinite(Number(sh.daily_cap_usd)) && Number(sh.daily_cap_usd) > 0 ? Number(sh.daily_cap_usd) : null,
      timeout_seconds: Number.isFinite(Number(sh.timeout_seconds)) && Number(sh.timeout_seconds) > 0 ? Math.min(600, Math.round(Number(sh.timeout_seconds))) : null,
      // MCP: the tools the owner ticked, with their schemas; a risky one is never included unless it was ticked by hand
      tools: s.kind === 'mcp' && tools ? tools.filter((t) => picked.includes(t.name)).map((t) => ({ name: t.name, title: t.title, description: t.description, input_schema: t.input_schema, risky: t.risky === true })) : null,
      tools_found: s.kind === 'mcp' && tools ? tools.length : null,
    }
  })
}

/** Pure: validate the page's share form → config.local_shares. */
export function parseShares(body, services) {
  const byId = new Map((services ?? []).map((s) => [s.service_id, s]))
  const out = {}
  const raw = body && typeof body === 'object' ? body : {}
  for (const [id, v] of Object.entries(raw)) {
    const svc = byId.get(id)
    if (!svc || !v || typeof v !== 'object') continue
    const price = v.price_usd === '' || v.price_usd === null || v.price_usd === undefined ? null : Number(v.price_usd)
    if (price !== null && !(Number.isFinite(price) && price >= 0 && price <= 1000)) throw new Error(`${id}: the price must be a number of USD, 0–1000`)
    const cap = v.daily_cap_usd === '' || v.daily_cap_usd === null || v.daily_cap_usd === undefined ? null : Number(v.daily_cap_usd)
    if (cap !== null && !(Number.isFinite(cap) && cap >= 0 && cap <= 100000)) throw new Error(`${id}: the daily cap must be a number of USD`)
    const secs = v.timeout_seconds === '' || v.timeout_seconds === null || v.timeout_seconds === undefined ? null : Number(v.timeout_seconds)
    if (secs !== null && !(Number.isFinite(secs) && secs >= 5 && secs <= 600)) throw new Error(`${id}: the timeout must be 5–600 seconds`)
    const shared = v.shared === true
    if (shared && price === null) throw new Error(`${id}: set a price before sharing it`)
    if (shared && !canShare(svc)) throw new Error(`${id}: ${svc.status_reason ?? 'this service failed its self-test'} — it cannot be shared until that is fixed`)
    const names = new Set((Array.isArray(svc.details?.tools) ? svc.details.tools : []).map((t) => t.name))
    const tools = Array.isArray(v.tools) ? [...new Set(v.tools.map(String))].filter((t) => !names.size || names.has(t)).slice(0, 60) : []
    if (shared && svc.kind === 'mcp' && names.size && !tools.length) throw new Error(`${id}: tick at least one tool before sharing this server`)
    out[id] = { shared, price_usd: price, daily_cap_usd: cap, paused: v.paused === true, timeout_seconds: secs, ...(svc.kind === 'mcp' ? { tools } : {}) }
  }
  return out
}

export const SHARE_LINE = 'Nothing leaves this computer unless you tick it. The buyer\'s prompts are processed here; you could technically see them.'
export const SANDBOX_LINE = 'These are your own programs and they keep running exactly as they do now — outside the sandbox, with your files and your GPU. The AppContainer sandbox is only for buyers\' scripts, never for these.'
