/**
 * 0.4.7 — the relay: a buyer's call to a shared local model arrives at the hub, the node long-polls it, runs it
 * against the local server (Ollama / OpenAI-compatible / Whisper / A1111) and streams the answer back to the hub,
 * which streams it to the buyer. Nothing is written to disk here: no prompt, no answer, no log line with content.
 *
 *   GET  /me/calls?wait=20          → { calls: [{ id, service_id, request }] }   (long poll, empty when idle)
 *   POST /me/calls/:id/chunks       { chunks: [{ seq, delta }] }                  (batched every ~150 ms)
 *   POST /me/calls/:id/finish       { ok, usage: { prompt_tokens, completion_tokens }, duration_ms, error? }
 */

const CHUNK_FLUSH_MS = 150
const CALL_TIMEOUT_MS = 10 * 60 * 1000

export function createRelay({ hub, log = () => {}, services = () => [], fetchImpl = fetch }) {
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
      const req = call.request ?? {}
      let usage = null
      if (svc.kind === 'llm') usage = await chatLocal(svc, req, emit, fetchImpl)
      else if (svc.kind === 'audio') usage = await transcribeLocal(svc, req, emit, fetchImpl)
      else throw new Error(`${svc.kind} calls are not relayed yet (0.4.7 relays LLM chat and speech-to-text)`)
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null }
      await flush()
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

/** Speech-to-text against a whisper-asr-webservice: the request carries audio_base64 + a file name. */
export async function transcribeLocal(svc, req, emit, fetchImpl = fetch) {
  const b64 = typeof req.audio_base64 === 'string' ? req.audio_base64 : null
  if (!b64) throw new Error('speech-to-text needs audio_base64')
  const bytes = Buffer.from(b64, 'base64')
  const form = new FormData()
  form.append('audio_file', new Blob([bytes]), String(req.file_name ?? 'audio.wav'))
  const path = svc.details?.path ?? '/asr'
  const r = await fetchImpl(`${svc.base_url}${path}?output=json${req.language ? `&language=${encodeURIComponent(String(req.language))}` : ''}`, { method: 'POST', body: form })
  if (!r.ok) throw new Error(`whisper answered ${r.status}`)
  const text = await r.text()
  emit(text)
  return { prompt_tokens: 0, completion_tokens: 0, audio_bytes: bytes.length }
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
