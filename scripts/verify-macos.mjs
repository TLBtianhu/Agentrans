/** Read-only artifact checks and separately isolated first launches on a hosted Mac runner. */
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'

assert.equal(process.platform, 'darwin')
assert.equal(process.env.GITHUB_ACTIONS, 'true')
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted')
const [artifactArgument, resultArgument, architecture] = process.argv.slice(2)
assert.ok(artifactArgument && isAbsolute(artifactArgument))
assert.ok(resultArgument && isAbsolute(resultArgument))
assert.ok(architecture === 'arm64' || architecture === 'x64')
assert.equal(process.arch, architecture, 'The verification requires a native runner of the target architecture')
assert.equal(process.env.RUNNER_ARCH, architecture === 'arm64' ? 'ARM64' : 'X64')

const temporaryRoot = await realpath(process.env.RUNNER_TEMP)
const artifactRoot = await realpath(artifactArgument)
assert.equal(dirname(artifactRoot), temporaryRoot, 'Retained inputs must be directly under RUNNER_TEMP')
assert.equal(await realpath(dirname(resultArgument)), temporaryRoot)
assert.equal(basename(resultArgument), 'agentrans-mac-launch-report')
const resultRoot = join(temporaryRoot, basename(resultArgument))
await mkdir(resultRoot, { mode: 0o700 })
const reportPath = join(resultRoot, 'result.json')
const version = '0.1.0-test.20261118.3'
const releaseAsset = 'agentrans-' + version + '-mac-' + architecture + '-unsigned'
const machArchitecture = architecture === 'arm64' ? 'arm64' : 'x86_64'
const layoutError = 'Packaged user startup requires a platform-specific product layout'
const exec = promisify(execFile)
const diagnostic = process.env.AGENTRANS_MAC_LAUNCH_DIAGNOSTICS === '1'
const report = {
  evidenceVersion: 1, version, architecture, runnerArchitecture: process.arch,
  hostRepresentation: process.env.RUNNER_ARCH, results: {}, passed: false,
}

async function save() {
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n')
}

function sanitized(message) {
  return String(message).replaceAll(temporaryRoot, '<runner-temp>').replaceAll(process.cwd(), '<checkout>')
    .split(/\r?\n/u).slice(-18).join('\n').slice(-5_000)
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
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C', HOME: temporaryRoot, TMPDIR: temporaryRoot },
  })
  return result.stdout.trim()
}

async function probe(executable, args, timeout) {
  try {
    return { ok: true, output: sanitized(await command(executable, args, timeout)) }
  } catch (error) {
    return { ok: false, ...diagnostics(error) }
  }
}

async function inspectStartup(owned, stage, mode, base, journal, stateRoot) {
  const state = await lstat(join(stateRoot, '.agentrans-instance.json')).then(() => true, () => false)
  const files = await readdir(journal).catch(() => [])
  const eventTypes = []
  for (const file of files.filter(name => name.endsWith('.jsonl'))) {
    for (const line of (await readFile(join(journal, file), 'utf8')).split('\n').filter(Boolean)) {
      try {
        const event = JSON.parse(line)
        if (event.pid === owned.pid && event.version === version) eventTypes.push(event.event)
      } catch { /* A concurrent journal write may leave an incomplete final line. */ }
    }
  }
  if (!Number.isSafeInteger(owned.pid)) return { state, eventTypes }
  const pid = String(owned.pid)
  const samplePath = join(stage, mode + '-process-sample.txt')
  const [processState, port, loopback, systemLog] = await Promise.all([
    probe('/bin/ps', ['-p', pid, '-o', 'pid=,state=,comm='], 4_000),
    probe('/usr/sbin/lsof', ['-nP', '-a', '-p', pid, '-iTCP'], 4_000),
    probe('/usr/bin/curl', ['--noproxy', '*', '--max-time', '2', '-sS', base + '/json/version'], 4_000),
    probe('/usr/bin/log', ['show', '--last', '2m', '--style', 'compact', '--predicate',
      'process == "Agentrans" OR ((process == "amfid" OR process == "syspolicyd") AND eventMessage CONTAINS "Agentrans")'], 12_000),
  ])
  const sampleCommand = owned.status === undefined
    ? await probe('/usr/bin/sample', [pid, '2', '1', '-file', samplePath], 12_000)
    : { ok: false }
  const sample = await readFile(samplePath, 'utf8').then(body => {
    const frames = body.split('\n')
    const start = frames.findIndex(line => line.includes('Call graph:'))
    return sanitized(frames.slice(Math.max(0, start), Math.max(0, start) + 32).join('\n'))
  }, () => undefined)
  return { state, eventTypes, processState, port, loopback, systemLog, sampleCommand, sample }
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
    await command('/usr/bin/codesign', ['--verify', '--strict', diagnostic ? appPath : executable])
    result.bundle.executableSignatureValid = true
  } catch (error) {
    result.bundle.executableSignatureValid = false
    result.bundle.signatureDiagnostic = diagnostics(error)
  }
  return { codeRoot, resourcesRoot, executable }
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

