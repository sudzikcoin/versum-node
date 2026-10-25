// The self-updater (lib/update.mjs): the pure decisions on any platform, and the whole download → verify → smoke →
// swap → finish → settle (and roll back) path on Linux with a shell script standing in for the binary, the system tar,
// and a fetch that serves a tarball from disk — what the Windows and macOS runners then prove with the real binary.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, chmodSync, createReadStream } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { Readable } from 'node:stream'
import { compareVersions, wantsUpdate, assetUrlAllowed, describeUpdate, swapPlan, createUpdater, sha256File, MARKER } from '../lib/update.mjs'

const A = (sha = 'a'.repeat(64), url = 'https://github.com/sudzikcoin/versum-node/releases/download/v0.4.4/versum-node-update-win32-x64.tar.gz') => ({ url, sha256: sha, size: 10 })

test('versions compare as semver; a pre-release is older than its release', () => {
  assert.equal(compareVersions('0.4.3', '0.4.2'), 1)
  assert.equal(compareVersions('0.4.3', '0.4.3'), 0)
  assert.equal(compareVersions('v0.4.3', '0.4.10'), -1)
  assert.equal(compareVersions('0.4.4-rc.1', '0.4.3'), 1)
  assert.equal(compareVersions('0.4.4-rc.1', '0.4.4'), -1)
  assert.equal(compareVersions('0.4.4-rc.2', '0.4.4-rc.10'), -1)
  assert.equal(compareVersions('0.0.0-abc1234', '0.4.3'), -1)
  assert.equal(compareVersions('garbage', '0.4.3'), -1)
})

test('wantsUpdate: newer release with a verifiable asset for this platform, and nothing else', () => {
  const win = { platform: 'win32', arch: 'x64' }
  assert.deepEqual(wantsUpdate({ current: '0.4.3', release: { version: 'v0.4.4', assets: { 'win32-x64': A() } }, ...win }), { to: '0.4.4', key: 'win32-x64', asset: { url: A().url, sha256: 'a'.repeat(64), size: 10 } })
  assert.equal(wantsUpdate({ current: '0.4.4', release: { version: '0.4.4', assets: { 'win32-x64': A() } }, ...win }), null, 'same version')
  assert.equal(wantsUpdate({ current: '0.4.5', release: { version: '0.4.4', assets: { 'win32-x64': A() } }, ...win }), null, 'never a downgrade')
  assert.equal(wantsUpdate({ current: '0.4.3', release: { version: '0.4.4', assets: { 'darwin-arm64': A() } }, ...win }), null, 'no asset for this platform')
  assert.equal(wantsUpdate({ current: '0.4.3', release: { version: '0.4.4', assets: { 'win32-x64': A('nothex') } }, ...win }), null, 'no usable sha256')
  assert.equal(wantsUpdate({ current: '0.4.3', release: { version: '0.4.4', assets: { 'win32-x64': A(undefined, 'https://evil.example/x.tar.gz') } }, ...win }), null, 'foreign host')
  assert.equal(wantsUpdate({ current: '0.4.3', release: { version: '0.4.4', assets: { 'win32-x64': A() } }, platform: 'linux', arch: 'x64' }), null, 'Linux nodes install from the script')
  assert.equal(wantsUpdate({ current: '0.4.3', release: null, ...win }), null)
  // the hub may hand the one asset for the platform it was told about
  assert.equal(wantsUpdate({ current: '0.4.3', release: { version: '0.4.4', asset: A() }, ...win }).to, '0.4.4')
  // a dev or rc build follows an override only — a CI node must not hop onto the real release mid-test
  assert.equal(wantsUpdate({ current: '0.0.0-abc1234', release: { version: '0.4.3', asset: A() }, ...win }), null)
  assert.equal(wantsUpdate({ current: '0.0.0-abc1234', release: { version: '0.4.3', asset: A(), override: true }, ...win }).to, '0.4.3')
  assert.equal(wantsUpdate({ current: '0.4.3', release: { version: '0.4.4-rc.7', asset: A(undefined, 'http://127.0.0.1:3399/rc.tar.gz'), override: true }, ...win }).to, '0.4.4-rc.7')
})

