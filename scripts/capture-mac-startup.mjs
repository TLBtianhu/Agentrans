
/** Capture the error Electron's packaged main process sends to its native error dialog. */
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

assert.equal(process.platform, 'darwin')
assert.equal(process.env.GITHUB_ACTIONS, 'true')
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted')
const [input, destination, arch] = process.argv.slice(2)
assert.ok(isAbsolute(input) && isAbsolute(destination) && ['arm64', 'x64'].includes(arch))
assert.equal(process.arch, arch)
const temp = await realpath(process.env.RUNNER_TEMP)
const artifactDir = await realpath(input)
assert.equal(dirname(artifactDir), temp)
assert.equal(await realpath(dirname(destination)), temp)
assert.equal(basename(destination), 'agentrans-mac-launch-report')
const root = join(temp, basename(destination))
await mkdir(root, { mode: 0o700 })
const reportPath = join(root, 'result.json')
const version = '0.1.0-test.20261118.3'
const zip = join(artifactDir, 'agentrans-' + version + '-mac-' + arch + '-unsigned.zip')
const expectedSha = {
  arm64: 'd1e706067acca93991189002575076f298ce425c42607250782533ebd599ff5a',
  x64: '95ac2c7fc8d748ce6b77ddc71af6a32651bf147f6fb852ca4f553a53800dae9e',
}
const result = { version, architecture: arch, probes: {}, passed: false }
const save = () => writeFile(reportPath, JSON.stringify(result, null, 2) + '\n')
await save()

const hash = createHash('sha256')
assert.ok((await lstat(zip)).isFile())
for await (const chunk of createReadStream(zip)) hash.update(chunk)
result.zipSha256 = hash.digest('hex')
assert.equal(result.zipSha256, expectedSha[arch])
execFileSync('/usr/bin/ditto', ['-x', '-k', zip, root], { timeout: 150_000 })
const codeRoot = await realpath(join(root, 'Agentrans.app', 'Contents'))
const resourcesRoot = await realpath(join(codeRoot, 'Resources'))
const executable = join(codeRoot, 'MacOS', 'Agentrans')

async function connect(endpoint) {
  const url = new URL(endpoint)
  assert.equal(url.protocol, 'ws:')
  assert.equal(url.hostname, '127.0.0.1')
  const ws = new WebSocket(url)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', reject, { once: true })
    AbortSignal.timeout(5_000).addEventListener('abort', () => reject(new Error('Inspector open timeout')), { once: true })
  })
  const pending = new Map()
  const api = { ws, paused: undefined }
  let id = 0
  ws.addEventListener('message', event => {
    const message = JSON.parse(event.data)
    if (message.id) {
      const handlers = pending.get(message.id)
      if (handlers) {
        if (message.error) handlers.reject(new Error(message.error.message))
        else handlers.resolve(message.result)
      }
    } else if (message.method === 'Debugger.paused') {
      void api.paused?.(message.params)
    }
  })
  api.call = async (method, params = {}) => {
    const requestId = ++id
    try {
      return await new Promise((resolve, reject) => {
        pending.set(requestId, { resolve, reject })
        AbortSignal.timeout(5_000).addEventListener('abort', () => reject(new Error('Inspector timeout: ' + method)), { once: true })
        ws.send(JSON.stringify({ id: requestId, method, params }))
      })
    } finally { pending.delete(requestId) }
  }
  return api
}

function observer(output) {
  return '(function () { const original = process.emit; const fs = process.getBuiltinModule("node:fs");' +
    'process.emit = function (event, ...args) { if (event === "uncaughtException" && args[0]) {' +
    'try { const error = args[0]; fs.appendFileSync(' + JSON.stringify(output) +
    ', JSON.stringify({name:error.name,code:error.code,message:error.message,stack:String(error.stack ?? error)})+"\\n"); } catch {}' +
    '} return Reflect.apply(original,this,[event,...args]); }; return true; })()'
}

