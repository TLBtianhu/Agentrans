/** Qualify the real installed macOS update from the public DMG to the Actions candidate ZIP. */
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash, randomUUID, X509Certificate } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { UPDATE_SIGNING_PUBLIC_KEY } from '../../src/update-signing-key.ts'
import { publicKeyFromBase64, verifyFileDigest } from '../../src/update-signature.ts'
import { startMacCandidateFeed } from './mac-candidate-feed.mjs'

const exec = promisify(execFile)
const oldVersion = '0.1.0-test.20261119.1'
const newVersion = '0.1.0-test.20261120.1'
const candidateCommit = '3c6b00d9827fe49f4766fb6b4ce0139a554f0c72'
const arch = process.env.QA_ARCH
assert.equal(process.platform, 'darwin')
assert.equal(process.env.GITHUB_ACTIONS, 'true')
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted')
assert.equal(process.env.RUNNER_OS, 'macOS')
assert.equal(process.env.GITHUB_REPOSITORY, 'TLBtianhu/Agentrans')
assert.ok(arch === 'arm64' || arch === 'x64')
assert.equal(process.arch, arch, 'The runner must natively match the package architecture')
assert.equal(process.env.RUNNER_ARCH, arch === 'arm64' ? 'ARM64' : 'X64')
const temporary = await realpath(process.env.RUNNER_TEMP)
const runnerHome = await realpath(userInfo().homedir)
const stateRoot = join(runnerHome, 'Library', 'Application Support', 'com.agentrans.app')
const journal = join(stateRoot, 'data', 'install', 'update-journal')
const cacheRoot = join(runnerHome, 'Library', 'Caches')

function underTemporary(path) {
  const offset = relative(temporary, path)
  assert.ok(offset !== '' && !isAbsolute(offset) && offset !== '..' && !offset.startsWith(`..${sep}`),
    'Use only runner-owned input and output paths')
  return path
}

async function input(path) {
  assert.ok(path && isAbsolute(path), 'Expected an absolute runner input')
  const resolved = underTemporary(await realpath(path))
  assert.ok((await lstat(resolved)).isFile(), 'Expected an ordinary runner input file')
  return resolved
}

const [oldDmg, newZip, metadataPath, rootCa, tlsKey, tlsCert] = await Promise.all(
  ['QA_OLD_DMG', 'QA_NEW_ZIP', 'QA_NEW_METADATA', 'QA_TLS_ROOT_CA', 'QA_TLS_KEY', 'QA_TLS_CERT'].map(name => input(process.env[name])),
)
const [oldSignature, zipSignature, metadataSignature] = await Promise.all(
  [oldDmg, newZip, metadataPath].map(file => input(`${file}.sig`)),
)
const expectedNewHash = process.env.QA_EXPECTED_NEW_SHA256
assert.match(expectedNewHash, /^[a-f0-9]{64}$/u)
assert.equal(basename(oldDmg), `agentrans-${oldVersion}-mac-${arch}-unsigned.dmg`)
assert.equal(basename(newZip), `agentrans-${newVersion}-mac-${arch}-unsigned.zip`)
assert.equal(basename(metadataPath), 'test-mac.yml')
const reportArgument = process.env.QA_REPORT_DIR
assert.ok(reportArgument && isAbsolute(reportArgument))
const reportRoot = underTemporary(join(await realpath(dirname(reportArgument)), basename(reportArgument)))
await mkdir(reportRoot, { mode: 0o700 })
const workRoot = await mkdtemp(join(temporary, `agentrans-candidate-${arch}-`))
const reportPath = join(reportRoot, 'result.json')
const record = { evidenceVersion: 2, architecture: arch, oldVersion, newVersion, candidateCommit, stateLayout: 'ordinary runner account', passed: false }

function cleanText(value) {
  return String(value).replaceAll(temporary, '<runner-temp>').replaceAll(process.cwd(), '<checkout>')
    .replaceAll(runnerHome, '<runner-home>').replace(/([?&]token=)[A-Za-z0-9_-]+/giu, '$1<redacted>').slice(-8000)
}