test('asset URLs: our release page, GitHub\'s object store, loopback for the e2e', () => {
  assert.ok(assetUrlAllowed('https://github.com/sudzikcoin/versum-node/releases/download/v0.4.4/versum-node-update-darwin-arm64.tar.gz'))
  assert.ok(assetUrlAllowed('https://objects.githubusercontent.com/github-production-release-asset/1/2?x=y'))
  assert.ok(assetUrlAllowed('http://127.0.0.1:3399/rc.tar.gz'))
  assert.ok(!assetUrlAllowed('https://github.com/someone-else/versum-node/releases/download/v1/x.tar.gz'))
  assert.ok(!assetUrlAllowed('http://github.com/sudzikcoin/versum-node/releases/download/v1/x.tar.gz'))
  assert.ok(!assetUrlAllowed('http://10.0.0.1:3399/rc.tar.gz'))
})

test('the page line says what is happening, and the swap plan never touches the home or a .prev entry', () => {
  assert.equal(describeUpdate({ status: 'idle' }), null)
  assert.match(describeUpdate({ status: 'downloading', to: '0.4.4', bytes_done: 5 * 1048576, bytes_total: 40 * 1048576 }), /updating to v0\.4\.4 — downloading 5 of 40 MB/)
  assert.match(describeUpdate({ status: 'ready', to: '0.4.4' }), /waiting for the running job/)
  assert.match(describeUpdate({ status: 'done', to: '0.4.4', from: '0.4.3' }), /updated to v0\.4\.4 from v0\.4\.3/)
  assert.match(describeUpdate({ status: 'rolled_back', to: '0.4.4', from: '0.4.3', error: 'x' }), /rolled back.*still on v0\.4\.3/)
  assert.deepEqual(swapPlan(['versum-node.exe', 'python', 'home', 'python.prev', 'node.log', '.smoke-home', 'launch.vbs']), ['versum-node.exe', 'python', 'launch.vbs'])
})

/** a release bundle: a shell script that answers `version` with the version asked, version.txt beside it */
function bundle(dir, version) {
  mkdirSync(join(dir, 'probe'), { recursive: true })
  writeFileSync(join(dir, 'versum-node'), `#!/bin/sh\n[ "$1" = version ] && echo "versum-node ${version}"\nexit 0\n`); chmodSync(join(dir, 'versum-node'), 0o755)
  writeFileSync(join(dir, 'version.txt'), `v${version}\n`); writeFileSync(join(dir, 'probe', 'sandbox_probe.py'), '# probe\n'); writeFileSync(join(dir, 'pylib-lock.json'), '{}')
  const tgz = dir + '.tar.gz'
  execFileSync('tar', ['-czf', tgz, '-C', dir, '.'])
  return { tgz, sha256: sha256File(tgz), size: readFileSync(tgz).length }
}
const serve = (file) => async () => ({ ok: true, status: 200, body: Readable.toWeb(createReadStream(file)) })
const until = async (fn, ms = 20_000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 25)) } }
const mac = { platform: 'darwin', arch: 'arm64' }   // the app-directory swap, exercised here on Linux (same renames, same tar)

