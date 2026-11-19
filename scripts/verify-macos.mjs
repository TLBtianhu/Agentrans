/** Check ordinary first launch from one actual macOS installer on a fresh native runner. */
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'

assert.equal(process.platform, 'darwin')
assert.equal(process.env.GITHUB_ACTIONS, 'true')
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted')
const [artifactArgument, resultArgument, architecture, format, version = '0.1.0-test.20261118.4', ...extra] = process.argv.slice(2)
assert.ok(artifactArgument && isAbsolute(artifactArgument))
assert.ok(resultArgument && isAbsolute(resultArgument))
assert.ok(architecture === 'arm64' || architecture === 'x64')
assert.ok(format === 'dmg' || format === 'zip')
assert.match(version, /^\d+\.\d+\.\d+-test\.\d+\.\d+$/u)
assert.equal(extra.length, 0)
assert.equal(process.arch, architecture, 'Use a native runner of the target architecture')
assert.equal(process.env.RUNNER_ARCH, architecture === 'arm64' ? 'ARM64' : 'X64')

const exec = promisify(execFile)
const runnerHome = await realpath(userInfo().homedir)
const temporaryRoot = await realpath(process.env.RUNNER_TEMP)
const artifactRoot = await realpath(artifactArgument)
assert.equal(dirname(artifactRoot), temporaryRoot, 'Retained inputs must be directly under RUNNER_TEMP')
assert.equal(await realpath(dirname(resultArgument)), temporaryRoot)
assert.equal(basename(resultArgument), 'agentrans-mac-launch-report')
const resultRoot = join(temporaryRoot, basename(resultArgument))
await mkdir(resultRoot, { mode: 0o700 })
const reportPath = join(resultRoot, 'result.json')
const releaseAsset = 'agentrans-' + version + '-mac-' + architecture + '-unsigned'
const machArchitecture = architecture === 'arm64' ? 'arm64' : 'x86_64'
const stateRoot = join(runnerHome, 'Library', 'Application Support', 'com.agentrans.app')
const markerPath = join(stateRoot, '.agentrans-instance.json')
const journal = join(stateRoot, 'data', 'install', 'update-journal')
const result = { format, artifactIntegrityPassed: false }
const report = {
  evidenceVersion: 2, version, architecture, format, runnerArchitecture: process.arch,
  hostRepresentation: process.env.RUNNER_ARCH, results: { [format]: result }, passed: false,
}

async function save() {
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n')
}

function sanitized(message) {
  return String(message).replaceAll(temporaryRoot, '<runner-temp>').replaceAll(process.cwd(), '<checkout>')
    .replaceAll(runnerHome, '<runner-home>').slice(-24_000)
}

function diagnostics(error) {
  return {
    error: sanitized(error.message),
    ...(typeof error.stderr !== 'string' || error.stderr.trim() === '' ? {} : { stderr: sanitized(error.stderr) }),
    ...(typeof error.stdout !== 'string' || error.stdout.trim() === '' ? {} : { stdout: sanitized(error.stdout) }),
  }
}

async function command(executable, args, timeout = 120_000) {
  const result = await exec(executable, args, {
    encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024,
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C', TMPDIR: temporaryRoot },
  })
  return result.stdout.trim()
}

