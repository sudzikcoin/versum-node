import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bundlePlan, createBundlePuller } from '../lib/local-bundle.mjs'
test('bundle plan: pull the Ollama models that are missing, report the ones that need a server', () => {
  const plan = bundlePlan({ name: 'office', models: [{ provider: 'ollama', model: 'qwen2.5:14b' }, { provider: 'ollama', model: 'nomic-embed-text' }, { provider: 'whisper', model: 'whisper' }] }, [{ provider: 'ollama', model: 'qwen2.5:14b' }])
  assert.deepEqual(plan.pull, ['nomic-embed-text']); assert.equal(plan.missing.length, 1); assert.match(plan.missing[0], /needs its server/)
})
test('bundle puller: one pull per missing model, nothing twice, failures recorded', async () => {
  const calls = []
  const puller = createBundlePuller({ fetchImpl: async (url, init) => { calls.push(JSON.parse(init.body).model); return { ok: !JSON.parse(init.body).model.includes('bad') } } })
  await puller.apply({ name: 'dev', models: [{ provider: 'ollama', model: 'a' }, { provider: 'ollama', model: 'bad:1' }] }, [])
  await new Promise((r) => setTimeout(r, 20))
  assert.deepEqual(calls, ['a', 'bad:1']); assert.deepEqual(puller.state().pulled, ['a']); assert.match(puller.state().error, /bad:1/)
})