async function save() {
  await writeFile(reportPath, JSON.stringify(record, null, 2) + '\n')
}

async function command(file, args, timeout = 120_000) {
  const result = await exec(file, args, {
    encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024,
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C', TMPDIR: workRoot },
  })
  return result.stdout.trim()
}

async function sha256(file) {
  const hash = createHash('sha256')
  for await (const bytes of createReadStream(file)) hash.update(bytes)
  return hash.digest('hex')
}

async function inspectCodeSignature(app) {
  async function codesign(args) {
    try {
      const { stdout, stderr } = await exec('/usr/bin/codesign', [...args, app], { encoding: 'utf8', timeout: 90_000 })
      return { passed: true, output: cleanText((stdout + stderr).trim()) }
    } catch (error) { return { passed: false, output: cleanText(error.stderr || error.message) } }
  }
  return { strict: await codesign(['--verify', '--strict']), designatedRequirement: await codesign(['-d', '-r-']) }
}

async function bundleEvidence(app, version, verifyCandidateCommit = false) {
  assert.ok((await lstat(app)).isDirectory())
  const code = await realpath(join(app, 'Contents'))
  const resources = await realpath(join(code, 'Resources'))
  assert.equal(code, join(app, 'Contents'))
  assert.equal(resources, join(code, 'Resources'))
  const plist = join(code, 'Info.plist')
  const field = key => command('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plist])
  assert.equal(await field('CFBundleIdentifier'), 'com.agentrans.app')
  const shortVersion = await field('CFBundleShortVersionString')
  assert.equal(shortVersion, version)
  assert.equal(await field('CFBundleExecutable'), 'Agentrans')
  const executable = join(code, 'MacOS', 'Agentrans')
  const architecture = await command('/usr/bin/lipo', ['-archs', executable])
  assert.equal(architecture, arch === 'arm64' ? 'arm64' : 'x86_64')
  const updateConfig = await readFile(join(resources, 'app-update.yml'), 'utf8')
  for (const value of ['provider: github', 'owner: TLBtianhu', 'repo: Agentrans', 'channel: nightly']) {
    assert.ok(updateConfig.split(/\r?\n/u).includes(value), `Expected bundle updater config ${value}`)
  }
  const archive = join(resources, 'app.asar')
  const manifest = await installedManifest(archive)
  assert.equal(manifest.version, version)
  if (verifyCandidateCommit) {
    assert.equal(manifest.dshBuildCommit, candidateCommit)
    assert.equal(manifest.dshBuildDirty, false)
  }
  const [asarSha256, executableSha256, signature] = await Promise.all([sha256(archive), sha256(executable), inspectCodeSignature(app)])
  return { executable, plist, updateConfig, evidence: { shortVersion, architecture, asarSha256, executableSha256,
    buildCommit: manifest.dshBuildCommit ?? null, buildDirty: manifest.dshBuildDirty ?? null, signature } }
}

async function installedManifest(archivePath) {
  // An ASAR begins with an eight-byte Pickle for the header size; the next Pickle contains the file table.
  const archive = await open(archivePath, 'r')
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

// Chromium owns the local DevTools pipe; no debugger port is exposed.
function debuggerPipe(input, output) {
  const pending = new Map()
  let next = 0
  let frame = ''
  let closed
  function disconnect(error) {
    closed ??= error
    for (const reply of pending.values()) reply.complete(error)
  }
  output.setEncoding('utf8')
  output.on('data', chunk => {
    frame += chunk
    let offset
    while ((offset = frame.indexOf('\0')) !== -1) {
      const raw = frame.slice(0, offset)
      frame = frame.slice(offset + 1)
      try {
        const reply = JSON.parse(raw)
        pending.get(reply.id)?.complete(reply.error ? new Error(reply.error.message) : undefined, reply.result)
      } catch (error) { disconnect(error) }
    }
    if (frame.length > 2 * 1024 * 1024) disconnect(new Error('Oversized DevTools reply'))
  })
  for (const stream of [input, output]) {
    stream.once('close', () => disconnect(new Error('DevTools pipe closed')))
    stream.once('error', disconnect)
  }
  return {
    send(method, params = {}, sessionId) {
      if (closed) return Promise.reject(closed)
      const id = ++next
      return new Promise((resolve, reject) => {
        function complete(error, value) {
          clearTimeout(timeout)
          pending.delete(id)
          if (error) reject(error)
          else resolve(value)
        }
        const timeout = setTimeout(() => complete(new Error(`DevTools timed out for ${method}`)), 4000)
        pending.set(id, { complete })
        input.write(`${JSON.stringify({ id, method, params, sessionId })}\0`, error => { if (error) complete(error) })
      })
    },
    close() { disconnect(new Error('DevTools pipe disposed')); input.destroy(); output.destroy() },
  }
}

async function evaluate(cdp, sessionId, expression) {
  const answer = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId)
  if (answer.exceptionDetails) throw new Error(answer.exceptionDetails.exception?.description ?? answer.exceptionDetails.text)
  return answer.result.value
}

async function poll(action, label, duration = 90_000) {
  const finish = Date.now() + duration
  let error
  while (Date.now() < finish) {
    try {
      const value = await action()
      if (value !== undefined) return value
    } catch (failure) { error = failure }
    await delay(250)
  }
  throw new Error(`Timed out waiting for ${label}${error ? ` (${error.message})` : ''}`)
}

async function groupMembers(group) {
  const id = process.getuid()
  const list = await command('/bin/ps', ['-ax', '-o', 'pid=,pgid=,uid=,state='], 4000)
  return list.split('\n').flatMap(row => {
    const [pid, pgid, uid, state] = row.trim().split(/\s+/u)
    return Number(pgid) === group && Number(uid) === id && !state?.startsWith('Z') ? [Number(pid)] : []
  })
}

async function stop(child, cdp, closed) {
  if (child.exitCode === null && child.signalCode === null) await cdp.send('Browser.close').catch(() => undefined)
  cdp.close()
  if (!Number.isSafeInteger(child.pid)) return
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    if (!await Promise.race([closed.then(() => true), delay(2000, false, { ref: false })])
      || (await groupMembers(child.pid)).length > 0) {
      for (const pid of await groupMembers(child.pid)) {
        if (!(await groupMembers(child.pid)).includes(pid)) continue
        try { process.kill(pid, signal) }
        catch (error) { if (error.code !== 'ESRCH') throw error }
      }
    }
  }
  await poll(async () => (await groupMembers(child.pid)).length === 0 ? true : undefined, 'the owned process group to stop', 8000)
  assert.ok(await Promise.race([closed.then(() => true), delay(3000, false, { ref: false })]), 'App streams did not reach quiescence')
}

