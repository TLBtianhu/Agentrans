/** Installed NSIS upgrade acceptance. Run only on a disposable GitHub-hosted Windows job. */
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { constants, createReadStream } from 'node:fs'
import { copyFile, mkdir, open, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { startUpgradeFeed } from './update-feed.mjs'

assert.equal(process.platform, 'win32')
assert.equal(process.env.GITHUB_ACTIONS, 'true')
assert.equal(process.env.RUNNER_OS, 'Windows')
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted')
const [manifestArgument, rootArgument] = process.argv.slice(2)
assert.ok(manifestArgument && isAbsolute(manifestArgument))
assert.ok(rootArgument && isAbsolute(rootArgument))
const temporaryParent = await realpath(process.env.RUNNER_TEMP)
const root = resolve(rootArgument)
assert.equal(dirname(root).toLowerCase(), temporaryParent.toLowerCase(), 'QA root must be directly under RUNNER_TEMP')
assert.match(root, /[\\/]agentrans-(?:installed|upgrade)-qa(?:-[a-z0-9-]+)?$/iu)
const manifest = JSON.parse((await readFile(manifestArgument, 'utf8')).replace(/^\uFEFF/u, ''))
const oldVersion = '0.1.0-test.20261118.1'
const newVersion = '0.1.0-test.20261118.2'
const retainedOldHash = '89ecc5ce9d75f67bb691cba7ce15b69288f93fe4ca6934746cd732b14b8a164c'
for (const name of ['oldExe', 'newExe', 'oldBlockMap', 'newBlockMap', 'newYaml', 'newSignature', 'httpsKey', 'httpsCert', 'rootCa']) {
  assert.ok(isAbsolute(manifest[name]), `Manifest field ${name} must be an absolute path`)
  assert.ok((await stat(manifest[name])).isFile(), `Manifest field ${name} must be a file`)
}
const installer = await realpath(manifest.oldExe)
await mkdir(root)
const destination = join(root, 'installed')
const executable = join(destination, 'app', 'Agentrans.exe')
const journal = join(destination, 'data', 'install', 'update-journal')
const resultPath = join(root, 'result.json')
const report = { evidenceVersion: 1, passed: false, oldVersion, newVersion, stages: [] }
const ownedProcesses = new Set()
let feed
let automaticRestart
let currentStage = 'prepare'

async function record(stage, data = {}) {
  report.stages.push({ stage, ...data })
  console.log(`Windows installer QA: ${stage}`)
  await writeFile(resultPath, JSON.stringify(report, null, 2) + '\n')
}

function exec(command, args, options) {
  const process = spawn(command, args, options)
  let finished = false
  const closed = new Promise(resolve => {
    process.once('error', error => { finished = true; resolve({ error }) })
    process.once('close', (code, signal) => { finished = true; resolve({ code, signal }) })
  })
  const owned = { process, closed, finished: () => finished }
  ownedProcesses.add(owned)
  return owned
}

function stopTree(owned) {
  if (owned.finished() || owned.process.pid === undefined) return
  try {
    execFileSync('taskkill.exe', ['/PID', String(owned.process.pid), '/T', '/F'], {
      windowsHide: true, stdio: 'ignore', timeout: 10000,
    })
  } catch {
    if (!owned.finished()) owned.process.kill()
  }
}

async function waitForExit(owned, timeout) {
  return Promise.race([owned.closed, delay(timeout, undefined, { ref: false })])
}

function registrations() {
  const command = [
    "$ErrorActionPreference='Stop'",
    "$r=@(Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue | Where-Object DisplayName -eq 'Agentrans' | Select-Object DisplayVersion,InstallLocation)",
    "ConvertTo-Json -InputObject $r -Compress",
  ].join(';')
  return JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8', windowsHide: true, timeout: 10000,
  }))
}

