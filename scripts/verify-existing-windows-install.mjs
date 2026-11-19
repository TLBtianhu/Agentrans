/** Verify the retained Windows x64 installer and same-version Session persistence. */
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

assert.equal(process.platform, 'win32')
assert.equal(process.arch, 'x64')
assert.equal(process.env.GITHUB_ACTIONS, 'true')
assert.equal(process.env.RUNNER_OS, 'Windows')
assert.equal(process.env.RUNNER_ARCH, 'X64')
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted')
const [installerArgument, rootArgument, version, ...extra] = process.argv.slice(2)
assert.ok(installerArgument && isAbsolute(installerArgument))
assert.ok(rootArgument && isAbsolute(rootArgument))
assert.equal(version, '0.1.0-test.20261119.1', 'Expected the confirmed Windows test candidate')
assert.equal(extra.length, 0)
const temporaryParent = await realpath(process.env.RUNNER_TEMP)
const root = resolve(rootArgument)
assert.equal(dirname(root).toLowerCase(), temporaryParent.toLowerCase(), 'QA root must be directly under RUNNER_TEMP')
assert.match(root, /[\\/]agentrans-installed-qa(?:-[a-z0-9-]+)?$/iu)
const installer = await realpath(installerArgument)
assert.ok((await lstat(installerArgument)).isFile())
await mkdir(root)
const destination = join(root, 'installed')
const executable = join(destination, 'app', 'Agentrans.exe')
const markerPath = join(destination, '.agentrans-instance.json')
const rendererData = join(destination, 'data', 'settings', 'electron')
const journal = join(destination, 'data', 'install', 'update-journal')
const resultPath = join(root, 'result.json')
const report = { evidenceVersion: 2, version, architecture: process.arch, passed: false, stages: [] }
const ownedProcesses = new Set()
let currentStage = 'prepare'

async function record(stage, data = {}) {
  report.stages.push({ stage, ...data })
  console.log(`Windows installer QA: ${stage}`)
  await writeFile(resultPath, JSON.stringify(report, null, 2) + '\n')
}

async function assertAbsent(path) {
  try {
    await lstat(path)
  } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }
  throw new Error('The runner already has state in the test install path')
}

async function installerEvidence() {
  const filename = 'agentrans-' + version + '-win-x64-unsigned.exe'
  assert.equal(basename(installer), filename)
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(installer)) hash.update(chunk)
  return { filename, size: (await stat(installer)).size, sha256: hash.digest('hex') }
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
  assert.equal(installed[0].DisplayVersion, version, 'The NSIS registration must match the test version')
  return installed[0].DisplayVersion
}

async function readLaunchEvidence(pid) {
  // Ordinary user installs leave the development/verification instance marker absent.
  await assertAbsent(markerPath)
  assert.ok((await lstat(rendererData)).isDirectory(), 'Expected the native installation-owned Electron data directory')
  assert.equal((await realpath(rendererData)).toLowerCase(), rendererData.toLowerCase())
  const events = []
  for (const file of (await readdir(journal)).filter(name => name.endsWith('.jsonl'))) {
    for (const line of (await readFile(join(journal, file), 'utf8')).split(/\r?\n/u).filter(Boolean)) {
      const event = JSON.parse(line)
      if (event.pid === pid) events.push(event)
    }
  }
  if (!events.some(event => event.event === 'workspace-ready')) return undefined
  const started = events.filter(event => event.event === 'started')
  assert.equal(started.length, 1, 'Expected one startup event from the launched Windows process')
  assert.equal(started[0].version, version, 'The installed Windows process must run the expected version')
  assert.ok(events.some(event => event.event === 'workspace-ready' && event.version === version))
  return { instanceMarker: 'absent', nativeRendererData: true, runtimeVersion: started[0].version, journalPid: pid }
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

function ownsDebugPort(owned, port) {
  // The prior Windows verifier uses an IPv4 loopback endpoint. Never attach to a
  // listener that claimed its released port before this exact child bound it.
  const listing = execFileSync('netstat.exe', ['-ano', '-p', 'tcp'], {
    encoding: 'utf8', windowsHide: true, timeout: 3000,
  })
  const endpoint = '127.0.0.1:' + port
  for (const line of listing.split(/\r?\n/u)) {
    const [protocol, local, remote, , processId] = line.trim().split(/\s+/u)
    if (protocol === 'TCP' && local === endpoint && remote === '0.0.0.0:0') {
      assert.equal(Number(processId), owned.process.pid, 'DevTools port must belong to the installed app')
      return true
    }
  }
}

async function jsonResponse(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(3500) })
  if (!response.ok) throw new Error(`DevTools returned HTTP ${response.status}`)
  return response.json()
}

