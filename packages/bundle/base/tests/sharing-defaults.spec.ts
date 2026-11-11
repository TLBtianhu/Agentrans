/** Shipped sharing defaults leave real model transports and local feedback available. */
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@agentrans/cordis'
import Loader, { type ModuleLoaderV2 } from '@agentrans/cordis-plugin-loader'
import Include from '@agentrans/cordis-plugin-include'
import { loadOverlayPatches } from '@agentrans/app-boot'
import LlmRuntime, { createAssistantMessage, createUserMessage } from '@agentrans/llm'
import SessionStore, { SessionId } from '@agentrans/session'
import AgentRegistry from '@agentrans/agent'
import SessionProjectionRegistry from '@agentrans/session-projection'
import DeepSeekExtensions from '@agentrans/deepseek-llm-api-extensions'
import * as DeepSeek from '@agentrans/llm-deepseek-api-key'
import * as PiAi from '@agentrans/llm-pi-ai'
import * as Persistence from '@agentrans/session-persistence-jsonl'
import * as Commands from '@agentrans/commands'
import * as Feedback from '@agentrans/command-feedback'
import MessageFeedback from '@agentrans/message-feedback'
import * as SessionLog from '@agentrans/session-log-deepseek'
import * as Inventory from '@agentrans/plugin-package-inventory-deepseek'
import SessionTelemetry from '@agentrans/session-telemetry-otel'
import OTel from '@agentrans/otel'
import ProductTelemetry from '@agentrans/host-product-telemetry-otel'
import ProductAnalytics from '@agentrans/client-product-analytics'

let root: string | undefined
let context: Context | undefined
let http: Server | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (http !== undefined) {
    const closed = once(http, 'close')
    http.close()
    http.closeAllConnections()
    await closed
    http = undefined
  }
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

