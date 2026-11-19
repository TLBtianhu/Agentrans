/** Verify detached update signatures using real packaged macOS builds and the installed updater. */
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash, X509Certificate } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { startMacEd25519Fixture } from './macos-ed25519-feed.mjs'

const exec = promisify(execFile)
const oldVersion = '0.1.0-test.20261118.4'
const newVersion = '0.1.0-test.20261118.5'
const arch = process.env.QA_ARCH
assert.equal(process.platform, 'darwin')
assert.equal(process.env.GITHUB_ACTIONS, 'true')
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted')
assert.ok(arch === 'arm64' || arch === 'x64')
assert.equal(process.arch, arch, 'Use a native Mac matching the packaged architecture')
assert.equal(process.env.RUNNER_ARCH, arch === 'arm64' ? 'ARM64' : 'X64')
const temporary = await realpath(process.env.RUNNER_TEMP)

function underTemporary(path) {
  const offset = relative(temporary, path)
  assert.ok(offset !== '' && !isAbsolute(offset) && offset !== '..' && !offset.startsWith(`..${sep}`),
    'The qualification may access only runner-owned inputs and outputs')
  return path
}

async function input(name) {
  const path = process.env[name]
  assert.ok(path && isAbsolute(path), `${name} must be an absolute path`)
  const resolved = underTemporary(await realpath(path))
  assert.ok((await lstat(resolved)).isFile(), `${name} must identify a retained file`)
  return resolved
}

const [oldZip, newZip, rootCa, tlsKey, tlsCert] = await Promise.all(
  ['QA_OLD_ZIP', 'QA_NEW_ZIP', 'QA_TLS_ROOT_CA', 'QA_TLS_KEY', 'QA_TLS_CERT'].map(input),
)
const signaturePath = underTemporary(await realpath(`${newZip}.sig`))
assert.equal(basename(oldZip), `agentrans-${oldVersion}-mac-${arch}-unsigned.zip`)
assert.equal(basename(newZip), `agentrans-${newVersion}-mac-${arch}-unsigned.zip`)
assert.equal(basename(signaturePath), `${basename(newZip)}.sig`)
const reportArgument = process.env.QA_REPORT_DIR
assert.ok(reportArgument && isAbsolute(reportArgument))
const reportRoot = underTemporary(join(await realpath(dirname(reportArgument)), basename(reportArgument)))
await mkdir(reportRoot, { mode: 0o700 })
const workRoot = await mkdtemp(join(temporary, `agentrans-ed25519-${arch}-`))
const reportPath = join(reportRoot, 'result.json')
const record = { architecture: arch, oldVersion, newVersion, input: {}, cases: {}, passed: false }