async function devtools(url, port, method, params = {}) {
  const endpoint = new URL(url)
  assert.equal(endpoint.protocol, 'ws:')
  assert.equal(endpoint.hostname, '127.0.0.1', 'Only loopback DevTools endpoints are allowed')
  assert.equal(Number(endpoint.port), port, 'DevTools page must be on the owned listener')
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

async function evaluation(application, target, expression) {
  const response = await devtools(target.webSocketDebuggerUrl, application.port, 'Runtime.evaluate', {
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
      if (value) return value
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
    AGENTRANS_DESKTOP_UPDATE_CHECK_INTERVAL_MS: '3600000',
    AGENTRANS_DESKTOP_UPDATE_JOURNAL_DIR: journal,
  })
  const owned = exec(executable, [
    `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1', '--disable-backgrounding-occluded-windows',
    '--no-proxy-server', '--host-resolver-rules=MAP github.com 127.0.0.1, MAP api.github.com 127.0.0.1',
  ], { cwd: destination, env, windowsHide: true, stdio: 'ignore' })
  const application = { owned, base, port }
  await poll(owned, () => ownsDebugPort(owned, port), 'loopback listener owned by the installed application', 30_000)
  const targets = () => jsonResponse(`${base}/json/list`)
  const welcome = await poll(owned, async () => {
    const pages = await targets()
    for (const page of pages) {
      if (!page.url.startsWith('file:') || !page.url.endsWith('/renderer/welcome.html')) continue
      if (await evaluation(application, page,
        "Boolean(document.querySelector('#key-input')?.getClientRects().length && document.querySelector('#skip-key')?.getClientRects().length)")) return page
    }
  }, expectWelcome ? 'native first-run welcome screen' : 'keyless welcome after restart')
  await evaluation(application, welcome, "setTimeout(() => document.querySelector('#skip-key').click(), 0); true")
  application.workspace = await poll(owned, async () => {
    const pages = await targets()
    if (pages.some(page => page.id === welcome.id)) return
    return pages.find(page => page.type === 'page' && page.url.startsWith('dsh-app://app/'))
  }, 'workspace after native welcome skip')
  const details = await poll(owned, async () => {
    const info = await evaluation(application, application.workspace, 'window.dshDesktop.deviceInfo()')
    const value = await call(application, 'session/list', { _request: {} })
    if (Array.isArray(value.items)) return { info, savedCount: value.items.filter(item => !item.blank).length }
  }, 'desktop runtime and authenticated session service')
  assert.ok(details.info.split('; ').includes('platform=win32'))
  assert.ok(details.info.split('; ').includes('app_arch=x64'), 'The installed app must be native Windows x64')
  const pid = owned.process.pid
  const nativeState = await poll(owned, () => readLaunchEvidence(pid), 'installation-owned state and workspace-ready', 20_000)
  application.evidence = { welcome: true, workspace: true, pid, runtimeArchitecture: 'x64', initialSavedSessionCount: details.savedCount, ...nativeState }
  return application
}

async function call(application, method, args) {
  const rpcId = randomUUID()
  const body = JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } })
  const value = await evaluation(application, application.workspace, `(async () => {
    const response = await fetch('/api/${method}', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: ${JSON.stringify(body)},
      signal: AbortSignal.timeout(5000),
    })
    if (!response.ok) throw new Error('${method} returned HTTP ' + response.status)
    const envelope = await response.json()
    if (envelope.type !== 'server-response' || envelope.rpcId !== ${JSON.stringify(rpcId)} || envelope.result?.ok !== true) {
      throw new Error('${method} was refused: ' + (envelope.result?.error?.code ?? 'unrecognized reply') + ': ' + (envelope.result?.error?.message ?? ''))
    }
    return envelope.result.value
  })()`)
  assert.ok(value && typeof value === 'object', `Expected a reply for ${method}`)
  return value
}

async function stopApp(application) {
  const info = await jsonResponse(`${application.base}/json/version`).catch(() => null)
  if (info?.webSocketDebuggerUrl !== undefined) {
    await devtools(info.webSocketDebuggerUrl, application.port, 'Browser.close').catch(() => undefined)
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
    const catalog = await call(application, 'session/list', { _request: {} })
    const entries = catalog.items.filter(row => row.sessionId === sessionId)
    assert.equal(entries.length, 1, 'Expected exactly one catalog entry for the test Session')
    assert.equal(entries[0].blank, false, 'Expected a Session that can be reopened from the sidebar')
    assert.equal(entries[0].projections?.values?.title, title)
    return true
  }, 'durable session identity and title', 20_000)
  const history = await call(application, 'session/events', {
    request: { address: { kind: 'session', sessionId } },
  })
  const entry = history.records.find(row => row.type === 'event' && row.event.seq === titleEventSequence)
  assert.deepEqual({ type: entry?.event.type, title: entry?.event.data.title, source: entry?.event.data.source?.kind },
    { type: 'session/title', title, source: 'user' })

  const sidebarRow = '[role="treeitem"][data-row-key="session:' + sessionId + '"]'
  await poll(application.owned, () => evaluation(application, application.workspace, `(() => {
    const row = document.querySelector(${JSON.stringify(sidebarRow)})
    if (!row?.getClientRects().length) {
      document.querySelector('[data-sidebar-opener]')?.click()
      document.querySelector('[data-row-key="workspace:"][aria-expanded="false"]')?.click()
      return false
    }
    if (!row.textContent.includes(${JSON.stringify(title)})) return false
    row.click()
    return true
  })()`), 'visible Session row opened by ID and title', 20_000)
  const conversation = '[data-conversation-session="' + sessionId + '"]'
  await poll(application.owned, () => evaluation(application, application.workspace, `Boolean(
    document.querySelector(${JSON.stringify(sidebarRow + '[aria-selected="true"]')})?.getClientRects().length &&
    document.querySelector(${JSON.stringify(conversation)})?.getClientRects().length
  )`), 'visible active Session conversation with the exact ID', 20_000)
  return { catalogVerified: true, titleEventVerified: true, uiOpened: true }
}

try {
  report.installer = await installerEvidence()
  assert.deepEqual(registrations(), [], 'Disposable runner already has Agentrans')
  await assertAbsent(destination)
  currentStage = 'fresh-install'
  const installedVersion = await install()
  await assertAbsent(markerPath)
  await assertAbsent(rendererData)
  await assertAbsent(journal)
  await record(currentStage, { exitCode: 0, version: installedVersion, registryMatchesPrivatePath: true, freshApplicationData: true })
  currentStage = 'first-launch'
  const application = await launch(true)
  // A clean Desktop can initialize an empty draft for the default workspace.
  assert.equal(application.evidence.initialSavedSessionCount, 0, 'Expected no prior saved Sessions on first launch')
  await record(currentStage, application.evidence)

  currentStage = 'create-session'
  const title = `Desktop isolated QA ${randomUUID()}`
  const workspace = await mkdtemp(join(root, 'session-workspace-'))
  const { sessionId, agentPreset } = await call(application, 'session/create', { request: { cwd: workspace } })
  assert.match(sessionId, /^[a-z0-9_-]+$/iu)
  assert.equal(agentPreset, 'standard', 'Expected the default Desktop Session preset')
  // A local turn makes the Session eligible for the sidebar without a model key.
  const prompt = await call(application, 'session/prompt', { request: {
    sessionId, requestId: randomUUID(), mode: 'queue',
    content: [{ type: 'text', text: 'Native Session persistence fixture' }],
  } })
  assert.equal(prompt.accepted, true)
  const renamed = await call(application, 'session/rename', { request: { sessionId, title } })
  assert.equal(renamed.title, title)
  assert.ok(Number.isSafeInteger(renamed.seq) && renamed.seq > 0)
  const fixture = { sessionId, title, titleEventSequence: renamed.seq }
  await record(currentStage, { ...fixture, agentPreset, ...await verifySession(application, fixture) })

  currentStage = 'relaunch-session'
  const firstPid = application.owned.process.pid
  const firstExit = await stopApp(application)
  assert.deepEqual(firstExit, { graceful: true, code: 0 }, 'Expected a clean application exit before restart')
  const reopened = await launch(false)
  assert.notEqual(reopened.owned.process.pid, firstPid, 'Expected a new app process after the restart')
  assert.equal(reopened.evidence.initialSavedSessionCount, 1, 'Expected exactly one saved Session after the restart')
  const sessionEvidence = await verifySession(reopened, fixture)
  assert.deepEqual(await stopApp(reopened), { graceful: true, code: 0 }, 'Expected a clean exit after reopening')
  await record(currentStage, { ...reopened.evidence, ...fixture, ...sessionEvidence, newProcess: true, previousExit: firstExit })
  report.passed = true
  await writeFile(resultPath, JSON.stringify(report, null, 2) + '\n')
} catch (error) {
  report.failure = { stage: currentStage, message: String(error.message).replaceAll(/[\r\n]+/gu, ' ').slice(0, 1000) }
  await writeFile(resultPath, JSON.stringify(report, null, 2) + '\n')
  console.error(`Windows installer QA failed at ${currentStage}: ${report.failure.message}`)
  process.exitCode = 1
} finally {
  for (const owned of ownedProcesses) stopTree(owned)
}