function sourceLoader(modules: ReadonlyMap<string, unknown>): ModuleLoaderV2 {
  return {
    version: 'v2', loadCache: new Map(),
    async import(specifier) {
      if (!modules.has(specifier)) throw new Error(`Unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
    register(): never { throw new Error('Unexpected module hook registration') },
    getOrCreateModuleJob(): never { throw new Error('Unexpected module job creation') },
    resolveSync(): never { throw new Error('Unexpected synchronous module resolution') },
    load(): never { throw new Error('Unexpected module load') },
  }
}

const disabledIds = ['session-log-deepseek', 'plugin-package-inventory-deepseek', 'session-telemetry-otel',
  'desktop-product-telemetry', 'product-analytics', 'ui-settings-session-log']

it.each(['desktop', 'web'])('keeps %s model requests and local feedback independent of disabled sharing', async (profile) => {
  root = await mkdtemp(join(tmpdir(), 'agentrans-sharing-defaults-'))
  vi.stubEnv('DSH_HOME', root)
  vi.stubEnv('DEEPSEEK_API_KEY', 'local-deepseek-key')
  vi.stubEnv('LOCAL_PROVIDER_KEY', 'local-custom-key')
  vi.stubEnv('DSH_CLIENT_VERSION', 'local-test')
  vi.stubEnv('DSH_TELEMETRY_DISABLED', '')
  const requests: { path: string; body: unknown }[] = []
  http = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    request.on('end', () => {
      const path = request.url ?? ''
      const text = Buffer.concat(chunks).toString('utf8')
      requests.push({ path, body: text === '' ? undefined : JSON.parse(text) })
      if (path.endsWith('/messages')) {
        const frames = [
          { type: 'message_start', message: { id: 'local-message', type: 'message', role: 'assistant', model: 'local-model',
            content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Local answer.' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } },
          { type: 'message_stop' },
        ]
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end(frames.map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(''))
      } else if (path.endsWith('/chat/completions')) {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end([
          { choices: [{ index: 0, delta: { role: 'assistant', content: 'Local answer.' }, finish_reason: null }] },
          { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 2 } },
        ].map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n')
      } else { response.writeHead(200); response.end('{}') }
    })
  })
  http.listen(0, '127.0.0.1')
  await once(http, 'listening')
  const address = http.address()
  if (address === null || typeof address === 'string') throw new Error('Expected a loopback server')
  const origin = `http://127.0.0.1:${address.port}`
  const fetch = globalThis.fetch
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    if (url.origin !== origin) throw new Error(`Unexpected non-fixture HTTP request: ${url.origin}`)
    return fetch(input, init)
  })
  const modules = new Map<string, unknown>([
    ['@agentrans/llm', LlmRuntime], ['@agentrans/session', SessionStore],
    ['@agentrans/agent', AgentRegistry], ['@agentrans/session-projection', SessionProjectionRegistry],
    ['@agentrans/deepseek-llm-api-extensions', DeepSeekExtensions],
    ['@agentrans/llm-deepseek-api-key', DeepSeek], ['@agentrans/llm-pi-ai', PiAi],
    ['@agentrans/session-persistence-jsonl', Persistence], ['@agentrans/commands', Commands],
    ['@agentrans/command-feedback', Feedback], ['@agentrans/message-feedback', MessageFeedback],
    ['@agentrans/session-log-deepseek', SessionLog], ['@agentrans/plugin-package-inventory-deepseek', Inventory],
    ['@agentrans/session-telemetry-otel', SessionTelemetry], ['@agentrans/otel', OTel],
    ['@agentrans/host-product-telemetry-otel', ProductTelemetry], ['@agentrans/client-product-analytics', ProductAnalytics],
  ])
  const rows = [new URL('../cordis.patch.yml', import.meta.url), new URL('../../web-app/cordis.patch.yml', import.meta.url)]
    .flatMap(file => loadOverlayPatches('sharing-defaults', fileURLToPath(file)))
    .flatMap(patch => patch.insert ?? [])
    .filter(row => modules.has(row.name) || disabledIds.includes(row.id ?? ''))
    .map(row => ({ ...row,
      ...row.id === 'session-persistence-jsonl' ? { config: { root: join(root!, 'sessions'), compression: 'none' } } : {},
      ...row.id === 'llm-deepseek' ? { config: { baseURL: `${origin}/anthropic`, models: [{ id: 'local-model' }], thinking: 'disabled' } } : {},
      ...row.id === 'llm-pi-ai' ? { config: { providers: {
        'custom-provider': { api: 'openai-completions', baseURL: `${origin}/v1`, apiKeyEnv: 'LOCAL_PROVIDER_KEY', models: [{ id: 'local-model' }] },
      } } } : {},
      ...row.id === 'session-telemetry-otel' ? { config: { mode: 'FEEDBACK_ONLY', exporter: { url: `${origin}/collector` } } } : {},
      ...row.id === 'desktop-product-telemetry' ? { config: { ...row.config as Record<string, unknown>, endpoint: `${origin}/collector` } } : {},
    }))
  const config = join(root, 'cordis.yml')
  await writeFile(config, JSON.stringify(rows))
  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  ctx.provide('profileContext', { name: profile, dir: root, patchPath: join(root, 'cordis.patch.yml'),
    installAnchor: config, cwd: root, home: root, startedBundles: [], overlays: [], telemetryDisabledEnv: undefined })
  await ctx.plugin(Loader)
  ctx.loader.internal = sourceLoader(modules)
  ctx.loader.builtins.include = Include
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
  await ctx.loader.await()
  const entries = [...ctx.loader.entries()]
  for (const id of disabledIds) expect(entries.find(entry => entry.options.id === id)?.disabled, id).toBe(true)
  expect(entries.filter(entry => entry.fiber === undefined && !entry.disabled)).toEqual([])
  expect(ctx.get('sessionLogDeepSeek')).toBeUndefined()
  expect(ctx.get('sessionTelemetry')).toBeUndefined()
  expect(ctx.get('productTelemetry')).toBeUndefined()
  expect(ctx.get('productAnalytics')).toBeUndefined()
  const events: string[] = []
  ctx.on('session/event', (_session, event) => { events.push(event.type) })
  const session = ctx.sessions.create(SessionId(`sharing-${profile}`))
  const persistence = await ctx.sessionPersistence.create(session.header)
  try {
    const user = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Explain locally.' }] })
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('user/message', user, { surfaceOp: 'append' })
    for (const provider of ['deepseek-official', 'custom-provider']) {
      const chunks = []
      for await (const chunk of ctx.llm.stream({ provider, model: 'local-model', sessionId: session.id, messages: [user] })) chunks.push(chunk)
      expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
      expect(chunks.some(chunk => chunk.type === 'block-end' && chunk.block.type === 'text' && chunk.block.text === 'Local answer.')).toBe(true)
    }
    const assistant = createAssistantMessage({ source: { provider: 'custom-provider', model: 'local-model' },
      content: [{ type: 'text', text: 'Local answer.' }] })
    session.append('assistant/message', { message: assistant, stream: [], turn: 1, step: 1 }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    Feedback.recordFeedback(session, { text: 'Keep this feedback in the local Session.' })
    const result = await ctx.messageFeedback.put({ sessionId: session.id, messageId: assistant.id,
      rating: 'positive', ifVersion: null })
    if (!result.ok) throw new Error(result.error.code)
    expect((await ctx.messageFeedback.list({ sessionId: session.id }))).toMatchObject({ ok: true, value: { items: [result.value] } })
    expect(await ctx.messageFeedback.delete({ sessionId: session.id, messageId: assistant.id, ifVersion: result.value.version }))
      .toEqual({ ok: true, value: { absent: true } })
    expect(events).toContain('feedback/record')
    expect(events).toContain('feedback/message-put')
    expect(events).toContain('feedback/message-delete')
    expect(events).not.toContain('session-log-deepseek/delivery-accepted')
    const saved = await persistence.read()
    expect(saved.events.map(event => event.type).filter(type => type.startsWith('feedback/')))
      .toEqual(['feedback/record', 'feedback/message-put', 'feedback/message-delete'])
  } finally { await persistence.close() }
  await ctx.fiber.dispose()
  context = undefined
  expect(requests.map(request => request.path)).toEqual(['/anthropic/v1/messages', '/v1/chat/completions'])
  for (const request of requests) {
    expect(request.body).not.toHaveProperty('dsh_session_log')
    expect(request.body).not.toHaveProperty('dsh_plugin_packages')
  }
})
