/**
 * 0.4.8 — the owner's own MCP servers, shared tool by tool.
 *
 * The scanner reads the editors' configs (local-scan.mjs) but never starts anything. Sharing one means THIS file
 * starts it on demand — a stdio child process with the command the config already holds, or plain HTTP when the
 * config gives a url — speaks JSON-RPC over it (`initialize`, `tools/list` once, then `tools/call` per paid call)
 * and stops it again after IDLE_STOP_MS of no calls. Nothing of a call is written to disk here.
 *
 * The owner picks tools one by one, and a tool that can read or change files or run commands is marked and
 * UNTICKED by default: `riskyTool` is that rule, and the local page prints the red line next to it.
 */
import { spawn } from 'node:child_process'

export const IDLE_STOP_MS = 10 * 60 * 1000
export const START_TIMEOUT_MS = 20_000
export const CALL_TIMEOUT_MS = 120_000
export const RISK_LINE = 'this tool can read or change files on your computer'

/** Pure: does this tool touch the filesystem or a shell? Then it is risky and starts unticked. */
export function riskyTool(tool) {
  const hay = `${tool?.name ?? ''} ${tool?.description ?? ''} ${JSON.stringify(tool?.inputSchema ?? tool?.input_schema ?? {})}`.toLowerCase()
  return /\b(file|files|directory|dir|folder|path|write|delete|remove|move|edit|shell|bash|exec|command|process|sudo|chmod|git )/.test(hay)
}

/** Pure: a tools/list answer → the rows the local page shows and the hub is told about. */
export function toolRows(listed) {
  return (Array.isArray(listed) ? listed : []).slice(0, 60).map((t) => ({
    name: String(t?.name ?? '').slice(0, 120),
    title: String(t?.title ?? t?.name ?? '').slice(0, 160),
    description: String(t?.description ?? '').slice(0, 1200),
    input_schema: t?.inputSchema ?? t?.input_schema ?? { type: 'object' },
    risky: riskyTool(t),
  })).filter((t) => t.name)
}

