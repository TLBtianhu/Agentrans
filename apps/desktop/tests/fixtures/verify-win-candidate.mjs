/** Public-to-candidate NSIS upgrade qualification on a disposable GitHub-hosted Windows job. */
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { createReadStream } from 'node:fs'
import { mkdir, mkdtemp, open, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { UPDATE_SIGNING_PUBLIC_KEY } from '../../src/update-signing-key.ts'
import { publicKeyFromBase64, verifyFileDigest } from '../../src/update-signature.ts'
import { startUpgradeFeed } from './win-candidate-feed.mjs'

assert.equal(process.platform, 'win32')
assert.equal(process.arch, 'x64')
assert.equal(process.env.GITHUB_ACTIONS, 'true')
assert.equal(process.env.RUNNER_OS, 'Windows')
assert.equal(process.env.RUNNER_ARCH, 'X64')
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted')
const [manifestArgument, rootArgument] = process.argv.slice(2)
assert.ok(manifestArgument && isAbsolute(manifestArgument))
assert.ok(rootArgument && isAbsolute(rootArgument))
const temporaryParent = await realpath(process.env.RUNNER_TEMP)
const root = resolve(rootArgument)
assert.equal(dirname(root).toLowerCase(), temporaryParent.toLowerCase(), 'QA root must be directly under RUNNER_TEMP')
assert.match(root, /[\\/]agentrans-(?:installed|upgrade)-qa(?:-[a-z0-9-]+)?$/iu)
const manifest = JSON.parse((await readFile(manifestArgument, 'utf8')).replace(/^\uFEFF/u, ''))
const oldVersion = '0.1.0-test.20261119.1'
const newVersion = '0.1.0-test.20261120.1'
const publicReleaseId = 451310439
const publicOldHash = '802bd688f4c77a72ff524a0cc0b96a2144264483ba521450c44b3f0a8b83f33b'
const publicOldBlockMapHash = '8cd74e96a561cf6c4baf57fa4fde8263393f1b093c536ddf2ac5ae1d8dba4d39'
const candidateCommit = '3c6b00d9827fe49f4766fb6b4ce0139a554f0c72'
assert.match(manifest.expectedNewSha256, /^[a-f0-9]{64}$/u)
for (const name of ['oldExe', 'newExe', 'oldBlockMap', 'newBlockMap', 'newYaml', 'newSignature', 'newYamlSignature', 'httpsKey', 'httpsCert', 'rootCa']) {
  assert.ok(isAbsolute(manifest[name]), `Manifest field ${name} must be an absolute path`)
  assert.ok((await stat(manifest[name])).isFile(), `Manifest field ${name} must be a file`)
}
const installer = await realpath(manifest.oldExe)
await mkdir(root)
const destination = join(root, 'installed')
const executable = join(destination, 'app', 'Agentrans.exe')
const journal = join(destination, 'data', 'install', 'update-journal')
const resultPath = join(root, 'result.json')
const report = { evidenceVersion: 2, passed: false, architecture: 'x64', oldVersion, newVersion, publicReleaseId, candidateCommit, stages: [] }
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

async function installedManifest() {
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
    return JSON.parse((await bytesAt(entry.size, position)).toString('utf8'))
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
  const deviceInfo = await evaluation(workspace, 'window.dshDesktop.deviceInfo()')
  assert.ok(deviceInfo.split('; ').includes('platform=win32'))
  assert.ok(deviceInfo.split('; ').includes('app_arch=x64'), 'The installed app must run native Windows x64')
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

async function verifySession(application, { sessionId, title, titleEventSequence }) {
  await poll(application.owned, async () => {
    const catalog = await call(application.workspace, 'session/list', { _request: {} })
    const entries = catalog.items.filter(row => row.sessionId === sessionId)
    assert.equal(entries.length, 1, 'Expected exactly one catalog entry for the test Session')
    assert.equal(entries[0].blank, false, 'Expected a Session that can be reopened from the sidebar')
    assert.equal(entries[0].projections?.values?.title, title)
    return true
  }, 'durable session identity and title', 20_000)
  const history = await call(application.workspace, 'session/events', {
    request: { address: { kind: 'session', sessionId } },
  })
  const entry = history.records.find(row => row.type === 'event' && row.event.seq === titleEventSequence)
  assert.deepEqual({ type: entry?.event.type, title: entry?.event.data.title, source: entry?.event.data.source?.kind },
    { type: 'session/title', title, source: 'user' })
  const sidebarRow = '[role="treeitem"][data-row-key="session:' + sessionId + '"]'
  await poll(application.owned, async () => {
    const opened = await evaluation(application.workspace, `(() => {
      const row = document.querySelector(${JSON.stringify(sidebarRow)})
      if (!row?.getClientRects().length) {
        document.querySelector('[data-sidebar-opener]')?.click()
        document.querySelector('[data-row-key="workspace:"][aria-expanded="false"]')?.click()
        return false
      }
      if (!row.textContent.includes(${JSON.stringify(title)})) return false
      row.click()
      return true
    })()`)
    if (opened) return true
  }, 'visible Session row opened by ID and title', 20_000)
  const visibleConversation = '[data-conversation-session="' + sessionId + '"]'
  await poll(application.owned, async () => {
    const opened = await evaluation(application.workspace, `Boolean(
      document.querySelector(${JSON.stringify(sidebarRow + '[aria-selected="true"]')})?.getClientRects().length &&
      document.querySelector(${JSON.stringify(visibleConversation)})?.getClientRects().length
    )`)
    if (opened) return true
  }, 'visible active Session conversation with the exact ID', 20_000)
  return { catalogVerified: true, titleEventVerified: true, uiOpened: true }
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
        const installed = await installedManifest()
        assert.equal(installed.version, newVersion)
        assert.equal(installed.dshBuildCommit, candidateCommit)
        assert.equal(installed.dshBuildDirty, false)
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
  const publicKey = publicKeyFromBase64(UPDATE_SIGNING_PUBLIC_KEY)
  const [oldHash, oldMapHash, newHash, installerSignature, indexSignature] = await Promise.all([
    sha256(installer), sha256(manifest.oldBlockMap), sha256(manifest.newExe),
    readFile(manifest.newSignature, 'utf8'), readFile(manifest.newYamlSignature, 'utf8'),
  ])
  assert.equal(oldHash, publicOldHash, 'Old installer bytes must match the public Release')
  assert.equal(oldMapHash, publicOldBlockMapHash, 'Old blockmap bytes must match the public Release')
  assert.equal(newHash, manifest.expectedNewSha256, 'Successor bytes must match the verified Actions artifact')
  assert.ok(await verifyFileDigest(manifest.newExe, installerSignature, publicKey), 'Candidate EXE signature must match the pinned public key')
  assert.ok(await verifyFileDigest(manifest.newYaml, indexSignature, publicKey), 'Candidate YAML signature must match the pinned public key')
  await record('verified-package-inputs', { oldHash, oldMapHash, newHash, installerSignatureVerified: true, indexSignatureVerified: true })
  currentStage = 'fresh-install'
  const version = await install()
  assert.equal(version, oldVersion)
  assert.equal((await installedManifest()).version, oldVersion)
  await record(currentStage, { exitCode: 0, version, registryMatchesPrivatePath: true })
  currentStage = 'prepare-local-update-feed'
  const cacheDir = await updaterCache()
  const cached = join(cacheDir, 'installer.exe')
  assert.equal(await sha256(cached), oldHash, 'The public installer must have populated its cache with the verified original bytes')
  for (const hostname of ['github.com', 'api.github.com']) {
    assert.equal((await lookup(hostname, { family: 4 })).address, '127.0.0.1', `${hostname} must resolve to the disposable runner HTTPS feed`)
  }
  const feedOptions = {
    tls: { key: await readFile(manifest.httpsKey), cert: await readFile(manifest.httpsCert) },
    oldInstallerPath: installer, newInstallerPath: manifest.newExe, metadataPath: manifest.newYaml,
    signaturePath: manifest.newSignature, metadataSignaturePath: manifest.newYamlSignature,
    oldBlockMapPath: manifest.oldBlockMap, newBlockMapPath: manifest.newBlockMap,
    port: manifest.port ?? 443,
  }
  feed = await startUpgradeFeed(feedOptions)
  await record(currentStage, { oldInstallerCacheSeeded: false, existingInstallerCacheVerified: true, localTls: true })
  currentStage = 'first-launch'
  const application = await launch(true)
  await record(currentStage, { welcome: true, workspace: true, runtimeArchitecture: 'x64', pid: application.owned.process.pid })
  currentStage = 'create-session'
  const title = `Desktop isolated QA ${randomUUID()}`
  const workspace = await mkdtemp(join(root, 'session-workspace-'))
  const { sessionId, agentPreset } = await call(application.workspace, 'session/create', { request: { cwd: workspace } })
  assert.match(sessionId, /^[a-z0-9_-]+$/iu)
  assert.equal(agentPreset, 'standard')
  const prompt = await call(application.workspace, 'session/prompt', { request: {
    sessionId, requestId: randomUUID(), mode: 'queue',
    content: [{ type: 'text', text: 'Native Session persistence fixture' }],
  } })
  assert.equal(prompt.accepted, true)
  const renamed = await call(application.workspace, 'session/rename', { request: { sessionId, title } })
  assert.equal(renamed.title, title)
  assert.ok(Number.isSafeInteger(renamed.seq) && renamed.seq > 0)
  const originalSession = { sessionId, title, titleEventSequence: renamed.seq }
  await record(currentStage, { ...originalSession, agentPreset, ...await verifySession(application, originalSession) })

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
  assert.ok(report.feed.differentialObserved, 'The updater did not finish with a differential-only transfer')
  assert.equal(report.feed.fullInstallerRequests, 0)
  assert.equal(report.feed.signatureRequests, 1)
  await record('verified-reconstructed-installer', {
    sha256: newHash, differential: true, installerSignatureRequested: true,
    rangeRequests: report.feed.rangeRequests, rangeBytes: report.feed.rangeBytes, installerSize: report.feed.installerSize,
  })
  feed.stopServingInstaller()
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
  await record(currentStage, {
    newProcess: true, launchedWithUpdatedFlag: true, installedVersion: newVersion,
    installedBuildCommit: candidateCommit, pid: automaticRestart.ProcessId,
  })
  currentStage = 'verify-session-after-upgrade'
  await closeAutomaticRestart(automaticRestart)
  automaticRestart = undefined
  const releaseCatalogRequestsBeforeRelaunch = feed.snapshot().releaseCatalogRequests
  const reopened = await launch(false)
  const sessionEvidence = await verifySession(reopened, originalSession)
  assert.ok((await updateEvents(reopened.owned.process.pid)).some(event => event.event === 'started' && event.version === newVersion))
  await record(currentStage, {
    ...originalSession, ...sessionEvidence, sameSessionAndTitle: true, runningVersion: newVersion, inspectedWithFreshDebugger: true,
  })
  currentStage = 'verify-successor-release-catalog'
  await poll(reopened.owned, () => {
    if (feed.snapshot().releaseCatalogRequests > releaseCatalogRequestsBeforeRelaunch) return true
  }, 'successor updater request to the local releases API', 30000)
  await record(currentStage, { localReleaseCatalog: true })
  await stopApp(reopened)
  currentStage = 'verify-differential-transfer'
  report.feed = feedSummary()
  assert.ok(report.feed.differentialObserved, 'The updater did not finish with a differential-only transfer')
  assert.equal(report.feed.blockedInstallerRequests, 0, 'The restarted candidate must not attempt another installation')
  await record(currentStage, {
    rangeRequests: report.feed.rangeRequests, rangeBytes: report.feed.rangeBytes, installerSize: report.feed.installerSize,
    fullInstallerRequests: report.feed.fullInstallerRequests, blockedInstallerRequests: report.feed.blockedInstallerRequests,
  })
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
  await Promise.all([feed?.close(), ...Array.from(ownedProcesses, owned => waitForExit(owned, 10_000))])
}