async function journalEvents(directory, pid) {
  const files = await readdir(directory).catch(error => {
    if (error.code !== 'ENOENT') throw error
    return []
  })
  const events = []
  for (const file of files.filter(name => name.endsWith('.jsonl'))) {
    const lines = (await readFile(join(directory, file), 'utf8')).split('\n').slice(0, -1)
    for (const line of lines) {
      const event = JSON.parse(line)
      if (event.pid === pid) events.push(event)
    }
  }
  return events
}

async function callSession(cdp, sessionId, method, args) {
  const rpcId = randomUUID()
  const body = JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } })
  return evaluate(cdp, sessionId, `(async () => {
    const response = await fetch(${JSON.stringify('/api/' + method)}, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: ${JSON.stringify(body)}, signal: AbortSignal.timeout(6_000),
    })
    if (!response.ok) throw new Error(${JSON.stringify(method)} + ' returned HTTP ' + response.status)
    const envelope = await response.json()
    if (envelope.rpcId !== ${JSON.stringify(rpcId)}) throw new Error('Mismatched Session RPC response ID')
    if (envelope.result?.ok !== true) {
      const error = envelope.result?.error
      throw new Error(${JSON.stringify(method)} + ': ' + (error?.code ?? 'invalid response') + ': ' + (error?.message ?? ''))
    }
    return envelope.result.value
  })()`, 8_000)
}