async function reservePort() {
  const listener = createServer()
  try {
    await new Promise((resolve, reject) => {
      listener.once('error', reject)
      listener.listen(0, '127.0.0.1', resolve)
    })
    return listener.address().port
  } finally {
    if (listener.listening) await new Promise((resolve, reject) => {
      listener.close(error => error === undefined ? resolve() : reject(error))
    })
  }
}

async function json(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(2_000) }).catch(error => {
    throw new Error(error.message + (error.cause?.code ? ' ' + error.cause.code : ''), { cause: error })
  })
  assert.ok(response.ok, 'CDP endpoint returned HTTP ' + response.status)
  return response.json()
}

async function devtools(websocket, port, method, params = {}) {
  const endpoint = new URL(websocket)
  assert.equal(endpoint.protocol, 'ws:')
  assert.equal(endpoint.hostname, '127.0.0.1')
  assert.equal(endpoint.port, String(port))
  const socket = new WebSocket(endpoint)
  try {
    return await new Promise((resolve, reject) => {
      const signal = AbortSignal.timeout(4_000)
      signal.addEventListener('abort', () => reject(new Error('CDP response timed out for ' + method)), { once: true })
      socket.addEventListener('open', () => socket.send(JSON.stringify({ id: 1, method, params })), { once: true })
      socket.addEventListener('error', () => reject(new Error('CDP socket failed for ' + method)), { once: true })
      socket.addEventListener('close', () => reject(new Error('CDP socket closed for ' + method)), { once: true })
      socket.addEventListener('message', event => {
        try {
          const value = JSON.parse(event.data)
          if (value.id !== 1) return
          if (value.error !== undefined) reject(new Error(value.error.message))
          else resolve(value.result)
        } catch (error) { reject(error) }
      })
    })
  } finally {
    socket.close()
  }
}

async function evaluate(target, port, expression) {
  const result = await devtools(target.webSocketDebuggerUrl, port, 'Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true,
  })
  if (result.exceptionDetails !== undefined) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'Renderer exception')
  }
  return result.result.value
}

async function poll(owned, operation, label, duration = 75_000) {
  const until = Date.now() + duration
  let lastError
  while (Date.now() < until) {
    if (owned.output.includes(layoutError)) throw new Error(layoutError)
    if (owned.status !== undefined) throw new Error('Packaged app exited before ' + label + ': ' + JSON.stringify(owned.status))
    try {
      const value = await operation()
      if (value !== undefined && value !== false) return value
    } catch (error) { lastError = error }
    await delay(250)
  }
  throw new Error('Timed out waiting for ' + label + (lastError === undefined ? '' : ': ' + lastError.message))
}