test('download → verify → smoke → swap when idle → the next start verifies → a good heartbeat settles', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'vn-upd-'))
  const app = join(tmp, 'app'), state = join(tmp, 'state'); mkdirSync(state, { recursive: true })
  bundle(app, '0.4.3'); writeFileSync(join(app, 'uninstall.sh'), '#!/bin/sh\necho bye\n')
  const rel = bundle(join(tmp, 'new'), '0.9.9')
  const logs = []; let exited = null
  const upd = createUpdater({ appRoot: app, stateDir: state, current: '0.4.3', ...mac, log: (m) => logs.push(m), fetchFn: serve(rel.tgz), exit: (c) => { exited = c }, isSea: true })
  upd.offer({ version: 'v0.9.9', assets: { 'darwin-arm64': { url: 'http://127.0.0.1:3399/rc.tar.gz', sha256: rel.sha256, size: rel.size } } })
  await until(() => upd.state().status === 'ready')
  assert.ok(upd.pending())
  assert.match(logs.join('\n'), /downloaded, verified and started once/)
  assert.equal(readFileSync(join(app, 'version.txt'), 'utf8').trim(), 'v0.4.3', 'nothing touched before the swap')
  assert.equal(await upd.applyIfIdle({ running: 1 }), false, 'a running job holds the swap')
  assert.equal(await upd.applyIfIdle({ running: 0 }), true)
  assert.equal(exited, 0, 'the old process exits; the service starts the new binary')
  assert.equal(readFileSync(join(app, 'version.txt'), 'utf8').trim(), 'v0.9.9')
  assert.ok(existsSync(join(app + '.prev', 'versum-node')), 'the previous tree is kept until the new one checked in')
  assert.ok(existsSync(join(app, 'uninstall.sh')), 'the installer-written uninstall script rides along')
  const marker = JSON.parse(readFileSync(join(state, MARKER), 'utf8'))
  assert.equal(marker.phase, 'applying'); assert.equal(marker.to, '0.9.9'); assert.equal(marker.from, '0.4.3')
  // the new process
  let exited2 = null
  const next = createUpdater({ appRoot: app, stateDir: state, current: '0.9.9', ...mac, log: (m) => logs.push(m), exit: (c) => { exited2 = c }, isSea: true })
  const m2 = await next.finish()
  assert.equal(m2.phase, 'verifying'); assert.equal(m2.starts, 1); assert.equal(exited2, null)
  assert.equal(next.state().status, 'verifying')
  next.settle()
  assert.equal(next.state().status, 'done')
  assert.ok(!existsSync(app + '.prev'), 'the previous tree is gone after the first good heartbeat')
  assert.equal(JSON.parse(readFileSync(join(state, MARKER), 'utf8')).phase, 'done')
  assert.match(describeUpdate(next.state()), /updated to v0\.9\.9 from v0\.4\.3/)
  // the same release offered again is nothing
  next.offer({ version: '0.9.9', assets: { 'darwin-arm64': { url: 'http://127.0.0.1:3399/rc.tar.gz', sha256: rel.sha256 } } })
  assert.equal(next.state().status, 'done')
})