async function verifySession(application, { sessionId, title, titleEventSequence }) {
  await poll(async () => {
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

const dialogUrl = 'dsh-app://shell/update-dialog.html'
const workspacePage = url => url.startsWith('dsh-app://app/')

function launchApp(bundle, stage, tlsSpki) {
  const env = {
    ...Object.fromEntries(['PATH', 'USER', 'LOGNAME', 'LANG', 'LC_ALL'].filter(key => process.env[key])
      .map(key => [key, process.env[key]])),
    HOME: runnerHome, TMPDIR: stage, NODE_EXTRA_CA_CERTS: rootCa,
    AGENTRANS_TELEMETRY_DISABLED: '1', AGENTRANS_DESKTOP_UPDATE_CHECK_INTERVAL_MS: '3600000',
    AGENTRANS_DESKTOP_UPDATE_JOURNAL_DIR: journal,
  }
  const child = spawn(bundle.executable, ['--remote-debugging-pipe', '--enable-logging=stderr',
    '--disable-backgrounding-occluded-windows', '--no-proxy-server',
    '--host-resolver-rules=MAP github.com 127.0.0.1, MAP api.github.com 127.0.0.1',
    `--ignore-certificate-errors-spki-list=${tlsSpki}`,
  ], { cwd: stage, env, detached: true, stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'] })
  let output = ''
  let spawnError
  child.on('error', error => { spawnError = error })
  const closed = new Promise(resolve => child.once('close', resolve))
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding('utf8')
    stream.on('data', bytes => { output = (output + bytes).slice(-12_000) })
  }
  const cdp = debuggerPipe(child.stdio[3], child.stdio[4])
  const sessions = new Map()
  const events = () => journalEvents(journal, child.pid)
  const runtime = { child, cdp, closed, events, output: () => cleanText(output), workspace: undefined }
  async function page(predicate) {
    if (spawnError) throw spawnError
    const { targetInfos } = await cdp.send('Target.getTargets')
    const target = targetInfos.find(info => info.type === 'page' && predicate(info.url))
    if (!target) return undefined
    if (!sessions.has(target.targetId)) {
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true })
      sessions.set(target.targetId, sessionId)
    }
    return sessions.get(target.targetId)
  }
  async function openWorkspace(version) {
    const welcome = await poll(async () => {
      const target = await page(url => url.startsWith('file:') && url.endsWith('/renderer/welcome.html'))
      if (target && await evaluate(cdp, target, 'Boolean(document.querySelector("#skip-key")?.getClientRects().length)')) return target
    }, 'the packaged welcome window')
    await evaluate(cdp, welcome, "setTimeout(() => document.querySelector('#skip-key').click(), 0); true")
    await waitForWorkspace(version)
  }
  async function waitForWorkspace(version) {
    runtime.workspace = await poll(() => page(workspacePage), 'the packaged workspace')
    await poll(async () => {
      const evidence = await events()
      const ready = evidence.some(event => event.event === 'workspace-ready' && event.version === version)
      const list = await runtime.call('session/list', { _request: {} })
      if (ready && Array.isArray(list.items)) return true
    }, 'authenticated session service and packaged runtime version')
    const device = await runtime.evaluation('window.dshDesktop.deviceInfo()')
    assert.ok(device.split('; ').includes('platform=darwin'))
    assert.ok(device.split('; ').includes(`app_arch=${arch}`))
  }
  async function dialog() {
    const sessionId = await page(url => url === dialogUrl)
    if (sessionId === undefined) return undefined
    const view = await evaluate(cdp, sessionId, `({ visible: document.body.classList.contains('visible'),
      title: document.querySelector('#title')?.textContent,
      detail: document.querySelector('#technical-details-content')?.textContent,
      primary: document.querySelector('#actions button.primary')?.textContent })`)
    if (view?.visible && view.primary) return { sessionId, ...view }
  }
  return Object.assign(runtime, { openWorkspace, waitForWorkspace, dialog,
    evaluation: expression => evaluate(cdp, runtime.workspace, expression),
    call: (method, args) => callSession(cdp, runtime.workspace, method, args),
    click: sessionId => evaluate(cdp, sessionId, "setTimeout(() => document.querySelector('#actions button.primary').click(), 0); true"),
  })
}

async function createTestSession(application, stage) {
  const initial = await application.call('session/list', { _request: {} })
  assert.equal(initial.items.filter(row => !row.blank).length, 0, 'The runner already has saved sessions')
  const workspace = await mkdtemp(join(stage, 'session-workspace-'))
  const { sessionId, agentPreset } = await application.call('session/create', { request: { cwd: workspace } })
  assert.match(sessionId, /^[a-z0-9_-]+$/iu)
  assert.equal(agentPreset, 'standard')
  const prompt = await application.call('session/prompt', { request: {
    sessionId, requestId: randomUUID(), mode: 'queue',
    content: [{ type: 'text', text: 'Native macOS Session persistence fixture' }],
  } })
  assert.equal(prompt.accepted, true)
  const title = 'Agentrans native persistence ' + randomUUID()
  const renamed = await application.call('session/rename', { request: { sessionId, title } })
  assert.equal(renamed.title, title)
  assert.ok(Number.isSafeInteger(renamed.seq) && renamed.seq > 0)
  return { sessionId, title, titleEventSequence: renamed.seq }
}

async function ownedApplicationPids(executable) {
  const lines = await command('/bin/ps', ['-axww', '-o', 'pid=,uid=,state=,command='], 6000)
  const uid = process.getuid()
  return lines.split('\n').flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/u.exec(line)
    if (!match || Number(match[2]) !== uid || match[3].startsWith('Z')) return []
    const invocation = match[4]
    return invocation === executable || invocation.startsWith(executable + ' ') ? [Number(match[1])] : []
  })
}

