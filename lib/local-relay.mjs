/**
 * 0.4.7 / 0.4.8 — the relay: a buyer's call to a shared local service arrives at the hub, the node long-polls it,
 * runs it against the local server and streams the answer back to the hub, which streams it to the buyer.
 * Nothing is written to disk here: no prompt, no answer, no file, no log line with content — a file a call
 * produces (a PNG, an .srt) is posted straight to the hub from memory.
 *
 * 0.4.8 relays all four kinds:
 *   llm    chat, token by token            (Ollama NDJSON / OpenAI SSE)        priced per 1,000 tokens
 *   image  text to image                   (ComfyUI workflow / A1111 txt2img)  priced per image
 *   audio  speech to text + subtitles      (whisper-asr or /v1/audio/…)        priced per minute of audio
 *   mcp    one tool call on a local server  (local-mcp.mjs, started on demand)  priced per call
 *
 *   GET  /me/calls?wait=20          → { calls: [{ id, service_id, request }] }   (long poll, empty when idle)
 *   POST /me/calls/:id/chunks       { chunks: [{ seq, delta }] }                  (batched every ~150 ms)
 *   POST /me/calls/:id/files        { files: [{ name, content_type, content_base64 }] }
 *   POST /me/calls/:id/finish       { ok, usage, duration_ms, error? }
 */

const CHUNK_FLUSH_MS = 150
const CALL_TIMEOUT_MS = 10 * 60 * 1000

export function createRelay({ hub, log = () => {}, services = () => [], fetchImpl = fetch, mcpPool = null }) {
  let running = false, stop = false
  const active = new Map()

  const serviceOf = (id) => services().find((s) => s.service_id === id) ?? null

  /** One call, start to finish. */
  async function run(call) {
    const t0 = Date.now()
    const svc = serviceOf(call.service_id)
    const seqRef = { n: 0 }
    let pending = []
    let flushTimer = null
    const flush = async () => {
      if (!pending.length) return
      const batch = pending; pending = []
      await hub.callChunks(call.id, { chunks: batch }).catch((e) => log(`relay ${call.id.slice(0, 8)}: chunk post failed: ${e.message}`))
    }
    const emit = (delta) => {
      pending.push({ seq: seqRef.n++, delta })
      if (!flushTimer) flushTimer = setTimeout(() => { flushTimer = null; void flush() }, CHUNK_FLUSH_MS)
    }
    try {
      if (!svc) throw new Error('service not shared on this node any more')
      if (svc.paused) throw new Error('the owner paused this service')
      const req = call.request ?? {}
      const timeoutMs = Math.max(5000, Math.min(600_000, (Number(svc.timeout_seconds) || 120) * 1000))
      let usage = null
      let files = []
      if (svc.kind === 'llm') usage = await chatLocal(svc, req, emit, fetchImpl)
      else if (svc.kind === 'audio') { const a = await transcribeLocal(svc, req, emit, fetchImpl, timeoutMs); usage = a.usage; files = a.files }
      else if (svc.kind === 'image') { const im = await imageLocal(svc, req, emit, fetchImpl, timeoutMs); usage = im.usage; files = im.files }
      else if (svc.kind === 'mcp') usage = await mcpLocal(svc, req, emit, mcpPool)
      else throw new Error(`${svc.kind} is not a kind this node can relay`)
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null }
      await flush()
      if (files.length) { await hub.callFiles(call.id, files.map((f) => ({ name: f.name, content_type: f.content_type, content_base64: f.bytes.toString('base64') }))); log(`relay ${call.id.slice(0, 8)}: ${files.length} file(s) posted`) }
      await hub.callFinish(call.id, { ok: true, usage, duration_ms: Date.now() - t0 })
    } catch (e) {
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null }
      await flush().catch(() => {})
      await hub.callFinish(call.id, { ok: false, error: String(e.message).slice(0, 500), duration_ms: Date.now() - t0 }).catch((err) => log(`relay ${call.id.slice(0, 8)}: finish failed: ${err.message}`))
      log(`relay ${call.id.slice(0, 8)}: failed — ${String(e.message).split('\n')[0]}`)
    } finally { active.delete(call.id) }
  }

  async function loop() {
    running = true
    while (!stop) {
      if (!services().some((s) => s.shared)) { await new Promise((r) => setTimeout(r, 5000)); continue }
      try {
        const r = await hub.calls({ wait: 20 })
        for (const c of r?.calls ?? []) if (!active.has(c.id)) { active.set(c.id, true); log(`relay: call ${c.id.slice(0, 8)} for ${c.service_id}`); void run(c) }
      } catch (e) { log(`relay: poll failed: ${e.message}`); await new Promise((r) => setTimeout(r, 5000)) }
    }
    running = false
  }

  return { start: () => { if (!running) void loop() }, stop: () => { stop = true }, active: () => active.size }
}

/** Pure: messages from an OpenAI-style request (or a bare prompt). */
export function messagesOf(req) {
  if (Array.isArray(req?.messages) && req.messages.length) return req.messages.map((m) => ({ role: String(m.role ?? 'user'), content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '') }))
  const prompt = typeof req?.prompt === 'string' ? req.prompt : typeof req?.input === 'string' ? req.input : ''
  return [{ role: 'user', content: prompt }]
}