/** Pure: the command string from the config → argv, respecting simple quotes. */
export function argvOf(command) {
  const parts = String(command ?? '').match(/"[^"]*"|'[^']*'|\S+/g) ?? []
  return parts.map((p) => (/^["']/.test(p) ? p.slice(1, -1) : p))
}

// ───────────── one server, alive or not ─────────────

class StdioServer {
  constructor(command, log) {
    const argv = argvOf(command)
    if (!argv.length) throw new Error('this MCP server has no command in the editor config')
    this.log = log
    this.child = spawn(argv[0], argv.slice(1), { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env } })
    this.buf = ''
    this.waiting = new Map()
    this.nextId = 1
    this.dead = null
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (d) => { this.buf += d; let i; while ((i = this.buf.indexOf('\n')) >= 0) { const line = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1); this.#onLine(line) } })
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', (d) => log(`mcp stderr: ${String(d).split('\n')[0].slice(0, 200)}`))
    this.child.on('exit', (code) => { this.dead = `the server exited with code ${code}`; for (const [, w] of this.waiting) w.reject(new Error(this.dead)); this.waiting.clear() })
    this.child.on('error', (e) => { this.dead = e.message; for (const [, w] of this.waiting) w.reject(e); this.waiting.clear() })
  }
  #onLine(line) {
    if (!line.trim()) return
    let j; try { j = JSON.parse(line) } catch { return }
    const w = this.waiting.get(j.id)
    if (!w) return
    this.waiting.delete(j.id)
    if (j.error) w.reject(new Error(String(j.error.message ?? 'the MCP server refused').slice(0, 300)))
    else w.resolve(j.result)
  }
  request(method, params, timeoutMs) {
    if (this.dead) return Promise.reject(new Error(this.dead))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiting.delete(id); reject(new Error(`the MCP server did not answer ${method} in time`)) }, timeoutMs)
      this.waiting.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v) }, reject: (e) => { clearTimeout(timer); reject(e) } })
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }
  notify(method, params) { if (!this.dead) this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`) }
  stop() { try { this.child.kill('SIGTERM') } catch { /* already gone */ } }
}

class HttpServer {
  constructor(url) { this.url = url; this.nextId = 1; this.session = null }
  async request(method, params, timeoutMs) {
    const ac = new AbortController(); const t = setTimeout(() => ac.abort(), timeoutMs)
    try {
      const r = await fetch(this.url, { method: 'POST', signal: ac.signal, headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(this.session ? { 'mcp-session-id': this.session } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: this.nextId++, method, params }) })
      const sid = r.headers.get('mcp-session-id'); if (sid) this.session = sid
      if (!r.ok) throw new Error(`the MCP server answered ${r.status}`)
      const text = await r.text()
      const line = text.startsWith('event:') || text.includes('\ndata:') ? (text.split('\n').find((l) => l.startsWith('data:')) ?? '').slice(5) : text
      const j = JSON.parse(line.trim())
      if (j.error) throw new Error(String(j.error.message ?? 'the MCP server refused').slice(0, 300))
      return j.result
    } finally { clearTimeout(t) }
  }
  notify() { /* http transport needs none */ }
  stop() { this.session = null }
}

/**
 * The pool: one live server per service_id, started on demand, stopped when idle.
 * `tools(svc)` starts it, lists once and caches; `call(svc, tool, args)` relays one tool call.
 */
export function createMcpPool({ log = () => {}, idleStopMs = IDLE_STOP_MS, now = () => Date.now() } = {}) {
  const live = new Map()   // service_id → { server, tools, lastUsed, startedAt }

  async function open(svc) {
    const have = live.get(svc.service_id)
    if (have && !have.server.dead) { have.lastUsed = now(); return have }
    const url = svc.details?.url ?? svc.base_url ?? null
    const server = url ? new HttpServer(String(url)) : new StdioServer(svc.details?.command, log)
    const init = await server.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'versum-node', version: '0.4.8' } }, START_TIMEOUT_MS)
    server.notify('notifications/initialized', {})
    const listed = await server.request('tools/list', {}, START_TIMEOUT_MS)
    const entry = { server, tools: toolRows(listed?.tools), lastUsed: now(), startedAt: now(), info: init?.serverInfo ?? null }
    live.set(svc.service_id, entry)
    log(`mcp ${svc.name}: started, ${entry.tools.length} tool(s)`)
    return entry
  }

  return {
    /** The tool list, starting the server if needed (the only time a shared server is started without a paid call). */
    async tools(svc) { return (await open(svc)).tools },
    /** One paid call. Returns the MCP result as it came, text flattened for the buyer. */
    async call(svc, toolName, args) {
      const e = await open(svc)
      const t = e.tools.find((x) => x.name === toolName)
      if (!t) throw new Error(`this server has no tool named ${toolName}`)
      e.lastUsed = now()
      const res = await e.server.request('tools/call', { name: toolName, arguments: args && typeof args === 'object' ? args : {} }, CALL_TIMEOUT_MS)
      e.lastUsed = now()
      const text = (Array.isArray(res?.content) ? res.content : []).filter((c) => c?.type === 'text').map((c) => String(c.text)).join('\n')
      if (res?.isError) throw new Error(`the tool failed: ${(text || 'no message').slice(0, 300)}`)
      return { text, content: res?.content ?? [], structured: res?.structuredContent ?? null }
    },
    /** Stop every server idle longer than the limit (called on the node's tick). */
    reap() {
      const t = now()
      let stopped = 0
      for (const [id, e] of [...live]) if (t - e.lastUsed > idleStopMs) { e.server.stop(); live.delete(id); stopped++; log(`mcp ${id}: stopped after ${Math.round(idleStopMs / 60000)} min idle`) }
      return stopped
    },
    stopAll() { for (const [, e] of live) e.server.stop(); live.clear() },
    alive: () => [...live.keys()],
  }
}