async function stopRelaunch(executable, pid) {
  if (!(await ownedApplicationPids(executable)).includes(pid)) return
  try { process.kill(pid, 'SIGTERM') }
  catch (error) { if (error.code !== 'ESRCH') throw error }
  await poll(async () => (await ownedApplicationPids(executable)).includes(pid) ? undefined : true,
    'the observed installed application to stop before same-profile inspection', 15_000)
}

function feedSummary() {
  const snapshot = feed?.snapshot()
  if (!snapshot) return undefined
  const { requests, ...totals } = snapshot
  return { ...totals, sampledRequests: requests.slice(0, 30) }
}

async function nativeLog() {
  const logRoot = join(cacheRoot, 'com.agentrans.app.ShipIt')
  const files = await readdir(logRoot).catch(error => {
    if (error.code !== 'ENOENT') throw error
    return []
  })
  const logs = await Promise.all(files.filter(name => /^ShipIt_(?:stdout|stderr)\.log$/u.test(name)).map(async name => {
    const path = join(logRoot, name)
    if (!(await lstat(path)).isSymbolicLink()) return cleanText(await readFile(path, 'utf8'))
    return ''
  }))
  return logs.join('\n').trim()
}

let stage = 'verify exact inputs'
let feed
let baseline
let restarted
let relaunchedPid
let installedPath
try {
  await assert.rejects(lstat(stateRoot), { code: 'ENOENT' }, 'The runner already has an Agentrans profile')
  const key = publicKeyFromBase64(UPDATE_SIGNING_PUBLIC_KEY)
  for (const [asset, signature] of [[oldDmg, oldSignature], [newZip, zipSignature], [metadataPath, metadataSignature]]) {
    assert.ok(await verifyFileDigest(asset, (await readFile(signature, 'utf8')).trim(), key), `Bad Ed25519 signature for ${basename(asset)}`)
  }
  const [oldSha256, newSha256, indexSha256] = await Promise.all([sha256(oldDmg), sha256(newZip), sha256(metadataPath)])
  assert.equal(newSha256, expectedNewHash, 'Candidate ZIP bytes differ from the validated Actions input')
  record.input = { oldName: basename(oldDmg), newName: basename(newZip), oldSha256, newSha256, indexSha256, ed25519Verified: true }
  const originalStage = await mkdtemp(join(workRoot, 'baseline-'))
  const candidateStage = await mkdtemp(join(workRoot, 'candidate-'))
  stage = 'stage original old DMG and inspect candidate ZIP'
  record.baselineDiskImage = {}
  record.candidateArchive = {}
  installedPath = await prepareDmg(oldDmg, originalStage, record.baselineDiskImage)
  const candidatePath = await prepareZip(newZip, candidateStage, record.candidateArchive)
  const original = await bundleEvidence(installedPath, oldVersion)
  const candidate = await bundleEvidence(candidatePath, newVersion, true)
  record.baseline = original.evidence
  record.candidate = candidate.evidence
  await save()
  assert.deepEqual(await ownedApplicationPids(original.executable), [], 'The runner already owns an Agentrans process for this copy')

  stage = 'start isolated HTTPS fixture'
  for (const hostname of ['github.com', 'api.github.com']) {
    assert.equal((await lookup(hostname, { family: 4 })).address, '127.0.0.1')
  }
  const tls = { key: await readFile(tlsKey), cert: await readFile(tlsCert) }
  const tlsSpki = createHash('sha256').update(new X509Certificate(tls.cert).publicKey.export({ type: 'spki', format: 'der' })).digest('base64')
  feed = await startMacCandidateFeed({ arch, zipPath: newZip, metadataPath, signaturePath: zipSignature,
    metadataSignaturePath: metadataSignature, expectedZipSha256: expectedNewHash, tls })

  stage = 'launch public version and save original session'
  baseline = launchApp(original, originalStage, tlsSpki)
  await baseline.openWorkspace(oldVersion)
  const session = await createTestSession(baseline, originalStage)
  record.beforeUpgrade = { pid: baseline.child.pid, version: oldVersion, ...session, ...await verifySession(baseline, session) }
  await save()

  stage = 'download and verify candidate through the installed updater'
  const offer = await poll(async () => {
    const status = await baseline.evaluation('window.dshDesktop.updates.status()')
    if (status?.phase === 'available' || status?.phase === 'error') return status
  }, 'the old app to discover the candidate')
  assert.equal(offer.phase, 'available', `Unexpected packaged update check result ${JSON.stringify(offer)}`)
  assert.equal(offer.version, newVersion)
  await baseline.evaluation('setTimeout(() => { void window.dshDesktop.updates.open().catch(() => {}); }, 0); true')
  const confirmation = await poll(async () => {
    const events = await baseline.events()
    const view = await baseline.dialog()
    if (events.some(event => event.phase === 'error' && event.failedOperation === 'download')) {
      if (!view) return undefined
      return { failed: true, ...view }
    }
    if (view?.title.includes(newVersion) && events.some(event => event.phase === 'ready' && event.targetVersion === newVersion)) return view
  }, 'the verified download and real install confirmation', 150_000)
  assert.ok(!confirmation.failed, cleanText(confirmation.detail || 'macOS download failed'))
  const cacheName = original.updateConfig.match(/^updaterCacheDirName:\s*['"]?([a-z0-9_.-]+)['"]?\s*$/imu)?.[1]
  assert.ok(cacheName && cacheName !== '.' && cacheName !== '..')
  const cachedUpdate = join(cacheRoot, cacheName, 'pending', basename(newZip))
  assert.equal(await sha256(cachedUpdate), newSha256, 'The native updater must receive the original Actions ZIP')
  const readyFeed = feed.snapshot()
  assert.ok(readyFeed.releaseCatalogRequests > 0 && readyFeed.metadataRequests > 0 && readyFeed.signatureRequests > 0)
  assert.equal(readyFeed.deliveredBytes, readyFeed.packageBytes)
  record.ready = { version: newVersion, downloadSha256: newSha256, ed25519Accepted: true }
  await save()

  stage = 'attempt real Squirrel installation'
  feed.stopServingPayload()
  await baseline.click(confirmation.sessionId)
  const outcome = await poll(async () => {
    const evidence = await baseline.events()
    if (!evidence.some(event => event.event === 'install-confirmed')) return undefined
    if (evidence.some(event => event.phase === 'error' && event.failedOperation === 'install')) {
      const view = await baseline.dialog()
      if (view?.detail) return { result: 'native-rejected', details: cleanText(view.detail), dialogId: view.sessionId }
    }
    if (baseline.child.exitCode !== null) {
      const version = await command('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', original.plist], 6_000)
      if (version !== newVersion) return undefined
      const launches = (await ownedApplicationPids(original.executable)).filter(pid => pid !== baseline.child.pid)
      if (launches.length === 1) return { result: 'installed-and-automatically-restarted', pid: launches[0] }
    }
  }, 'native install rejection or automatic relaunch of the candidate', 105_000)
  record.nativeInstallation = { result: outcome.result, userConfirmationObserved: true,
    ...(outcome.details ? { details: outcome.details } : {}) }

  if (outcome.result === 'native-rejected') {
    stage = 'verify original app and session after native rejection'
    await save()
    const stillInstalled = await bundleEvidence(installedPath, oldVersion)
    assert.equal(stillInstalled.evidence.asarSha256, original.evidence.asarSha256)
    assert.equal(stillInstalled.evidence.executableSha256, original.evidence.executableSha256)
    await baseline.click(outcome.dialogId)
    await baseline.waitForWorkspace(oldVersion)
    record.afterRejectedInstall = { installedVersion: oldVersion, pid: baseline.child.pid, ...session,
      originalBundleIntact: true, ...await verifySession(baseline, session) }
    await save()
    stage = 'attempt real Squirrel installation'
    throw new Error(outcome.details)
  }

  stage = 'verify automatic restart and candidate identity'
  relaunchedPid = outcome.pid
  assert.equal(baseline.child.exitCode, 0, 'Expected the installed version to quit cleanly')
  const installed = await bundleEvidence(installedPath, newVersion, true)
  assert.equal(installed.evidence.asarSha256, candidate.evidence.asarSha256)
  assert.equal(installed.evidence.executableSha256, candidate.evidence.executableSha256)
  record.automaticRestart = { oldProcessId: baseline.child.pid, newProcessId: relaunchedPid,
    launcher: 'Squirrel.Mac', installed: installed.evidence }
  await save()

  stage = 'reopen the original session in the upgraded app'
  // The automatic launch does not inherit the test's debugger pipe. Inspect the same installed app and profile in a subsequent launch.
  await stopRelaunch(installed.executable, relaunchedPid)
  relaunchedPid = undefined
  const catalogBeforeInspection = feed.snapshot().releaseCatalogRequests
  restarted = launchApp(installed, originalStage, tlsSpki)
  await restarted.openWorkspace(newVersion)
  record.afterUpgrade = { version: newVersion, inspectionPid: restarted.child.pid, ...session, ...await verifySession(restarted, session) }
  await poll(() => feed.snapshot().releaseCatalogRequests > catalogBeforeInspection ? true : undefined,
    'the upgraded client to query its same HTTPS release catalog', 30_000)
  assert.equal(feed.snapshot().blockedPayloadRequests, 0)
  record.passed = true
} catch (error) {
  record.failure = { stage, message: cleanText(error.message) }
  console.error(`macOS ${arch} update failed in ${stage}: ${record.failure.message}`)
  process.exitCode = 1
} finally {
  record.feed = feedSummary()
  if (baseline !== undefined) {
    record.updateEvents = await baseline.events().catch(() => [])
    if (!record.passed) {
      record.nativeDiagnostics = { app: baseline.output(), shipIt: await nativeLog().catch(error => cleanText(error.message)) }
    }
  }
  const cleanupErrors = []
  if (relaunchedPid !== undefined && installedPath !== undefined) {
    await stopRelaunch(join(installedPath, 'Contents', 'MacOS', 'Agentrans'), relaunchedPid)
      .catch(error => cleanupErrors.push(cleanText(error.message)))
  }
  for (const application of [restarted, baseline]) {
    if (application) await stop(application.child, application.cdp, application.closed)
      .catch(error => cleanupErrors.push(cleanText(error.message)))
  }
  if (feed) await feed.close().catch(error => cleanupErrors.push(cleanText(error.message)))
  if (cleanupErrors.length > 0) {
    process.exitCode = 1
    record.cleanupErrors = cleanupErrors
    record.passed = false
  }
  await save()
}