async function stopProcess(owned, base, port) {
  if (owned.status === undefined) {
    const info = await json(base + '/json/version').catch(() => null)
    if (info?.webSocketDebuggerUrl !== undefined) {
      await devtools(info.webSocketDebuggerUrl, port, 'Browser.close').catch(() => undefined)
    }
  }
  if (owned.status === undefined) await Promise.race([owned.exited, delay(5_000, undefined, { ref: false })])
  if (owned.status === undefined && owned.pid !== undefined) {
    try { process.kill(-owned.pid, 'SIGTERM') } catch (error) { if (error.code !== 'ESRCH') throw error }
    await Promise.race([owned.exited, delay(5_000, undefined, { ref: false })])
  }
  if (owned.status === undefined && owned.pid !== undefined) {
    try { process.kill(-owned.pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
    await Promise.race([owned.exited, delay(5_000, undefined, { ref: false })])
  }
  assert.notEqual(owned.status, undefined, 'Could not stop the owned packaged app')
}

async function launch(bundle, stage, mode) {
  const stateRoot = join(stage, mode + '-state')
  const osHome = join(stage, mode + '-home')
  const journal = join(stateRoot, 'data', 'install', 'update-journal')
  await mkdir(osHome, { mode: 0o700 })
  const port = await reservePort()
  const base = 'http://127.0.0.1:' + port
  // The child has no workflow credentials, injected Node settings, or runner user profile.
  const env = {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: osHome, CFFIXED_USER_HOME: osHome, ZDOTDIR: osHome,
    TMPDIR: stage, USER: process.env.USER ?? '', LOGNAME: process.env.LOGNAME ?? '',
    AGENTRANS_TELEMETRY_DISABLED: '1', AGENTRANS_DESKTOP_UPDATE_CHECK_INTERVAL_MS: '3600000',
    AGENTRANS_DESKTOP_DIAGNOSTIC_FILE: join(stage, mode + '-startup.log'),
    AGENTRANS_DESKTOP_UPDATE_JOURNAL_DIR: journal,
  }
  if (mode === 'verification') {
    env.AGENTRANS_LAUNCH_CONTEXT = JSON.stringify({
      purpose: 'verification', instanceRoot: stateRoot,
      codeRoot: bundle.codeRoot, resourcesRoot: bundle.resourcesRoot,
    })
  }
  const rendererState = join(stateRoot, 'data', 'settings', 'electron')
  if (diagnostic) env.ELECTRON_ENABLE_LOGGING = '1'
  const child = spawn(bundle.executable, [
    ...(diagnostic ? ['--enable-logging=stderr', '--log-level=0'] : []),
    '--remote-debugging-port=' + port, '--remote-debugging-address=127.0.0.1',
    '--disable-backgrounding-occluded-windows', '--no-proxy-server',
    '--host-resolver-rules=MAP github.com 127.0.0.1, MAP api.github.com 127.0.0.1',
    '--user-data-dir=' + (mode === 'verification' ? rendererState : join(osHome, 'electron')),
  ], { cwd: stage, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const owned = { pid: child.pid, status: undefined, output: '' }
  owned.exited = new Promise(resolve => {
    child.once('exit', (code, signal) => { owned.status = { code, signal }; resolve() })
    child.once('error', error => { owned.status = { spawnError: sanitized(error.message) }; resolve() })
  })
  const outputDrained = new Promise(resolve => { child.once('close', resolve) })
  for (const pipe of [child.stdout, child.stderr]) {
    pipe.on('data', chunk => { owned.output = (owned.output + chunk.toString('utf8')).slice(-24_000) })
  }
  const result = { passed: false, isolatedHome: true, mode }
  let active = 'native welcome'
  try {
    const welcome = await poll(owned, async () => {
      for (const target of await json(base + '/json/list')) {
        if (target.type !== 'page' || !target.url.startsWith('file:') || !target.url.endsWith('/renderer/welcome.html')) continue
        if (await evaluate(target, port, "Boolean(document.querySelector('#key-input') && document.querySelector('#skip-key'))")) return target
      }
    }, active, diagnostic ? 30_000 : 75_000)
    result.nativeWelcome = true
    await evaluate(welcome, port, "setTimeout(() => document.querySelector('#skip-key').click(), 0); true")
    active = 'Desktop workspace after keyless welcome'
    const workspace = await poll(owned, async () => {
      const targets = await json(base + '/json/list')
      if (targets.some(target => target.id === welcome.id)) return
      return targets.find(target => target.type === 'page' && target.url.startsWith('dsh-app://app/'))
    }, active)
    result.workspaceLoaded = true
    active = 'Desktop runtime architecture and authenticated session service'
    const rpcId = randomUUID()
    const request = JSON.stringify({ type: 'client-request', rpcId, method: 'session/list', payload: { args: { _request: {} } } })
    await poll(owned, async () => {
      const details = await evaluate(workspace, port, '(async () => {' +
        'const info = await window.dshDesktop.deviceInfo();' +
        'const response = await fetch("/api/session/list", { method: "POST", headers: { "content-type": "application/json" }, body: ' +
        JSON.stringify(request) + ' }); if (!response.ok) throw new Error("session/list returned HTTP " + response.status);' +
        'const message = await response.json();' +
        'return { info, ready: message.rpcId === ' + JSON.stringify(rpcId) +
        ' && message.result?.ok === true && Array.isArray(message.result.value?.items), count: message.result?.value?.items?.length }; })()')
      if (!details?.ready) return false
      const runtimeArch = details.info.split('; ').find(value => value.startsWith('app_arch='))?.slice('app_arch='.length)
      assert.equal(runtimeArch, architecture, 'The running Electron shell must use the packaged architecture')
      result.runtimeArchitecture = runtimeArch
      result.sessionServiceReady = true
      result.initialSessionCount = details.count
      return true
    }, active)
    const journalFiles = (await readdir(journal)).filter(name => name.endsWith('.jsonl'))
    assert.equal(journalFiles.length, 1, 'Expected one fresh application journal')
    const startup = JSON.parse((await readFile(join(journal, journalFiles[0]), 'utf8')).split('\n')[0])
    assert.equal(startup.event, 'started')
    assert.equal(startup.version, version, 'Expected the tested application version at runtime')
    assert.equal(startup.pid, owned.pid)
    result.runtimeVersion = startup.version
    if (mode === 'verification') {
      const marker = JSON.parse(await readFile(join(stateRoot, '.agentrans-instance.json'), 'utf8'))
      assert.equal(marker.purpose, 'verification')
      result.isolatedProductState = true
    }
    result.passed = true
  } catch (error) {
    result.stage = active
    result.failure = diagnostics(error)
    if (diagnostic) result.nativeDiagnostics = await inspectStartup(owned, stage, mode, base, journal, stateRoot)
  } finally {
    try { await stopProcess(owned, base, port) }
    catch (error) {
      result.passed = false
      result.shutdownFailure = diagnostics(error)
    }
    result.processExit = owned.status
    if (!result.passed) {
      await Promise.race([outputDrained, delay(1_000)])
      const diagnosticFile = await readFile(env.AGENTRANS_DESKTOP_DIAGNOSTIC_FILE, 'utf8').catch(() => '')
      result.output = sanitized(owned.output + '\n' + diagnosticFile)
      result.knownLayoutBlocker = owned.output.includes(layoutError) ||
        diagnosticFile.includes(layoutError) || result.failure?.error === layoutError
    }
  }
  return result
}

report.macOSVersion = await command('/usr/bin/sw_vers', ['-productVersion'])
await save()
for (const format of diagnostic ? ['zip'] : ['dmg', 'zip']) {
  const result = { format, artifactIntegrityPassed: false }
  report.results[format] = result
  const stage = join(resultRoot, format)
  let step = 'open retained artifact'
  try {
    const asset = join(artifactRoot, releaseAsset + '.' + format)
    const info = await lstat(asset)
    assert.ok(info.isFile(), 'Expected an ordinary artifact file')
    result.asset = { name: basename(asset), size: info.size, sha256: await sha256(asset) }
    await mkdir(stage, { mode: 0o700 })
    step = 'dmg or zip validation and extraction'
    const app = format === 'dmg' ? await prepareDmg(asset, stage, result) : await prepareZip(asset, stage, result)
    step = 'bundle version, architecture, and payload'
    const bundle = await verifyBundle(app, result)
    result.artifactIntegrityPassed = true
    if (diagnostic) {
      try {
        const child = await exec(bundle.executable, ['-p',
          'JSON.stringify({arch:process.arch,electron:process.versions.electron})'], {
          encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024,
          env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', ELECTRON_RUN_AS_NODE: '1' },
        })
        result.packagedNodeControl = { passed: true, output: sanitized(child.stdout) }
      } catch (error) {
        result.packagedNodeControl = { passed: false, ...diagnostics(error) }
      }
      report.consoleUser = await probe('/usr/bin/stat', ['-f', '%Su', '/dev/console'], 4_000)
      const desktopDomain = await probe('/bin/launchctl', ['print', 'gui/' + process.getuid()], 4_000)
      report.hasGuiDomain = desktopDomain.ok
    }
    step = 'ordinary first launch'
    result.normal = await launch(bundle, stage, 'normal')
    await save()
    if (!result.normal.passed) {
      step = 'verification-context first launch'
      result.verification = await launch(bundle, stage, 'verification')
    }
  } catch (error) {
    result.failure = { stage: step, ...diagnostics(error) }
  }
  await save()
  console.log(JSON.stringify({
    architecture, format, integrity: result.artifactIntegrityPassed, normal: result.normal?.passed,
    verification: result.verification?.passed,
    failure: result.failure?.stage ?? result.normal?.failure?.error,
  }))
}

if (diagnostic) {
  const { zip } = report.results
  report.diagnosticOnly = true
  report.passed = Boolean(zip.artifactIntegrityPassed && zip.normal?.passed)
  await save()
  if (!report.passed) process.exitCode = 2
} else {
  const { dmg, zip } = report.results
  report.matchingBundlePayloads = Boolean(dmg.bundle && zip.bundle &&
    dmg.bundle.asarSha256 === zip.bundle.asarSha256 &&
    dmg.bundle.executableSha256 === zip.bundle.executableSha256)
  report.passed = report.matchingBundlePayloads && [dmg, zip].every(result => result.failure === undefined && result.normal?.passed)
  report.allPassedExceptKnownLayoutBlocker = report.matchingBundlePayloads && [dmg, zip].every(result =>
    result.failure === undefined && (result.normal?.passed ||
      (result.normal?.knownLayoutBlocker && result.verification?.passed)))
  await save()
  if (!report.passed) process.exitCode = report.allPassedExceptKnownLayoutBlocker ? 2 : 1
}
