// The Windows installer's pieces, statically. v0.3.0 shipped BOM-less UTF-8 scripts with arrows and check
// marks: Windows PowerShell read them as cp1252 and the window closed before a single line. The v0.4.0 installer
// has no PowerShell step at all (launch.vbs under wscript.exe), but every script Windows parses stays pure ASCII.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(root, p))
const ascii = (b) => [...b].map((c, i) => [c, i]).filter(([c]) => c > 0x7e || (c < 0x20 && c !== 0x0a && c !== 0x0d && c !== 0x09))

test('launch.vbs and the advanced install.ps1 are pure ASCII', () => {
  for (const f of ['packaging/windows/launch.vbs', 'installer/install-wsl.ps1']) {
    const bad = ascii(read(f))
    assert.deepEqual(bad.slice(0, 3), [], `${f}: non-ASCII byte(s) at offset ${bad.map(([, i]) => i).slice(0, 3)}`)
  }
})

test('launch.vbs reads the key and hub from the installer name, strips the extension and a "(1)" suffix, starts hidden, opens the page', () => {
  const s = read('packaging/windows/launch.vbs').toString()
  assert.match(s, /GetBaseName\(src\)/, 'the extension is removed before the hub is read')
  assert.match(s, /re\.Pattern = "\\s\*\\\(\\d\+\\\)\$"/, 'a browser duplicate suffix is removed')
  assert.match(s, /llk_\[0-9A-Za-z\]\{32\}/)
  assert.match(s, /-hub-\(\[A-Za-z0-9\._~-\]\+\)\$/, 'the hub code is anchored to the end of the base name')
  assert.match(s, /env\("VERSUM_NODE_KEY"\)/); assert.match(s, /env\("VERSUM_HUB"\)/); assert.match(s, /env\("VERSUM_NODE_HOME"\)/)
  assert.match(s, /sh\.Run cmd, 0, False/, 'the node starts with a hidden window')
  assert.match(s, /127\.0\.0\.1:3311\/api\/state/, 'waits for the page before opening the browser')
  assert.match(s, /MsgBox/, 'a failure is shown, never silent')
})

test('the Inno script: per-user, no PowerShell, startup shortcut, embedded python and the sandbox helper, full uninstall', () => {
  const iss = read('packaging/windows/versum-node.iss').toString()
  const code = iss.split('\n').filter((l) => !l.trimStart().startsWith(';') && !l.trimStart().startsWith('//')).join('\n')
  assert.match(iss, /PrivilegesRequired=lowest/)
  assert.match(iss, /DefaultDirName=\{localappdata\}\\versum-node/)
  assert.ok(!/powershell/i.test(code), 'no PowerShell anywhere in the installer')
  assert.ok(!/wsl|docker/i.test(code), 'no WSL, no Docker')
  for (const f of ['versum-node.exe', 'versum-sandbox.exe', 'launch.vbs']) assert.match(iss, new RegExp(`Source: "\\{#SourceDir\\}\\\\${f.replace('.', '\\.')}"`), f)
  assert.match(iss, /Source: "\{#SourceDir\}\\python\\\*"; DestDir: "\{app\}\\python"/)
  assert.match(iss, /Name: "\{userstartup\}\\Versum node"; Filename: "\{sys\}\\wscript\.exe"; Parameters: """\{app\}\\launch\.vbs"""/)
  assert.match(iss, /\[Run\][\s\S]*wscript\.exe"; Parameters: """\{app\}\\launch\.vbs"" --open --source ""\{srcexe\}"""/)
  assert.match(iss, /\[UninstallRun\][\s\S]*taskkill\.exe"; Parameters: "\/F \/IM versum-node\.exe"/)
  assert.match(iss, /versum-sandbox\.exe"; Parameters: "cleanup --list/)
  assert.match(iss, /\[UninstallDelete\]\s+Type: filesandordirs; Name: "\{app\}"/)
  for (const f of ['packaging/windows/launch.vbs', 'packaging/windows/sandbox/Sandbox.cs', 'installer/install-wsl.ps1']) assert.ok(existsSync(join(root, f)), f)
})

test('the sandbox helper: zero capabilities, a job object with memory + cpu + kill-on-close, the job dir granted, probe/delete/cleanup', () => {
  const cs = read('packaging/windows/sandbox/Sandbox.cs').toString()
  assert.match(cs, /CreateAppContainerProfile\(name, name, "versum-node job sandbox", IntPtr\.Zero, 0, out sid\)/, 'no capabilities')
  assert.match(cs, /CapabilityCount = 0/)
  assert.match(cs, /PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES = \(IntPtr\)0x20009/)
  assert.match(cs, /JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE \| Native\.JOB_OBJECT_LIMIT_JOB_MEMORY \| Native\.JOB_OBJECT_LIMIT_ACTIVE_PROCESS/)
  assert.match(cs, /JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP/)
  assert.match(cs, /FileSystemRights\.FullControl, InheritanceFlags\.ContainerInherit \| InheritanceFlags\.ObjectInherit/)
  assert.match(cs, /new\[\] \{ "S-1-15-2-1", "S-1-5-12" \}/, 'ALL APPLICATION PACKAGES and (0.4.6) RESTRICTED for the python tree')
  assert.match(cs, /ConvertStringSidToSid\("S-1-5-12"/, '0.4.6: the restricting SID is RESTRICTED')
  assert.ok(!/ConvertStringSidToSid\("S-1-15-2-1"/.test(cs), '0.4.6: an app-package SID is never a restricting SID (CreateRestrictedToken refuses it)')
  assert.match(cs, /case "firewall-block"/, '0.4.6: the firewall rule command')
  assert.match(cs, /--mode/, '0.4.6: run takes --mode')
  for (const c of ['"probe"', '"grant-read"', '"run"', '"delete"', '"cleanup"']) assert.ok(cs.includes(`case ${c}:`), c)
  assert.match(cs, /TerminateJobObject\(job, 124\)/, 'the time limit terminates the whole job')
  assert.match(cs, /Console\.Error\.WriteLine\("\[sandbox\] "/, 'its own lines are marked for the node')
})