async function capture(mode) {
  const state = join(root, mode + '-state')
  const profile = join(root, mode + '-profile')
  const events = join(root, mode + '-uncaught.jsonl')
  await mkdir(profile, { mode: 0o700 })
  const environment = {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: profile, CFFIXED_USER_HOME: profile,
    TMPDIR: root, AGENTRANS_TELEMETRY_DISABLED: '1',
  }
  if (mode === 'verification') {
    environment.AGENTRANS_LAUNCH_CONTEXT = JSON.stringify({ purpose: 'verification', instanceRoot: state, codeRoot, resourcesRoot })
  }
  const child = spawn(executable, ['--inspect-brk=127.0.0.1:0', '--enable-logging=stderr', '--user-data-dir=' + profile], {
    env: environment, cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  })
  const probe = result.probes[mode] = { pid: child.pid, exceptions: [] }
  let exited
  const closed = new Promise(resolve => {
    child.once('close', (code, signal) => { exited = { code, signal }; resolve() })
    child.once('error', error => { probe.spawnError = error.message; resolve() })
  })
  let stderr = ''
  let stdout = ''
  child.stderr.on('data', value => { stderr = (stderr + value.toString()).slice(-48_000) })
  child.stdout.on('data', value => { stdout = (stdout + value.toString()).slice(-12_000) })
  let client
  try {
    let endpoint
    for (let count = 0; count < 120 && !exited; count++) {
      endpoint = stderr.match(/Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9-]+)/u)?.[1]
      if (endpoint) break
      await delay(100)
    }
    assert.ok(endpoint, 'The packaged main-process inspector did not listen on loopback')
    client = await connect(endpoint)
    let installedObserver = false
    client.paused = async pause => {
      try {
        if (!installedObserver && pause.callFrames?.length) {
          const installed = await client.call('Debugger.evaluateOnCallFrame', {
            callFrameId: pause.callFrames[0].callFrameId, expression: observer(events), returnByValue: true,
          })
          assert.equal(installed.result?.value, true, installed.exceptionDetails?.text)
          installedObserver = true
          probe.observerInstalled = true
        }
        if (['exception', 'promiseRejection'].includes(pause.reason) && probe.exceptions.length < 60) {
          probe.exceptions.push({
            reason: pause.reason,
            description: String(pause.data?.description ?? pause.data?.value ?? '').slice(0, 18_000),
            frames: pause.callFrames?.slice(0, 6).map(frame => frame.functionName),
          })
        }
      } catch (error) {
        probe.inspectorObservationError = error.message
      } finally {
        await client.call('Debugger.resume').catch(() => undefined)
      }
    }
    await client.call('Runtime.enable')
    const earlyObserver = await client.call('Runtime.evaluate', { expression: observer(events), returnByValue: true })
    if (earlyObserver.result?.value === true) {
      installedObserver = true
      probe.observerInstalled = true
    }
    await client.call('Debugger.enable')
    await client.call('Debugger.setPauseOnExceptions', { state: 'all' })
    await client.call('Runtime.runIfWaitingForDebugger')
    const deadline = Date.now() + 35_000
    while (Date.now() < deadline && !exited) {
      const raw = await readFile(events, 'utf8').catch(() => '')
      if (raw.trim()) {
        const errors = raw.trim().split('\n').map(line => JSON.parse(line))
        probe.alerts = errors.map(error => ({
          title: 'A JavaScript error occurred in the main process',
          message: 'Uncaught Exception:\n' + error.stack,
          error,
        }))
        break
      }
      await delay(120)
    }
  } catch (error) {
    probe.failure = error.stack
  } finally {
    if (client) client.ws.close()
    if (!exited && Number.isSafeInteger(child.pid)) {
      try { process.kill(-child.pid, 'SIGTERM') } catch (error) { if (error.code !== 'ESRCH') throw error }
      await Promise.race([closed, delay(4_000, undefined, { ref: false })])
      if (!exited) {
        try { process.kill(-child.pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
        await closed
      }
    }
    probe.exit = exited
    probe.stderr = stderr.replaceAll(/ws:\/\/127\.0\.0\.1:[0-9]+\/[A-Za-z0-9-]+/g, '<loopback-inspector>')
    probe.stdout = stdout
    await save()
  }
}

await capture('normal')
await capture('verification')
result.passed = Object.values(result.probes).every(probe => probe.alerts?.length || probe.exceptions.length)
await save()
for (const [mode, probe] of Object.entries(result.probes)) {
  console.log(mode + ' exact alert count: ' + (probe.alerts?.length ?? 0) + ', debugger exceptions: ' + probe.exceptions.length)
}
if (!result.passed) process.exitCode = 2