async function sha256(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

async function verifyBundle(appPath, result) {
  assert.ok((await lstat(appPath)).isDirectory(), 'Artifact must contain a real Agentrans.app directory')
  const codeRoot = await realpath(join(appPath, 'Contents'))
  const resourcesRoot = await realpath(join(codeRoot, 'Resources'))
  const plistPath = join(codeRoot, 'Info.plist')
  const plist = key => command('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plistPath])
  const [bundleId, shortVersion, buildVersion, executableName] = await Promise.all([
    plist('CFBundleIdentifier'), plist('CFBundleShortVersionString'), plist('CFBundleVersion'), plist('CFBundleExecutable'),
  ])
  assert.equal(bundleId, 'com.agentrans.app')
  assert.equal(shortVersion, version)
  assert.equal(executableName, 'Agentrans')
  const executable = join(codeRoot, 'MacOS', executableName)
  const executableInfo = await lstat(executable)
  assert.ok(executableInfo.isFile() && (executableInfo.mode & 0o111) !== 0, 'Expected executable bundle entry')
  assert.equal(await command('/usr/bin/lipo', ['-archs', executable]), machArchitecture)
  const asar = join(resourcesRoot, 'app.asar')
  assert.ok((await lstat(asar)).isFile())
  assert.ok((await lstat(join(resourcesRoot, 'runtime'))).isDirectory())
  const updater = await readFile(join(resourcesRoot, 'app-update.yml'), 'utf8')
  for (const line of ['provider: github', 'owner: TLBtianhu', 'repo: Agentrans', 'channel: nightly']) {
    assert.ok(updater.split(/\r?\n/u).includes(line), 'Bundle updater configuration is missing ' + line)
  }
  const [asarSha256, executableSha256] = await Promise.all([sha256(asar), sha256(executable)])
  result.bundle = { bundleId, shortVersion, buildVersion, machArchitecture, asarSha256, executableSha256,
    updater: { provider: 'github', owner: 'TLBtianhu', repository: 'Agentrans', channel: 'nightly' } }
  try {
    await command('/usr/bin/codesign', ['--verify', '--strict', appPath])
    result.bundle.bundleSignatureValid = true
  } catch (error) {
    result.bundle.bundleSignatureValid = false
    result.bundle.signatureDiagnostic = diagnostics(error)
  }
  return { executable }
}

async function prepareDmg(asset, stage, result) {
  await command('/usr/bin/hdiutil', ['verify', asset], 240_000)
  result.diskImageChecksumVerified = true
  await save()
  const mount = join(stage, 'volume')
  await mkdir(mount)
  const initialDevice = (await stat(mount)).dev
  let attached = false
  try {
    await command('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mount, asset], 120_000)
    attached = true
    assert.notEqual((await stat(mount)).dev, initialDevice, 'The disk image did not mount at the assigned path')
    const names = await readdir(mount)
    assert.ok(names.includes('Agentrans.app'), 'Disk image did not contain Agentrans.app')
    const applicationsLink = join(mount, 'Applications')
    const link = await lstat(applicationsLink)
    assert.ok(link.isSymbolicLink(), 'Disk image must provide the Applications shortcut')
    assert.equal(await realpath(applicationsLink), await realpath('/Applications'))
    result.readOnlyMounted = true
    result.applicationShortcut = '/Applications'
    await save()
    const application = join(stage, 'Agentrans.app')
    await command('/usr/bin/ditto', [join(mount, 'Agentrans.app'), application], 240_000)
    return application
  } finally {
    if (attached || (await stat(mount).catch(() => ({ dev: initialDevice }))).dev !== initialDevice) {
      try {
        await command('/usr/bin/hdiutil', ['detach', mount])
      } catch {
        await command('/usr/bin/hdiutil', ['detach', '-force', mount])
      }
      result.detached = true
    }
  }
}

async function prepareZip(asset, stage, result) {
  const entries = (await command('/usr/bin/zipinfo', ['-1', asset])).split(/\r?\n/u)
  assert.ok(entries.length > 0, 'The update ZIP is empty')
  for (const entry of entries) {
    assert.ok(!entry.startsWith('/') && !entry.includes('\\') && !entry.split('/').includes('..'),
      'Unexpected path in the ZIP listing')
    assert.ok(entry === 'Agentrans.app' || entry.startsWith('Agentrans.app/') || entry.startsWith('__MACOSX/'),
      'Unexpected file outside the app bundle')
  }
  assert.ok(entries.includes('Agentrans.app/Contents/Info.plist'))
  await command('/usr/bin/ditto', ['-x', '-k', asset, stage], 240_000)
  result.zipEntries = entries.length
  result.extracted = true
  return join(stage, 'Agentrans.app')
}

// DevTools uses NUL-delimited JSON on the child-owned FD 3/4 pipe pair.
function createDevtoolsPipe(input, output) {
  const pending = new Map()
  let nextId = 1
  let buffer = ''
  let disconnected
  function fail(cause) {
    disconnected ??= cause
    for (const entry of pending.values()) entry.finish(cause)
  }
  output.setEncoding('utf8')
  output.on('data', chunk => {
    buffer += chunk
    let end
    while ((end = buffer.indexOf('\0')) !== -1) {
      const frame = buffer.slice(0, end)
      buffer = buffer.slice(end + 1)
      try {
        const reply = JSON.parse(frame)
        const entry = pending.get(reply.id)
        if (entry) entry.finish(reply.error ? new Error(reply.error.message) : undefined, reply.result)
      } catch (error) {
        fail(new Error('Invalid DevTools pipe message', { cause: error }))
      }
    }
    if (buffer.length > 2 * 1024 * 1024) fail(new Error('Oversized DevTools pipe message'))
  })
  output.once('end', () => fail(new Error('DevTools pipe closed')))
  output.once('error', fail)
  input.once('error', fail)
  return {
    send(method, params = {}, { sessionId, timeout = 4_000 } = {}) {
      if (disconnected !== undefined) return Promise.reject(disconnected)
      const id = nextId++
      return new Promise((resolve, reject) => {
        function finish(error, reply) {
          clearTimeout(timer)
          pending.delete(id)
          if (error) reject(error)
          else resolve(reply)
        }
        const timer = setTimeout(() => finish(new Error('DevTools timed out for ' + method)), timeout)
        pending.set(id, { finish })
        input.write(JSON.stringify({ id, method, params, sessionId }) + '\0', error => {
          if (error) finish(error)
        })
      })
    },
    close() {
      fail(new Error('DevTools pipe disposed'))
      input.destroy()
      output.destroy()
    },
  }
}

async function attach(cdp, target) {
  const session = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true })
  assert.ok(session.sessionId, 'DevTools did not attach to the expected page')
  return session.sessionId
}

async function evaluate(cdp, sessionId, expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, { sessionId })
  if (result.exceptionDetails !== undefined) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'Renderer exception')
  }
  return result.result.value
}