test('a wrong hash never swaps; a wrong version after the swap rolls back; too many starts roll back', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'vn-upd-'))
  const app = join(tmp, 'app'), state = join(tmp, 'state'); mkdirSync(state, { recursive: true })
  bundle(app, '0.4.3')
  const rel = bundle(join(tmp, 'new'), '0.9.9')
  const logs = []
  const bad = createUpdater({ appRoot: app, stateDir: state, current: '0.4.3', ...mac, log: (m) => logs.push(m), fetchFn: serve(rel.tgz), exit: () => {}, isSea: true })
  bad.offer({ version: '0.9.9', assets: { 'darwin-arm64': { url: 'http://127.0.0.1:3399/rc.tar.gz', sha256: 'b'.repeat(64) } } })
  await until(() => bad.state().status === 'failed')
  assert.match(bad.state().error, /sha256/)
  assert.equal(readFileSync(join(app, 'version.txt'), 'utf8').trim(), 'v0.4.3')
  assert.ok(!existsSync(join(state, 'update')), 'nothing of a failed download is kept')
  // the smoke test: a bundle whose binary says another version is refused
  const liar = bundle(join(tmp, 'liar'), '0.8.0'); writeFileSync(join(tmp, 'liar', 'version.txt'), 'v0.9.9\n')
  const liarTgz = join(tmp, 'liar2.tar.gz'); execFileSync('tar', ['-czf', liarTgz, '-C', join(tmp, 'liar'), '.'])
  const smoke = createUpdater({ appRoot: app, stateDir: state, current: '0.4.3', ...mac, log: () => {}, fetchFn: serve(liarTgz), exit: () => {}, isSea: true })
  smoke.offer({ version: '0.9.9', assets: { 'darwin-arm64': { url: 'http://127.0.0.1:3399/x.tar.gz', sha256: sha256File(liarTgz) } } })
  await until(() => smoke.state().status === 'failed')
  assert.match(smoke.state().error, /says "0\.8\.0", not 0\.9\.9/)
  void liar
  // a real swap, then the new process comes up as the wrong version → back to the old tree
  const good = createUpdater({ appRoot: app, stateDir: state, current: '0.4.3', ...mac, log: () => {}, fetchFn: serve(rel.tgz), exit: () => {}, isSea: true })
  good.offer({ version: '0.9.9', assets: { 'darwin-arm64': { url: 'http://127.0.0.1:3399/rc.tar.gz', sha256: rel.sha256 } } })
  await until(() => good.state().status === 'ready')
  assert.equal(await good.applyIfIdle({ running: 0 }), true)
  assert.equal(readFileSync(join(app, 'version.txt'), 'utf8').trim(), 'v0.9.9')
  let exited = null
  const wrong = createUpdater({ appRoot: app, stateDir: state, current: '0.4.3', ...mac, log: (m) => logs.push(m), exit: (c) => { exited = c }, isSea: true })
  await wrong.finish()
  assert.equal(exited, 0)
  assert.equal(readFileSync(join(app, 'version.txt'), 'utf8').trim(), 'v0.4.3', 'the previous tree is back')
  assert.ok(!existsSync(app + '.prev'))
  assert.equal(JSON.parse(readFileSync(join(state, MARKER), 'utf8')).phase, 'rolled_back')
  const after = createUpdater({ appRoot: app, stateDir: state, current: '0.4.3', ...mac, log: () => {}, fetchFn: serve(rel.tgz), exit: () => {}, isSea: true })
  await after.finish()
  assert.match(describeUpdate(after.state()), /rolled back.*still on v0\.4\.3/)
  after.offer({ version: '0.9.9', assets: { 'darwin-arm64': { url: 'http://127.0.0.1:3399/rc.tar.gz', sha256: rel.sha256 } } })
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(after.state().status, 'rolled_back', 'the version that was rolled back is not tried again')
  // too many starts: swap again, then three starts that never settle
  const again = createUpdater({ appRoot: app, stateDir: state, current: '0.4.3', ...mac, log: () => {}, fetchFn: serve(rel.tgz), exit: () => {}, isSea: true })
  again.offer({ version: '0.9.9', assets: { 'darwin-arm64': { url: 'http://127.0.0.1:3399/rc.tar.gz', sha256: rel.sha256 } } })
  await until(() => again.state().status === 'ready')
  assert.equal(await again.applyIfIdle({ running: 0 }), true)
  let rolled = null
  for (let i = 1; i <= 4; i++) { const p = createUpdater({ appRoot: app, stateDir: state, current: '0.9.9', ...mac, log: () => {}, exit: (c) => { rolled = `start ${i} exit ${c}` }, isSea: true }); await p.finish() }
  assert.equal(rolled, 'start 4 exit 0', 'three starts are allowed; the fourth rolls back')
  assert.equal(readFileSync(join(app, 'version.txt'), 'utf8').trim(), 'v0.4.3')
})

test('a node running from source reports the release but does not swap', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'vn-upd-'))
  const logs = []
  const src = createUpdater({ appRoot: tmp, stateDir: join(tmp, 'state'), current: '0.4.3', ...mac, log: (m) => logs.push(m), exit: () => {}, isSea: false })
  src.offer({ version: '0.9.9', assets: { 'darwin-arm64': { url: 'http://127.0.0.1:3399/rc.tar.gz', sha256: 'c'.repeat(64) } } })
  assert.equal(src.state().status, 'failed'); assert.match(src.state().error, /from source/)
})
