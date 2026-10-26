/**
 * 0.4.7 — what this computer already runs that a buyer could use: local model servers and local MCP servers.
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

/**
 * The scan. Returns { services, at, probed }. Deterministic order; each service's `service_id` is stable across
 * scans so the owner's share settings (config.local_shares) follow it.
 */
export async function scanLocalServices({ fetchImpl = fetch, platform = process.platform, home = os.homedir(), env = process.env, readFileImpl = readFile } = {}) {
  const services = []
  const seenPorts = new Set()
  for (const p of PROBES) {
    const body = await probe(fetchImpl, p.port, p.path)
    if (body === null) continue
    let found = []
    if (p.provider === 'ollama') found = fromOllama(body, p.port)
    else if (p.provider === 'lmstudio' || p.provider === 'openai_compat') found = fromOpenAiModels(body, p.provider, p.port)
    else if (p.provider === 'comfyui' || p.provider === 'a1111') found = fromImageServer(body, p.provider, p.port)
    else if (p.provider === 'whisper') found = fromWhisper(body, p.port)
    if (found.length) { seenPorts.add(p.port); services.push(...found) }
  }
  for (const c of mcpConfigPaths(platform, home, env)) {
    let text = null
    try { text = await readFileImpl(c.path, 'utf8') } catch { continue }
    try { services.push(...fromMcpConfig(c.app, JSON.parse(text))) } catch { /* not JSON: skip */ }
  }
  return { services: services.slice(0, 60), at: new Date().toISOString(), probed: PROBES.length, ports: [...seenPorts] }
}

/** Pure: the list the heartbeat sends — what was found plus the owner's share settings, never a key or an env value. */
export function servicesForHub(services, shares = {}) {
  return (services ?? []).map((s) => {
    const sh = shares[s.service_id] ?? {}
    const shared = sh.shared === true && sh.price_usd !== null && sh.price_usd !== undefined && sh.price_usd !== '' && Number.isFinite(Number(sh.price_usd)) && Number(sh.price_usd) >= 0
    return { service_id: s.service_id, kind: s.kind, provider: s.provider, name: s.name, model: s.model, port: s.port, task: s.task, details: s.details ?? {},
      shared, price_usd: shared ? Number(sh.price_usd) : null, price_unit: s.kind === 'llm' ? 'per_1k_tokens' : 'per_call', daily_cap_usd: Number.isFinite(Number(sh.daily_cap_usd)) && Number(sh.daily_cap_usd) > 0 ? Number(sh.daily_cap_usd) : null }
  })
}

/** Pure: validate the page's share form → config.local_shares. */
export function parseShares(body, services) {
  const ids = new Set((services ?? []).map((s) => s.service_id))
  const out = {}
  const raw = body && typeof body === 'object' ? body : {}
  for (const [id, v] of Object.entries(raw)) {
    if (!ids.has(id) || !v || typeof v !== 'object') continue
    const price = v.price_usd === '' || v.price_usd === null || v.price_usd === undefined ? null : Number(v.price_usd)
    if (price !== null && !(Number.isFinite(price) && price >= 0 && price <= 1000)) throw new Error(`${id}: the price must be a number of USD, 0–1000`)
    const cap = v.daily_cap_usd === '' || v.daily_cap_usd === null || v.daily_cap_usd === undefined ? null : Number(v.daily_cap_usd)
    if (cap !== null && !(Number.isFinite(cap) && cap >= 0 && cap <= 100000)) throw new Error(`${id}: the daily cap must be a number of USD`)
    const shared = v.shared === true
    if (shared && price === null) throw new Error(`${id}: set a price before sharing it`)
    out[id] = { shared, price_usd: price, daily_cap_usd: cap }
  }
  return out
}

export const SHARE_LINE = 'Nothing leaves this computer unless you tick it. The buyer\'s prompts are processed here; you could technically see them.'