async function poll(owned, operation, label, duration = 90_000) {
  const until = Date.now() + duration
  let lastError
  while (Date.now() < until) {
    if (owned.status !== undefined) throw new Error('Packaged app exited before ' + label + ': ' + JSON.stringify(owned.status))
    try {
      const value = await operation()
      if (value !== undefined && value !== false) return value
    } catch (error) { lastError = error }
    await delay(250)
  }
  throw new Error('Timed out waiting for ' + label + (lastError === undefined ? '' : ': ' + lastError.message))
}

function signalProcessGroup(pid, signal) {
  if (!Number.isSafeInteger(pid)) return false
  try {
    process.kill(-pid, signal)
    return true
  } catch (error) {
    if (error.code === 'ESRCH') return false
    throw error
  }
}

async function waitForGroupExit(pid, milliseconds) {
  const end = Date.now() + milliseconds
  while (signalProcessGroup(pid, 0)) {
    if (Date.now() >= end) return false
    await delay(150)
  }
  return true
}

async function stopProcess(owned, cdp) {
  if (owned.status === undefined) {
    await cdp.send('Browser.close', {}, { timeout: 2_000 }).catch(() => undefined)
  }
  cdp.close()
  if (!(await waitForGroupExit(owned.pid, 2_000))) {
    signalProcessGroup(owned.pid, 'SIGTERM')
    if (!(await waitForGroupExit(owned.pid, 5_000))) signalProcessGroup(owned.pid, 'SIGKILL')
  }
  assert.ok(await waitForGroupExit(owned.pid, 5_000), 'Could not stop the owned packaged app process group')
  assert.ok(await Promise.race([owned.closed.then(() => true), delay(3_000, false, { ref: false })]),
    'Packaged app stdio did not reach quiescence')
}

