/** Shipped SDK-minimal profile sharing policy through the source dsh SDK entry. */
import { once } from 'node:events'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DeepSeekHarness } from '@agentrans/sdk-client'
import type {} from '@agentrans/session-log-deepseek'
import { expect, it, onTestFinished } from 'vitest'

const probe = fileURLToPath(new URL('./fixtures/sharing-probe.mjs', import.meta.url))
const networkGuard = new URL('../../../../../../packages/test-support/session-snapshot/tests/fixtures/replay-network-guard.mjs', import.meta.url)
const sharingIds = ['session-log-deepseek', 'plugin-package-inventory-deepseek']

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Expected a fixture JSON object')
  return value as Record<string, unknown>
}

it.each([false, true])('sdk-minimal keeps sharing opt-in through an actual SDK model turn (enabled=%s)', async (enabled) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-sdk-minimal-sharing-')))
  const owned: { harness?: DeepSeekHarness } = {}
  const requests: { path: string; body: Record<string, unknown> }[] = []
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    request.on('end', () => {
      const path = request.url ?? ''
      requests.push({ path, body: object(JSON.parse(Buffer.concat(chunks).toString('utf8'))) })
      if (path !== '/anthropic/v1/messages') {
        response.writeHead(404)
        response.end('{}')
        return
      }
      const frames = [
        { type: 'message_start', message: { id: 'minimal-local-message', type: 'message', role: 'assistant', model: 'local-model',
          content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Local minimal answer.' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } },
        { type: 'message_stop' },
      ]
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(frames.map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(''))
    })
  })
  onTestFinished(async () => {
    // Keep files and the endpoint alive until the owned SDK process is gone.
    let childClosed = false
    const failures: unknown[] = []
    try { await owned.harness?.close(); childClosed = true } catch (error) { failures.push(error) }
    if (server.listening) {
      const closed = once(server, 'close')
      server.close()
      server.closeAllConnections()
      await closed
    }
    if (childClosed) await rm(root, { recursive: true, force: true })
    if (failures.length > 0) throw new AggregateError(failures, `SDK-minimal child cleanup failed; retained ${root}`)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Expected the fixture loopback endpoint')
  const origin = `http://127.0.0.1:${address.port}`
  const patch = join(root, 'sharing.patch.yml')
  await writeFile(patch, JSON.stringify([
    { id: 'llm-deepseek', config: { baseURL: `${origin}/anthropic`, models: [{ id: 'local-model' }],
      apiKeyEnv: 'DEEPSEEK_API_KEY', thinking: 'disabled', retryPolicy: { mode: 'normal', maxRetries: 0 } } },
    ...enabled ? sharingIds.map(id => ({ id, disabled: false })) : [],
    { insert: [{ id: 'sharing-probe', name: probe }] },
  ]))
  const home = join(root, 'home')
  const local = join(root, 'local')
  const roaming = join(root, 'roaming')
  await Promise.all([home, local, roaming].map(path => mkdir(path)))
  // Keep host executable discovery, without inheriting credentials, proxies or Node preloads.
  const environment = Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP']
    .flatMap(name => process.env[name] === undefined ? [] : [[name, process.env[name]]]))
  const auditFile = join(root, 'network-audit.jsonl')
  const harness = new DeepSeekHarness({
    profile: 'sdk-minimal', cwd: root, processCwd: root, dshHome: home, patches: [patch],
    provider: 'deepseek-official', model: 'local-model', initializeTimeoutMs: 30_000, requestTimeoutMs: 30_000,
    env: { ...environment, HOME: home, USERPROFILE: home, LOCALAPPDATA: local, APPDATA: roaming,
      DEEPSEEK_API_KEY: 'local-sdk-minimal-key', DEEPSEEK_BASE_URL: `${origin}/anthropic`,
      NODE_OPTIONS: `--disable-warning=ExperimentalWarning --import=${networkGuard.href}`,
      AGENTRANS_SNAPSHOT_NETWORK_AUDIT_FILE: auditFile },
  })
  owned.harness = harness
  await harness.start()
  const installed = (await readFile(auditFile, 'utf8')).trim().split('\n').map(line => object(JSON.parse(line)))
  expect(installed.some(event => event.kind === 'installed')).toBe(true)
  expect(installed.filter(event => event.kind === 'blocked')).toEqual([])
  const result = await harness.run('Reply locally without calling tools.')
  expect(result.finalResponse).toBe('Local minimal answer.')
  expect(result.finishReason).toBe('completed')
  expect(result.events.flatMap(event => event.type === 'turn/end' ? [event.data.reason.kind] : [])).toEqual(['completed'])
  expect(result.events.filter(event => event.type === 'assistant/attempt')).toEqual([])
  expect(requests.map(request => request.path)).toEqual(['/anthropic/v1/messages'])
  const request = requests[0]
  if (request === undefined) throw new Error('The real minimal profile did not call the local provider')
  expect(request.body).toMatchObject({ model: 'local-model',
    dsh_minimal_fixture_probe: { profile: 'sdk-minimal', sessionLogService: enabled,
      rows: sharingIds.map(id => ({ id, disabled: !enabled, mounted: enabled })) } })
  if (enabled) {
    expect(request.body.dsh_session_log).toMatchObject({ version: 1, session: { id: result.sessionId }, afterSeq: -1 })
    const upload = object(request.body.dsh_session_log)
    expect(Array.isArray(upload.events) && upload.events.length > 0).toBe(true)
    const inventory = object(request.body.dsh_plugin_packages)
    expect(inventory).toMatchObject({ version: 1 })
    expect(inventory.packages).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: '@agentrans/deepseek-llm-api-extensions' }),
      expect.objectContaining({ name: '@agentrans/llm-deepseek-api-key' }),
    ]))
    expect(result.events.some(event => event.type === 'session-log-deepseek/delivery-accepted')).toBe(true)
  } else {
    expect(request.body).not.toHaveProperty('dsh_session_log')
    expect(request.body).not.toHaveProperty('dsh_plugin_packages')
    expect(result.events.some(event => event.type === 'session-log-deepseek/delivery-accepted')).toBe(false)
  }
  await harness.close()
  const audit = (await readFile(auditFile, 'utf8')).trim().split('\n').map(line => object(JSON.parse(line)))
  expect(audit.some(event => event.kind === 'installed')).toBe(true)
  expect(audit.filter(event => event.kind === 'blocked')).toEqual([])
}, 60_000)