/** Chat against Ollama (/api/chat, NDJSON) or an OpenAI-compatible server (/chat/completions, SSE). Streams deltas; returns usage. */
export async function chatLocal(svc, req, emit, fetchImpl = fetch) {
  const messages = messagesOf(req)
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), CALL_TIMEOUT_MS)
  try {
    if (svc.provider === 'ollama') {
      const options = {}
      if (req.temperature != null) options.temperature = Number(req.temperature)
      if (req.max_tokens != null) options.num_predict = Number(req.max_tokens)
      const r = await fetchImpl(`${svc.base_url}/api/chat`, { method: 'POST', signal: ac.signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: svc.model, messages, stream: true, options }) })
      if (!r.ok) throw new Error(`ollama answered ${r.status}: ${(await r.text()).slice(0, 200)}`)
      let usage = { prompt_tokens: 0, completion_tokens: 0 }
      for await (const line of lines(r.body)) {
        if (!line.trim()) continue
        let j; try { j = JSON.parse(line) } catch { continue }
        if (j.message?.content) emit(j.message.content)
        if (j.done) usage = { prompt_tokens: Number(j.prompt_eval_count ?? 0), completion_tokens: Number(j.eval_count ?? 0), eval_duration_ms: j.eval_duration ? Math.round(Number(j.eval_duration) / 1e6) : null }
      }
      return usage
    }
    // OpenAI-compatible (LM Studio, llama.cpp, vLLM)
    const body = { model: svc.model, messages, stream: true, stream_options: { include_usage: true }, ...(req.temperature != null ? { temperature: Number(req.temperature) } : {}), ...(req.max_tokens != null ? { max_tokens: Number(req.max_tokens) } : {}) }
    const r = await fetchImpl(`${svc.base_url}/chat/completions`, { method: 'POST', signal: ac.signal, headers: { 'content-type': 'application/json', accept: 'text/event-stream' }, body: JSON.stringify(body) })
    if (!r.ok) throw new Error(`${svc.provider} answered ${r.status}: ${(await r.text()).slice(0, 200)}`)
    let usage = { prompt_tokens: 0, completion_tokens: 0 }
    let out = 0
    for await (const line of lines(r.body)) {
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (data === '[DONE]') break
      let j; try { j = JSON.parse(data) } catch { continue }
      const delta = j.choices?.[0]?.delta?.content
      if (delta) { emit(delta); out += 1 }
      if (j.usage) usage = { prompt_tokens: Number(j.usage.prompt_tokens ?? 0), completion_tokens: Number(j.usage.completion_tokens ?? 0) }
    }
    if (!usage.completion_tokens && out) usage.completion_tokens = out   // a server without usage: count the pieces
    return usage
  } finally { clearTimeout(t) }
}

/** Pure: whisper segments → an .srt the buyer can use. */
export function srtOf(segments) {
  const stamp = (sec) => {
    const ms = Math.max(0, Math.round(Number(sec) * 1000))
    const h = String(Math.floor(ms / 3600000)).padStart(2, '0')
    const m = String(Math.floor((ms % 3600000) / 60000)).padStart(2, '0')
    const s2 = String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')
    return `${h}:${m}:${s2},${String(ms % 1000).padStart(3, '0')}`
  }
  return (Array.isArray(segments) ? segments : []).map((g, i) => `${i + 1}\n${stamp(g.start ?? g.offsets?.from / 1000 ?? 0)} --> ${stamp(g.end ?? g.offsets?.to / 1000 ?? 0)}\n${String(g.text ?? '').trim()}\n`).join('\n')
}

/** Pure: how many minutes of audio a call carried (6 decimals) — what the owner is paid for. */
export function audioMinutes({ duration_s = null, bytes = 0 }) {
  const s = Number.isFinite(Number(duration_s)) && Number(duration_s) > 0 ? Number(duration_s) : bytes / (16000 * 2)
  return Math.max(0.000001, Math.round((s / 60) * 1e6) / 1e6)
}

/** The audio bytes of a call: the job's input file (a signed url the hub minted) or inline base64. */
async function audioOf(req, fetchImpl) {
  if (typeof req.audio_base64 === 'string' && req.audio_base64) return { bytes: Buffer.from(req.audio_base64, 'base64'), name: String(req.file_name ?? 'audio.wav') }
  const url = typeof req.audio_url === 'string' ? req.audio_url : Array.isArray(req.inputs) && typeof req.inputs[0]?.url === 'string' ? req.inputs[0].url : null
  if (!url) throw new Error('speech-to-text needs an audio file: audio_url (the job input) or audio_base64')
  const r = await fetchImpl(url)
  if (!r.ok) throw new Error(`the audio file could not be fetched (${r.status})`)
  const name = String(req.file_name ?? (new URL(url).pathname.split('/').pop() || 'audio.wav')).slice(0, 120)
  return { bytes: Buffer.from(await r.arrayBuffer()), name }
}