function installedAppProcesses() {
  const command = [
    "$ErrorActionPreference='Stop'",
    "$r=@(Get-CimInstance Win32_Process -Filter \"Name='Agentrans.exe'\" | Where-Object { $_.ExecutablePath -ieq $env:QA_INSTALLED_EXE -and $_.CommandLine -notmatch '(?:^|[\\s\"])--type=' } | Select-Object ProcessId,@{Name='Updated';Expression={$_.CommandLine -match '(?:^|[\\s\"])--updated(?=[\\s\"]|$)'}})",
    'ConvertTo-Json -InputObject $r -Compress',
  ].join(';')
  return JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    env: { ...process.env, QA_INSTALLED_EXE: executable }, encoding: 'utf8', windowsHide: true, timeout: 10000,
  }))
}

async function sha256(path) {
  const hash = createHash('sha256')
  for await (const bytes of createReadStream(path)) hash.update(bytes)
  return hash.digest('hex')
}

async function installedVersion() {
  // An ASAR begins with an eight-byte Pickle for the header size; the next Pickle contains the file table.
  const archive = await open(join(destination, 'app', 'resources', 'app.asar'), 'r')
  try {
    async function bytesAt(length, position) {
      const bytes = Buffer.alloc(length)
      const result = await archive.read(bytes, 0, length, position)
      assert.equal(result.bytesRead, length, 'Incomplete ASAR entry')
      return bytes
    }
    const headerSize = (await bytesAt(8, 0)).readUInt32LE(4)
    assert.ok(headerSize > 8 && headerSize < 64 * 1024 * 1024)
    const header = await bytesAt(headerSize, 8)
    const stringSize = header.readUInt32LE(4)
    assert.ok(stringSize > 0 && stringSize <= headerSize - 8)
    const entry = JSON.parse(header.toString('utf8', 8, 8 + stringSize)).files['package.json']
    assert.match(entry.offset, /^\d+$/u)
    assert.ok(Number.isSafeInteger(entry.size) && entry.size > 0 && entry.size < 1024 * 1024)
    const position = 8 + headerSize + Number(entry.offset)
    assert.ok(Number.isSafeInteger(position))
    return JSON.parse((await bytesAt(entry.size, position)).toString('utf8')).version
  } finally { await archive.close() }
}

async function updaterCache() {
  const config = await readFile(join(destination, 'app', 'resources', 'app-update.yml'), 'utf8')
  assert.match(config, /^provider: github\s*$/mu)
  assert.match(config, /^owner: TLBtianhu\s*$/mu)
  assert.match(config, /^repo: Agentrans\s*$/mu)
  const cacheName = config.match(/^updaterCacheDirName:\s*['"]?([a-z0-9_.-]+)['"]?\s*$/imu)?.[1]
  assert.ok(cacheName && cacheName !== '.' && cacheName !== '..', 'Embedded app must name its updater cache')
  assert.ok(isAbsolute(process.env.LOCALAPPDATA))
  const path = join(process.env.LOCALAPPDATA, cacheName)
  await mkdir(path, { recursive: true })
  assert.equal((await realpath(path)).toLowerCase(), path.toLowerCase(), 'Owned updater cache must not be linked')
  return path
}

async function updateEvents(pid) {
  const names = await readdir(journal).catch(error => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  const logs = await Promise.all(names.filter(name => name.endsWith('.jsonl')).map(async name => {
    const content = await readFile(join(journal, name), 'utf8')
    return content.split(/\r?\n/u).slice(0, -1).filter(Boolean).map(line => JSON.parse(line))
  }))
  return logs.flat().filter(event => event.pid === pid)
}

async function install() {
  // NSIS consumes the entire final /D= parameter as the owned install directory.
  const owned = exec(installer, ['/S', `/D=${destination}`], {
    cwd: root, windowsVerbatimArguments: true, windowsHide: true, stdio: 'ignore',
  })
  const exit = await waitForExit(owned, 180000)
  if (exit === undefined) throw new Error('NSIS installer timed out')
  if (exit.error !== undefined) throw new Error('NSIS process did not start')
  assert.equal(exit.code, 0, 'Expected a successful NSIS exit')
  const realExecutable = await realpath(executable)
  assert.equal(realExecutable.toLowerCase(), executable.toLowerCase(), 'Installed executable must not resolve outside the QA path')
  assert.ok((await stat(executable)).size > 1024)
  assert.ok((await stat(join(destination, 'app', 'resources', 'app.asar'))).isFile())
  assert.ok((await stat(join(destination, 'Uninstall Agentrans.exe'))).isFile())
  const installed = registrations()
  assert.equal(installed.length, 1, 'Expected exactly one installed Agentrans registration')
  assert.equal(resolve(installed[0].InstallLocation).toLowerCase(), destination.toLowerCase(), 'NSIS registration should point to this QA install')
  return installed[0].DisplayVersion
}

async function getLoopbackPort() {
  const server = createServer()
  return new Promise((resolvePort, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      server.close(error => error === undefined ? resolvePort(port) : reject(error))
    })
  })
}

async function jsonResponse(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(3500) })
  if (!response.ok) throw new Error(`DevTools returned HTTP ${response.status}`)
  return response.json()
}