function cleanText(value) {
  return String(value).replaceAll(temporary, '<runner-temp>').replaceAll(process.cwd(), '<checkout>')
    .replace(/([?&]token=)[A-Za-z0-9_-]+/giu, '$1<redacted>').slice(-8000)
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

async function prepareApp(stage) {
  const paths = (await command('/usr/bin/zipinfo', ['-1', oldZip])).split(/\r?\n/u)
  assert.ok(paths.includes('Agentrans.app/Contents/Info.plist'))
  for (const entry of paths) {
    assert.ok(!entry.startsWith('/') && !entry.includes('\\') && !entry.split('/').includes('..'), 'Unsafe ZIP entry')
    assert.ok(entry === 'Agentrans.app' || entry.startsWith('Agentrans.app/') || entry.startsWith('__MACOSX/'), 'Unexpected ZIP entry')
  }
  await command('/usr/bin/ditto', ['-x', '-k', oldZip, stage], 240_000)
  const app = join(stage, 'Agentrans.app')
  const code = await realpath(join(app, 'Contents'))
  const resources = await realpath(join(code, 'Resources'))
  assert.equal(code, join(app, 'Contents'))
  assert.equal(resources, join(code, 'Resources'))
  const plist = join(code, 'Info.plist')
  const field = key => command('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plist])
  assert.equal(await field('CFBundleIdentifier'), 'com.agentrans.app')
  assert.equal(await field('CFBundleShortVersionString'), oldVersion)
  assert.equal(await field('CFBundleExecutable'), 'Agentrans')
  const executable = join(code, 'MacOS', 'Agentrans')
  assert.equal(await command('/usr/bin/lipo', ['-archs', executable]), arch === 'arm64' ? 'arm64' : 'x86_64')
  const updateConfig = await readFile(join(resources, 'app-update.yml'), 'utf8')
  for (const setting of ['provider: github', 'owner: TLBtianhu', 'repo: Agentrans', 'channel: nightly']) {
    assert.ok(updateConfig.split(/\r?\n/u).includes(setting), `Expected embedded updater config ${setting}`)
  }
  return { app, executable, resources, code, plist }
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

async function downloadedSha256(home) {
  const directory = join(home, 'Library', 'Caches')
  const files = await readdir(directory, { recursive: true })
  const path = files.find(file => basename(file) === basename(newZip) && file.split(sep).includes('pending'))
  assert.ok(path, 'Expected the downloaded update in this isolated cache')
  return sha256(join(directory, path))
}

async function nativeSignatureIssue(app) {
  try { await command('/usr/bin/codesign', ['--verify', '--strict', app]) }
  catch (error) {
    if (typeof error.stderr !== 'string' || !error.stderr.trim()) throw error
    return cleanText(error.stderr.trim())
  }
}

const dialogUrl = 'dsh-app://shell/update-dialog.html'
const signatureError = `${basename(newZip)} does not match its published signature`

async function checkScenario(mode, tls, tlsSpki) {
  const state = { passed: false }
  record.cases[mode] = state
  console.log(`Preparing the original ${arch} .4 app for the ${mode} update case.`)
  const stage = await mkdtemp(join(workRoot, `${mode}-`))
  const instance = await mkdtemp(join(stage, 'state-'))
  const home = await mkdtemp(join(stage, 'home-'))
  const journal = join(instance, 'data', 'install', 'update-journal')
  const bundle = await prepareApp(stage)
  const feed = await startMacEd25519Fixture({ oldVersion, newVersion, zipPath: newZip, signaturePath, mode, tls })
  const env = {
    ...Object.fromEntries(['PATH', 'USER', 'LOGNAME', 'LANG', 'LC_ALL'].filter(key => process.env[key])
      .map(key => [key, process.env[key]])),
    HOME: home,
    TMPDIR: stage,
    NODE_EXTRA_CA_CERTS: rootCa,
    AGENTRANS_TELEMETRY_DISABLED: '1',
    AGENTRANS_DESKTOP_UPDATE_CHECK_INTERVAL_MS: '3600000',
    AGENTRANS_DESKTOP_UPDATE_JOURNAL_DIR: journal,
    AGENTRANS_LAUNCH_CONTEXT: JSON.stringify({ purpose: 'verification', instanceRoot: instance,
      codeRoot: bundle.code, resourcesRoot: bundle.resources }),
  }
  const child = spawn(bundle.executable, ['--remote-debugging-pipe', '--enable-logging=stderr',
    '--disable-backgrounding-occluded-windows', '--no-proxy-server',
    '--host-resolver-rules=MAP github.com 127.0.0.1, MAP api.github.com 127.0.0.1',
    `--user-data-dir=${join(stage, 'chromium')}`,
    // Trust the single ephemeral TLS key served on loopback inside this test, without changing system trust.
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
  async function dialog() {
    const sessionId = await page(url => url === dialogUrl)
    if (sessionId === undefined) return undefined
    const view = await evaluate(cdp, sessionId, `({visible:document.body.classList.contains('visible'),
      title:document.querySelector('#title')?.textContent,
      detail:document.querySelector('#technical-details-content')?.textContent,
      primary:document.querySelector('#actions button.primary')?.textContent})`)
    if (view?.visible && view.primary) return { sessionId, ...view }
  }

  try {
    const welcome = await poll(async () => {
      const sessionId = await page(url => url.startsWith('file:') && url.endsWith('/renderer/welcome.html'))
      if (sessionId && await evaluate(cdp, sessionId, 'Boolean(document.querySelector("#skip-key")?.getClientRects().length)')) return sessionId
    }, 'the packaged welcome window')
    await evaluate(cdp, welcome, "setTimeout(() => document.querySelector('#skip-key').click(), 0); true")
    const workspace = await poll(() => page(url => url.startsWith('dsh-app://app/')), 'the packaged workspace')
    await poll(async () => (await events()).some(event => event.event === 'workspace-ready' && event.version === oldVersion) ? true : undefined,
      'the old build to finish starting')
    state.startedVersion = oldVersion
    const offer = await poll(async () => {
      const status = await evaluate(cdp, workspace, 'window.dshDesktop.updates.status()')
      return status?.phase === 'available' || status?.phase === 'error' ? status : undefined
    }, 'an update check against the local release feed')
    assert.equal(offer.phase, 'available', `Unexpected update check result ${JSON.stringify(offer)}`)
    assert.equal(offer.version, newVersion)
    console.log(`The installed ${arch} .4 app offered .5 in the ${mode} case.`)
    await evaluate(cdp, workspace, 'setTimeout(() => { void window.dshDesktop.updates.open().catch(() => {}); }, 0); true')
    if (mode === 'tampered') {
      const rejection = await poll(async () => {
        const evidence = await events()
        if (evidence.some(event => event.phase === 'ready' || event.event === 'install-confirmed')) {
          return { forbidden: true }
        }
        if (!evidence.some(event => event.phase === 'error' && event.failedOperation === 'download')) return undefined
        return dialog()
      }, 'signature rejection after the complete package download', 150_000)
      assert.ok(!rejection.forbidden, 'Bytes with an invalid signature became installable')
      assert.ok(rejection.detail?.includes(signatureError), cleanText(rejection.detail ?? 'Missing signature mismatch diagnostic'))
      state.rejection = signatureError
      const status = await evaluate(cdp, workspace, 'window.dshDesktop.updates.status()')
      assert.equal(status.phase, 'error')
      assert.equal(status.failure, 'download')
      state.installationAuthorized = false
    } else {
      const confirmation = await poll(async () => {
        const evidence = await events()
        if (evidence.some(event => event.phase === 'error' && event.failedOperation === 'download')) return { failed: true, ...(await dialog()) }
        if (!evidence.some(event => event.phase === 'ready' && event.targetVersion === newVersion)) return undefined
        const view = await dialog()
        return view?.title?.includes(newVersion) ? view : undefined
      }, 'the install confirmation for the verified update', 150_000)
      assert.ok(!confirmation.failed, confirmation.detail ?? 'Valid update failed before verification')
      state.applicationSignatureAccepted = true
      const signatureIssue = await nativeSignatureIssue(bundle.app)
      if (signatureIssue === undefined) {
        await evaluate(cdp, confirmation.sessionId, "setTimeout(() => document.querySelector('#actions button.primary').click(), 0); true")
        state.nativeInstallation = await poll(async () => {
          const evidence = await events()
          if (!evidence.some(event => event.event === 'install-confirmed')) return undefined
          if (evidence.some(event => event.phase === 'error' && event.failedOperation === 'install')) {
            const rejected = await dialog()
            if (rejected?.detail) return { result: 'rejected', reason: cleanText(rejected.detail) }
          }
          if (child.exitCode === 0) {
            const installedVersion = await command('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', bundle.plist])
            if (installedVersion === newVersion) return { result: 'installed', installedVersion }
          }
        }, 'native installation or its diagnostic', 90_000)
        state.installationAuthorized = true
      } else {
        state.nativeInstallation = { result: 'platform-signature-prerequisite-failed', reason: signatureIssue }
        state.installationAuthorized = false
      }
    }
    state.feed = feed.snapshot()
    assert.ok(state.feed.releaseCatalogRequests >= 1)
    assert.ok(state.feed.metadataRequests >= 1)
    assert.ok(state.feed.signatureRequests >= 1)
    assert.equal(state.feed.deliveredBytes, state.feed.packageBytes, 'Must serve the whole update')
    assert.equal(state.feed.deliveredSha256 === state.feed.originalSha256, mode === 'valid')
    state.cachedSha256 = await downloadedSha256(home)
    assert.equal(state.cachedSha256, state.feed.deliveredSha256, 'The app must cache the exact bytes that the feed delivered')
    state.events = await events()
    assert.ok(state.events.some(event => event.event === 'download-requested'))
    assert.equal(state.events.some(event => event.event === 'install-confirmed'), state.installationAuthorized)
    state.passed = true
    console.log(`Completed the ${arch} ${mode} Ed25519 case.`)
  } catch (error) {
    state.failure = cleanText(error.message)
    state.events = await events()
    state.feed = feed.snapshot()
    state.output = cleanText(output)
    throw error
  } finally {
    try { await stop(child, cdp, closed) }
    finally { await feed.close(); await save() }
  }
}

try {
  for (const hostname of ['github.com', 'api.github.com']) {
    assert.equal((await lookup(hostname, { family: 4 })).address, '127.0.0.1', 'The runner must route releases to its local fixture')
  }
  const tls = { key: await readFile(tlsKey), cert: await readFile(tlsCert) }
  const tlsSpki = createHash('sha256').update(new X509Certificate(tls.cert).publicKey.export({ type: 'spki', format: 'der' })).digest('base64')
  record.input = { oldName: basename(oldZip), newName: basename(newZip), oldSha256: await sha256(oldZip), newSha256: await sha256(newZip) }
  await checkScenario('tampered', tls, tlsSpki)
  await checkScenario('valid', tls, tlsSpki)
  record.passed = true
} catch (error) {
  record.failure = cleanText(error.message)
  throw error
} finally { await save() }