/**
 * Speech-to-text. Two shapes of server: whisper-asr-webservice (/asr, multipart `audio_file`) and anything that
 * speaks OpenAI's /v1/audio/transcriptions (faster-whisper-server, speaches, whisper.cpp server) with `file`.
 * Returns the text as the streamed answer plus two files: the .txt and the .srt.
 */
export async function transcribeLocal(svc, req, emit, fetchImpl = fetch, timeoutMs = CALL_TIMEOUT_MS) {
  const { bytes, name } = await audioOf(req, fetchImpl)
  const base = String(name).replace(/\.[^.]+$/, '') || 'audio'
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const blob = new Blob([bytes], { type: 'audio/wav' })
    let text = '', segments = []
    let duration = null
    if (svc.provider === 'whisper_openai' || svc.details?.api === 'openai-audio') {
      const form = new FormData()
      form.append('file', blob, name); form.append('model', String(req.model ?? svc.model ?? 'whisper-1'))
      form.append('response_format', 'verbose_json')
      if (req.language) form.append('language', String(req.language))
      const r = await fetchImpl(`${svc.base_url}${svc.details?.path ?? '/v1/audio/transcriptions'}`, { method: 'POST', body: form, signal: ac.signal })
      if (!r.ok) throw new Error(`the speech server answered ${r.status}: ${(await r.text()).slice(0, 200)}`)
      const body = await r.text()
      let j = null; try { j = JSON.parse(body) } catch { /* a server that only speaks plain text */ }
      text = String(j?.text ?? body ?? '').trim()
      segments = Array.isArray(j?.segments) ? j.segments : []
      if (Number.isFinite(Number(j?.duration))) duration = Number(j.duration)
    } else {
      const form = new FormData()
      form.append('audio_file', blob, name)
      const path = svc.details?.path ?? '/asr'
      const r = await fetchImpl(`${svc.base_url}${path}?output=json${req.language ? `&language=${encodeURIComponent(String(req.language))}` : ''}`, { method: 'POST', body: form, signal: ac.signal })
      if (!r.ok) throw new Error(`the speech server answered ${r.status}`)
      const body = await r.text()
      let j = null; try { j = JSON.parse(body) } catch { /* plain text */ }
      text = String(j?.text ?? body ?? '').trim()
      segments = Array.isArray(j?.segments) ? j.segments : []
    }
    emit(text)
    const srt = segments.length ? srtOf(segments) : `1\n00:00:00,000 --> ${new Date(Math.round(audioMinutes({ bytes: bytes.length }) * 60000)).toISOString().slice(11, 23).replace('.', ',')}\n${text}\n`
    const minutes = audioMinutes({ duration_s: duration ?? (Number(req.duration_s ?? segments[segments.length - 1]?.end ?? 0) || null), bytes: bytes.length })
    return {
      usage: { prompt_tokens: 0, completion_tokens: 0, audio_bytes: bytes.length, audio_minutes: minutes, units: minutes },
      files: [
        { name: `${base}.txt`, content_type: 'text/plain; charset=utf-8', bytes: Buffer.from(`${text}\n`, 'utf8') },
        { name: `${base}.srt`, content_type: 'application/x-subrip', bytes: Buffer.from(srt, 'utf8') },
      ],
    }
  } finally { clearTimeout(t) }
}

/** Text to image: the local image server does the work, the PNGs go to the hub as the job's outputs. */
export async function imageLocal(svc, req, emit, fetchImpl = fetch, timeoutMs = 120_000) {
  const { generateImage } = await import('./local-image.mjs')
  emit(`generating ${Math.min(4, Math.max(1, Number(req.count ?? req.n ?? 1)))} image(s) on ${svc.name}…\n`)
  const out = await generateImage(svc, req, fetchImpl, timeoutMs, (note) => emit(`${note}\n`))
  emit(`done: ${out.files.length} image(s), seed ${out.seed}\n`)
  return { usage: { prompt_tokens: 0, completion_tokens: 0, images: out.files.length, units: out.files.length, seed: out.seed, model: out.model }, files: out.files }
}

/** One tool call on the owner's local MCP server, relayed as it came. */
export async function mcpLocal(svc, req, emit, mcpPool) {
  if (!mcpPool) throw new Error('this node has no MCP pool')
  const tool = String(req.tool ?? req.name ?? '').trim()
  if (!tool) throw new Error('an MCP call needs `tool`')
  const allowed = Array.isArray(svc.tools) ? svc.tools.map((t) => t.name) : []
  if (allowed.length && !allowed.includes(tool)) throw new Error(`the owner did not share a tool named ${tool} (shared: ${allowed.join(', ')})`)
  const out = await mcpPool.call(svc, tool, req.args ?? req.arguments ?? {})
  emit(out.text || JSON.stringify(out.structured ?? out.content ?? null))
  return { prompt_tokens: 0, completion_tokens: 0, calls: 1, units: 1 }
}

/** Lines from a web stream. */
async function* lines(body) {
  const reader = body.getReader(); const dec = new TextDecoder(); let buf = ''
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let i
    while ((i = buf.indexOf('\n')) >= 0) { yield buf.slice(0, i); buf = buf.slice(i + 1) }
  }
  if (buf) yield buf
}