async function devtools(url, method, params = {}) {
  const endpoint = new URL(url)
  assert.equal(endpoint.protocol, 'ws:')
  assert.equal(endpoint.hostname, '127.0.0.1', 'Only loopback DevTools endpoints are allowed')
  const socket = new WebSocket(endpoint)
  return new Promise((resolveValue, reject) => {
    const timer = setTimeout(() => settle(reject, new Error(`DevTools ${method} timed out`)), 7000)
    function settle(complete, value) {
      clearTimeout(timer)
      try { socket.close() } catch { /* connection already closed */ }
      complete(value)
    }
    socket.addEventListener('error', () => settle(reject, new Error(`DevTools ${method} connection failed`)), { once: true })
    socket.addEventListener('close', () => settle(reject, new Error(`DevTools closed during ${method}`)), { once: true })
    socket.addEventListener('open', () => socket.send(JSON.stringify({ id: 1, method, params })), { once: true })
    socket.addEventListener('message', ({ data }) => {
      const value = JSON.parse(data)
      if (value.id !== 1) return
      if (value.error !== undefined) settle(reject, new Error(`DevTools refused ${method}: ${value.error.code}`))
      else settle(resolveValue, value.result)
    })
  })
}

async function evaluation(target, expression) {
  const response = await devtools(target.webSocketDebuggerUrl, 'Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true,
  })
  if (response.exceptionDetails !== undefined) {
    const description = response.exceptionDetails.exception?.description?.split('\n', 1)[0]
    throw new Error(description ?? 'Installed renderer evaluation failed')
  }
  return response.result.value
}

async function poll(owned, action, label, timeout = 90000) {
  const deadline = Date.now() + timeout
  let lastReason
  while (Date.now() < deadline) {
    if (owned.finished()) throw new Error(`Installed application exited while waiting for ${label}`)
    try {
      const value = await action()
      if (value !== undefined) return value
    } catch (error) { lastReason = error.message }
    await delay(350)
  }
  throw new Error(`Timed out waiting for ${label}${lastReason === undefined ? '' : `: ${lastReason}`}`)
}