async function assertNoInstance() {
  try {
    await lstat(stateRoot)
    throw new Error('A packaged macOS instance already exists for the runner account')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
}

async function readInstanceEvidence() {
  const evidence = { events: [] }
  try {
    evidence.stateRoot = sanitized(await realpath(stateRoot))
    evidence.rendererData = (await lstat(join(stateRoot, 'data', 'settings', 'electron'))).isDirectory()
  } catch (error) {
    if (error.code !== 'ENOENT') evidence.stateError = diagnostics(error)
  }
  try {
    evidence.markerPurpose = JSON.parse(await readFile(markerPath, 'utf8')).purpose
  } catch (error) {
    if (error.code !== 'ENOENT') evidence.markerError = diagnostics(error)
  }
  try {
    const files = (await readdir(journal)).filter(name => name.endsWith('.jsonl'))
    for (const file of files) {
      for (const line of (await readFile(join(journal, file), 'utf8')).split('\n').filter(Boolean)) {
        const { event, version, pid } = JSON.parse(line)
        evidence.events.push({ event, version, pid })
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') evidence.journalError = diagnostics(error)
  }
  return evidence
}

async function inspectStartup(owned, stage) {
  if (owned.status !== undefined || !Number.isSafeInteger(owned.pid)) return {}
  const samplePath = join(stage, 'process-sample.txt')
  try {
    await command('/usr/bin/sample', [String(owned.pid), '2', '1', '-file', samplePath], 15_000)
    const sample = await readFile(samplePath, 'utf8')
    const lines = sample.split('\n')
    const callGraph = Math.max(0, lines.findIndex(line => line.includes('Call graph:')))
    return { sample: sanitized(lines.slice(callGraph, callGraph + 48).join('\n')) }
  } catch (error) {
    return { sampleError: diagnostics(error) }
  }
}

async function launch(bundle, stage, result) {
  await assertNoInstance()
  const osDiagnostics = join(stage, 'startup.log')
  const env = {
    ...Object.fromEntries(['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL']
      .filter(key => typeof process.env[key] === 'string').map(key => [key, process.env[key]])),
    TMPDIR: stage,
    AGENTRANS_TELEMETRY_DISABLED: '1',
    AGENTRANS_DESKTOP_UPDATE_CHECK_INTERVAL_MS: '3600000',
    AGENTRANS_DESKTOP_DIAGNOSTIC_FILE: osDiagnostics,
    AGENTRANS_DESKTOP_UPDATE_JOURNAL_DIR: journal,
  }
  const child = spawn(bundle.executable, [
    '--remote-debugging-pipe',
    '--enable-logging=stderr',
    '--disable-backgrounding-occluded-windows', '--no-proxy-server',
    '--host-resolver-rules=MAP github.com 127.0.0.1, MAP api.github.com 127.0.0.1',
  ], { cwd: stage, env, detached: true, stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'] })
  const owned = { pid: child.pid, status: undefined, output: '' }
  child.once('exit', (code, signal) => { owned.status = { code, signal } })
  child.once('error', error => { owned.status = { spawnError: sanitized(error.message) } })
  owned.closed = new Promise(resolve => child.once('close', resolve))
  for (const pipe of [child.stdout, child.stderr]) {
    pipe.setEncoding('utf8')
    pipe.on('data', chunk => { owned.output = (owned.output + chunk).slice(-24_000) })
  }
  const cdp = createDevtoolsPipe(child.stdio[3], child.stdio[4])
  const launch = { passed: false, mode: 'ordinary', freshRunnerInstance: true, pid: owned.pid, instrumentation: 'owned DevTools pipe' }
  result.normal = launch
  const targets = async () => (await cdp.send('Target.getTargets')).targetInfos
  let active = 'native welcome'
  try {
    const welcome = await poll(owned, async () => {
      const target = (await targets()).find(target => target.type === 'page' &&
        target.url.startsWith('file:') && target.url.endsWith('/renderer/welcome.html'))
      if (!target) return undefined
      const sessionId = await attach(cdp, target)
      let displayed = false
      try {
        displayed = await evaluate(cdp, sessionId,
          'Boolean(document.querySelector("#key-input")?.getClientRects().length && document.querySelector("#skip-key")?.getClientRects().length)')
        if (displayed) return { target, sessionId }
      } finally {
        if (!displayed) await cdp.send('Target.detachFromTarget', { sessionId }).catch(() => undefined)
      }
    }, active)
    launch.nativeWelcome = true
    await evaluate(cdp, welcome.sessionId, "setTimeout(() => document.querySelector('#skip-key').click(), 0); true")

    active = 'Desktop workspace after keyless welcome'
    const workspace = await poll(owned, async () => {
      const current = await targets()
      if (current.some(target => target.targetId === welcome.target.targetId)) return undefined
      return current.find(target => target.type === 'page' && target.url.startsWith('dsh-app://app/'))
    }, active)
    launch.workspaceLoaded = true

    active = 'Desktop architecture and authenticated session service'
    const workspaceSession = await attach(cdp, workspace)
    const rpcId = randomUUID()
    const request = JSON.stringify({ type: 'client-request', rpcId, method: 'session/list', payload: { args: { _request: {} } } })
    const details = await poll(owned, async () => {
      const details = await evaluate(cdp, workspaceSession, '(async () => {' +
        'const info = await window.dshDesktop.deviceInfo();' +
        'const response = await fetch("/api/session/list", { method: "POST", headers: { "content-type": "application/json" }, body: ' +
        JSON.stringify(request) + ' }); if (!response.ok) throw new Error("session/list returned HTTP " + response.status);' +
        'const message = await response.json();' +
        'return { info, ready: message.rpcId === ' + JSON.stringify(rpcId) +
        ' && message.result?.ok === true && Array.isArray(message.result.value?.items), count: message.result?.value?.items?.length }; })()')
      return details?.ready ? details : undefined
    }, active)
    const runtimeArch = details.info.split('; ').find(value => value.startsWith('app_arch='))?.slice('app_arch='.length)
    assert.equal(runtimeArch, architecture, 'The running Electron shell must use the packaged architecture')
    launch.runtimeArchitecture = runtimeArch
    launch.sessionServiceReady = true
    launch.initialSessionCount = details.count

    active = 'ordinary macOS product instance and runtime version'
    await poll(owned, async () => {
      const evidence = await readInstanceEvidence()
      launch.instanceEvidence = evidence
      if (!evidence.events.some(event => event.event === 'workspace-ready' && event.pid === owned.pid)) {
        return undefined
      }
      assert.equal(evidence.stateRoot, sanitized(stateRoot), 'Expected the normal macOS state directory')
      assert.equal(evidence.rendererData, true)
      assert.ok(evidence.markerPurpose === undefined || evidence.markerPurpose === 'user', 'Unexpected instance purpose')
      const started = evidence.events.filter(event => event.event === 'started')
      assert.deepEqual(started, [{ event: 'started', version, pid: owned.pid }], 'Expected one fresh journal from this packaged app')
      launch.runtimeVersion = started[0].version
      return true
    }, active, 15_000)
    launch.passed = true
  } catch (error) {
    launch.stage = active
    launch.failure = diagnostics(error)
    launch.instanceEvidence ??= await readInstanceEvidence()
    launch.nativeDiagnostics = await inspectStartup(owned, stage)
  } finally {
    try { await stopProcess(owned, cdp) }
    catch (error) {
      launch.passed = false
      launch.shutdownFailure = diagnostics(error)
    }
    launch.processExit = owned.status
    if (!launch.passed) {
      const extra = await readFile(osDiagnostics, 'utf8').catch(() => '')
      launch.output = sanitized(owned.output + '\n' + extra)
    }
  }
}

let step = 'runner'
try {
  report.macOSVersion = await command('/usr/bin/sw_vers', ['-productVersion'])
  step = 'open retained artifact'
  const asset = join(artifactRoot, releaseAsset + '.' + format)
  const info = await lstat(asset)
  assert.ok(info.isFile(), 'Expected an ordinary artifact file')
  result.asset = { name: basename(asset), size: info.size, sha256: await sha256(asset) }
  const stage = await mkdtemp(join(resultRoot, format + '-'))
  step = 'installer validation and extraction'
  const app = format === 'dmg' ? await prepareDmg(asset, stage, result) : await prepareZip(asset, stage, result)
  step = 'bundle version, architecture, and payload'
  const bundle = await verifyBundle(app, result)
  result.artifactIntegrityPassed = true
  step = 'ordinary first launch'
  await launch(bundle, stage, result)
  report.passed = result.normal.passed
} catch (error) {
  result.failure = { stage: step, ...diagnostics(error) }
}
await save()
console.log(JSON.stringify({
  architecture, format, integrity: result.artifactIntegrityPassed, ordinary: result.normal?.passed,
  welcome: result.normal?.nativeWelcome, workspace: result.normal?.workspaceLoaded, sessions: result.normal?.sessionServiceReady,
  failure: result.failure ?? result.normal?.failure ?? result.normal?.shutdownFailure,
}))
if (!report.passed) process.exitCode = 1
