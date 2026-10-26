/**
 * Private pools (hub Block 4, 2026-10-26) — a pooled machine hears its pool's bundle in the heartbeat answer
 * (`bundle: { name, models: [{ provider, model }] }`) and pulls the Ollama models itself through the local Ollama
 * (`POST /api/pull`), one at a time, skipping what is already there. Nothing else is installed: models that need
 * their own server (whisper, ComfyUI/Flux, TTS) are only reported as missing. Pure parts: `bundlePlan`.
 */
export function bundlePlan(bundle, found) {
  const have = new Set((found ?? []).filter((s) => s.provider === 'ollama').map((s) => s.model))
  const pull = [], missing = []
  for (const m of bundle?.models ?? []) {
    if (m.provider === 'ollama') { if (!have.has(m.model)) pull.push(m.model) }
    else missing.push(`${m.model} (${m.provider}: needs its server on this machine)`)
  }
  return { pull, missing }
}

export function createBundlePuller({ log = () => {}, fetchImpl = fetch, ollamaUrl = 'http://127.0.0.1:11434' } = {}) {
  let running = null
  const state = { bundle: null, pulled: [], missing: [], pulling: null, error: null }
  async function apply(bundle, found) {
    state.bundle = bundle?.name ?? null
    if (!bundle || running) return state
    const { pull, missing } = bundlePlan(bundle, found)
    state.missing = missing
    if (!pull.length) return state
    running = (async () => {
      for (const model of pull) {
        state.pulling = model
        log(`bundle ${bundle.name}: pulling ${model} through the local Ollama`)
        try {
          const r = await fetchImpl(`${ollamaUrl}/api/pull`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, stream: false }) })
          if (!r.ok) throw new Error(`ollama answered ${r.status}`)
          state.pulled.push(model); log(`bundle ${bundle.name}: ${model} ready`)
        } catch (e) { state.error = `${model}: ${e.message}`; log(`bundle ${bundle.name}: ${model} failed — ${e.message}`) }
      }
      state.pulling = null; running = null
    })()
    return state
  }
  return { apply, state: () => state }
}