async function launch(expectWelcome) {
  const port = await getLoopbackPort()
  const base = `http://127.0.0.1:${port}`
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(?:Path|SystemRoot|windir|ComSpec|Temp|Tmp|UserProfile|LocalAppData|AppData|ProgramData|ProgramFiles(?:\(x86\))?|Public|SystemDrive|Number_Of_Processors)$/iu.test(name)))
  Object.assign(env, {
    AGENTRANS_TELEMETRY_DISABLED: '1',
    AGENTRANS_DESKTOP_UPDATE_JOURNAL_DIR: journal,
    NODE_EXTRA_CA_CERTS: manifest.rootCa,
    NODE_USE_SYSTEM_CA: '1',
  })
  const owned = exec(executable, [
    `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1', '--disable-backgrounding-occluded-windows',
    '--host-resolver-rules=MAP github.com 127.0.0.1, MAP api.github.com 127.0.0.1',
    '--no-proxy-server',
    `--user-data-dir=${join(destination, 'data', 'settings', 'electron')}`,
  ], { cwd: destination, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  for (const stream of [owned.process.stdout, owned.process.stderr]) {
    stream.on('data', chunk => {
      owned.outputTail = ((owned.outputTail ?? '') + chunk.toString('utf8')).slice(-16_000)
    })
  }
  const targets = () => jsonResponse(`${base}/json/list`)
  const welcome = await poll(owned, async () => {
    const pages = await targets()
    for (const page of pages) {
      if (!page.url.startsWith('file:') || !page.url.endsWith('/renderer/welcome.html')) continue
      if (await evaluation(page, "Boolean(document.querySelector('#key-input') && document.querySelector('#skip-key'))")) return page
    }
  }, expectWelcome ? 'native first-run welcome screen' : 'keyless welcome after restart')
  await evaluation(welcome, "setTimeout(() => document.querySelector('#skip-key').click(), 0); true")
  const workspace = await poll(owned, async () => {
    const pages = await targets()
    if (pages.some(page => page.id === welcome.id)) return
    return pages.find(page => page.url.startsWith('dsh-app://app/'))
  }, 'workspace after native welcome skip')
  await poll(owned, async () => {
    const value = await call(workspace, 'session/list', { _request: {} })
    if (Array.isArray(value.items)) return true
  }, 'authenticated session service')
  return { owned, workspace, base }
}

async function call(page, method, args) {
  const rpcId = randomUUID()
  const body = JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } })
  const value = await evaluation(page, `(async () => {
    const response = await fetch('/api/${method}', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: ${JSON.stringify(body)},
    })
    if (!response.ok) throw new Error('${method} returned HTTP ' + response.status)
    const envelope = await response.json()
    if (envelope.rpcId !== ${JSON.stringify(rpcId)} || envelope.result?.ok !== true) {
      throw new Error('${method} was refused: ' + (envelope.result?.error?.code ?? 'unrecognized reply'))
    }
    return envelope.result.value
  })()`)
  assert.ok(value && typeof value === 'object', `Expected a reply for ${method}`)
  return value
}

async function stopApp(application) {
  const info = await jsonResponse(`${application.base}/json/version`).catch(() => null)
  if (info?.webSocketDebuggerUrl !== undefined) {
    await devtools(info.webSocketDebuggerUrl, 'Browser.close').catch(() => undefined)
  }
  const exit = await waitForExit(application.owned, 6000)
  if (exit !== undefined) return { graceful: exit.code === 0, code: exit.code }
  stopTree(application.owned)
  const forced = await waitForExit(application.owned, 10000)
  if (forced === undefined) throw new Error('Could not stop the owned QA application process')
  return { graceful: false, code: forced.code }
}

async function verifySession(application, sessionId, title) {
  return poll(application.owned, async () => {
    const state = await call(application.workspace, 'session/list', { _request: {} })
    const matches = state.items.filter(item => item.sessionId === sessionId && item.projections?.values?.title === title)
    if (matches.length === 1) return true
  }, 'durable session identity and title')
}

async function beginUpdate(application) {
  const status = await poll(application.owned, async () => {
    const state = await evaluation(application.workspace, 'window.dshDesktop.updates.status()')
    if (state?.phase === 'available' || state?.phase === 'error') return state
  }, 'new version from local HTTPS feed')
  assert.equal(status.phase, 'available', `Installed updater check failed (${status.failure ?? status.phase})`)
  assert.equal(status.version, newVersion, 'Installed updater must offer the retained successor')
  await evaluation(application.workspace, "setTimeout(() => { void window.dshDesktop.updates.open().catch(() => {}); }, 0); true")
}

async function readyDialog(application) {
  return poll(application.owned, async () => {
    const pages = await jsonResponse(`${application.base}/json/list`)
    const dialog = pages.find(page => page.url === 'dsh-app://shell/update-dialog.html')
    if (dialog === undefined) return
    const view = await evaluation(dialog, `({ message: document.querySelector('#title')?.textContent ?? '',
      ready: Boolean(document.body.classList.contains('visible') && document.querySelector('#actions button.primary')) })`)
    if (view.ready && view.message.includes(newVersion)) return dialog
    if (view.ready && (await updateEvents(application.owned.process.pid)).some(event => event.phase === 'error')) {
      return { failure: view.message }
    }
  }, 'genuine install-and-restart dialog', 150000)
}

async function waitForInstalledRestart(oldPid) {
  const deadline = Date.now() + 180000
  while (Date.now() < deadline) {
    const entries = installedAppProcesses()
    const restarted = entries.find(process => process.ProcessId !== oldPid && process.Updated)
    if (restarted !== undefined) {
      const registration = registrations()
      if (registration.length === 1 && registration[0].DisplayVersion === newVersion) {
        assert.equal(resolve(registration[0].InstallLocation).toLowerCase(), destination.toLowerCase())
        assert.equal(await installedVersion(), newVersion)
        return restarted
      }
    }
    await delay(700)
  }
  throw new Error('NSIS never relaunched the updated application with --updated')
}

async function closeAutomaticRestart(process) {
  const pid = process.ProcessId
  assert.ok(Number.isSafeInteger(pid) && pid > 0)
  if (!installedAppProcesses().some(app => app.ProcessId === pid)) return
  const graceful = `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).CloseMainWindow() | Out-Null`
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', graceful], { windowsHide: true, timeout: 10000 })
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    if (!installedAppProcesses().some(app => app.ProcessId === pid)) return
    await delay(400)
  }
  if (installedAppProcesses().some(app => app.ProcessId === pid)) {
    execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 10000 })
  }
}

function feedSummary() {
  const snapshot = feed?.snapshot()
  if (snapshot === undefined) return undefined
  const { requests, ...summary } = snapshot
  return { ...summary, sampledRequests: requests.slice(0, 20) }
}

try {
  assert.deepEqual(registrations(), [], 'Disposable runner already has Agentrans')
  const [oldHash, newHash] = await Promise.all([sha256(installer), sha256(manifest.newExe)])
  assert.equal(oldHash, retainedOldHash, 'Old installer bytes must be the exact retained package')
  await record('verified-package-inputs', { oldHash, newHash })
  currentStage = 'fresh-install'
  const version = await install()
  assert.equal(version, oldVersion)
  assert.equal(await installedVersion(), oldVersion)
  await record(currentStage, { exitCode: 0, version, registryMatchesPrivatePath: true })
  currentStage = 'prepare-local-update-feed'
  const cacheDir = await updaterCache()
  const cached = join(cacheDir, 'installer.exe')
  let oldInstallerCacheSeeded = false
  try {
    await copyFile(installer, cached, constants.COPYFILE_EXCL)
    oldInstallerCacheSeeded = true
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
  }
  assert.equal(await sha256(cached), oldHash, 'The old installer cache must contain the verified original bytes')
  assert.equal((await lookup('github.com', { family: 4 })).address, '127.0.0.1', 'GitHub must resolve to the disposable runner HTTPS feed')
  feed = await startUpgradeFeed({
    tls: { key: await readFile(manifest.httpsKey), cert: await readFile(manifest.httpsCert) },
    oldInstallerPath: installer, newInstallerPath: manifest.newExe, metadataPath: manifest.newYaml,
    signaturePath: manifest.newSignature, oldBlockMapPath: manifest.oldBlockMap, newBlockMapPath: manifest.newBlockMap,
    port: manifest.port ?? 443,
  })
  await record(currentStage, { oldInstallerCacheSeeded, existingInstallerCacheVerified: !oldInstallerCacheSeeded, localTls: true })
  currentStage = 'first-launch'
  const application = await launch(true)
  await record(currentStage, { welcome: true, workspace: true, pid: application.owned.process.pid })
  currentStage = 'create-session'
  const title = `Desktop isolated QA ${randomUUID()}`
  const created = await call(application.workspace, 'session/create', { request: { cwd: root } })
  assert.equal(typeof created.sessionId, 'string')
  const renamed = await call(application.workspace, 'session/rename', { request: { sessionId: created.sessionId, title } })
  assert.equal(renamed.title, title)
  await verifySession(application, created.sessionId, title)
  await record(currentStage, { sessionId: created.sessionId, title, sequence: renamed.seq })
  currentStage = 'check-and-download'
  await beginUpdate(application)
  await record('checked-successor-version', { version: newVersion })
  const confirmation = await readyDialog(application)
  assert.ok(!confirmation.failure, `Installed updater failed before install confirmation (${confirmation.failure ?? ''})`)
  const oldPid = application.owned.process.pid
  let events = await updateEvents(oldPid)
  assert.ok(events.some(event => event.phase === 'ready' && event.targetVersion === newVersion), 'Application never verified its downloaded update')
  const cachedSuccessor = join(cacheDir, 'pending', basename(manifest.newExe))
  assert.equal(await sha256(cachedSuccessor), newHash, 'Reconstructed package bytes differ from the retained successor')
  report.feed = feedSummary()
  await record('verified-reconstructed-installer', { sha256: newHash, differential: report.feed.differentialObserved })
  currentStage = 'confirm-real-native-upgrade'
  await evaluation(confirmation, "setTimeout(() => document.querySelector('#actions button.primary').click(), 0); true")
  const oldExit = await waitForExit(application.owned, 90000)
  assert.equal(oldExit?.code, 0, 'Expected the old application to exit cleanly for NSIS')
  events = await updateEvents(oldPid)
  assert.ok(events.some(event => event.event === 'install-confirmed'), 'The production installer was never authorized')
  report.updateEvents = events
  await record(currentStage, { oldProcessExited: true, installerIntercepted: false })
  currentStage = 'verify-automatic-restart'
  automaticRestart = await waitForInstalledRestart(oldPid)
  await record(currentStage, { newProcess: true, launchedWithUpdatedFlag: true, installedVersion: newVersion, pid: automaticRestart.ProcessId })
  currentStage = 'verify-session-after-upgrade'
  await closeAutomaticRestart(automaticRestart)
  automaticRestart = undefined
  const reopened = await launch(false)
  await verifySession(reopened, created.sessionId, title)
  assert.ok((await updateEvents(reopened.owned.process.pid)).some(event => event.event === 'started' && event.version === newVersion))
  await record(currentStage, { sameSessionAndTitle: true, runningVersion: newVersion, inspectedWithFreshDebugger: true })
  await stopApp(reopened)
  currentStage = 'verify-differential-transfer'
  report.feed = feedSummary()
  assert.ok(report.feed.differentialObserved, 'The updater did not finish with a differential-only transfer')
  await record(currentStage, { rangeRequests: report.feed.rangeRequests, rangeBytes: report.feed.rangeBytes, installerSize: report.feed.installerSize })
  report.passed = true
  await writeFile(resultPath, JSON.stringify(report, null, 2) + '\n')
} catch (error) {
  report.failure = { stage: currentStage, message: String(error.message).replaceAll(/[\r\n]+/gu, ' ').slice(0, 300) }
  report.feed = feedSummary()
  const diagnostics = [...ownedProcesses].flatMap(process => process.outputTail?.match(/(?:ERR_[A-Z0-9_]+|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE|Cannot download differentially)/gu) ?? [])
  report.diagnostics = [...new Set(diagnostics)]
  await writeFile(resultPath, JSON.stringify(report, null, 2) + '\n')
  console.error(`Windows installer QA failed at ${currentStage}: ${report.failure.message}`)
  process.exitCode = 1
} finally {
  for (const owned of ownedProcesses) stopTree(owned)
  if (automaticRestart !== undefined) await closeAutomaticRestart(automaticRestart)
  await feed?.close()
}
