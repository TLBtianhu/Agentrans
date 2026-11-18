/** Existing NSIS payload acceptance. Run only on a disposable GitHub-hosted Windows job. */
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, realpath, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

assert.equal(process.platform, 'win32')
assert.equal(process.env.GITHUB_ACTIONS, 'true')
assert.equal(process.env.RUNNER_OS, 'Windows')
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted')
const [installerArgument, rootArgument] = process.argv.slice(2)
assert.ok(installerArgument && isAbsolute(installerArgument))
assert.ok(rootArgument && isAbsolute(rootArgument))
const temporaryParent = await realpath(process.env.RUNNER_TEMP)
const root = resolve(rootArgument)
assert.equal(dirname(root).toLowerCase(), temporaryParent.toLowerCase(), 'QA root must be directly under RUNNER_TEMP')
assert.match(root, /[\\/]agentrans-installed-qa(?:-[a-z0-9-]+)?$/iu)
const installer = await realpath(installerArgument)
assert.ok((await stat(installer)).isFile())
await mkdir(root)
const destination = join(root, 'installed')
const executable = join(destination, 'app', 'Agentrans.exe')
const journal = join(root, 'journal')
await mkdir(journal)
const resultPath = join(root, 'result.json')
const report = { evidenceVersion: 1, passed: false, stages: [] }
const ownedProcesses = new Set()
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
  Object.assign(env, { AGENTRANS_TELEMETRY_DISABLED: '1', AGENTRANS_DESKTOP_UPDATE_JOURNAL_DIR: journal })
  const owned = exec(executable, [
    `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1', '--disable-backgrounding-occluded-windows',
    `--user-data-dir=${join(destination, 'data', 'settings', 'electron')}`,
  ], { cwd: destination, env, windowsHide: true, stdio: 'ignore' })
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

try {
  assert.deepEqual(registrations(), [], 'Disposable runner already has Agentrans')
  currentStage = 'fresh-install'
  const version = await install()
  await record(currentStage, { exitCode: 0, version, registryMatchesPrivatePath: true })
  currentStage = 'first-launch'
  let application = await launch(true)
  await record(currentStage, { welcome: true, workspace: true, pid: application.owned.process.pid })
  currentStage = 'create-session'
  const title = `Desktop isolated QA ${randomUUID()}`
  const created = await call(application.workspace, 'session/create', { request: { cwd: root } })
  assert.equal(typeof created.sessionId, 'string')
  const renamed = await call(application.workspace, 'session/rename', { request: { sessionId: created.sessionId, title } })
  assert.equal(renamed.title, title)
  await verifySession(application, created.sessionId, title)
  await record(currentStage, { sessionId: created.sessionId, title, sequence: renamed.seq })
  currentStage = 'relaunch-session'
  const firstPid = application.owned.process.pid
  const firstExit = await stopApp(application)
  application = await launch(false)
  assert.notEqual(application.owned.process.pid, firstPid)
  await verifySession(application, created.sessionId, title)
  await record(currentStage, { sameSessionAndTitle: true, newProcess: true, previousExit: firstExit })
  currentStage = 'same-version-reinstall'
  const secondExit = await stopApp(application)
  assert.equal(await install(), version, 'The same-package repair must preserve version')
  application = await launch(false)
  await verifySession(application, created.sessionId, title)
  await record(currentStage, { sameSessionAndTitle: true, version, previousExit: secondExit })
  await stopApp(application)
  report.passed = true
  await writeFile(resultPath, JSON.stringify(report, null, 2) + '\n')
} catch (error) {
  report.failure = { stage: currentStage, message: String(error.message).replaceAll(/[\r\n]+/gu, ' ').slice(0, 300) }
  await writeFile(resultPath, JSON.stringify(report, null, 2) + '\n')
  console.error(`Windows installer QA failed at ${currentStage}: ${report.failure.message}`)
  process.exitCode = 1
} finally {
  for (const owned of ownedProcesses) stopTree(owned)
}
