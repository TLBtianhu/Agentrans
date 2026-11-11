/** User-declared model endpoint and the absence of DeepSeek account channels. */
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AgentHandle } from '@agentrans/agent'
import { createUserMessage } from '@agentrans/llm'
import { SessionId } from '@agentrans/session'
import { launchWebScaffold, webSnapshotMode, type WebScaffold } from './scaffold.ts'

const MODE = webSnapshotMode()

describe.skipIf(MODE !== 'record')('web e2e: user-declared model provider', () => {
  let scaffold: WebScaffold
  let server: Server
  let agentHandle: AgentHandle
  let overlayRoot: string

  beforeAll(async () => {
    server = createServer((request, response) => {
      if (request.method === 'POST' && request.url === '/v1/chat/completions') {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.write(`data: ${JSON.stringify({
          id: 'chatcmpl-custom', object: 'chat.completion.chunk', created: 1, model: 'user-model',
          choices: [{ index: 0, delta: { role: 'assistant', content: 'Custom endpoint works.' }, finish_reason: null }],
        })}\n\n`)
        response.write(`data: ${JSON.stringify({
          id: 'chatcmpl-custom', object: 'chat.completion.chunk', created: 1, model: 'user-model',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        })}\n\n`)
        response.end('data: [DONE]\n\n')
        return
      }
      if (request.method === 'GET' && request.url === '/v1/models') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ object: 'list', data: [{ id: 'user-model', object: 'model', created: 1, owned_by: 'custom' }] }))
        return
      }
      response.writeHead(404).end()
    })
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => { resolve() }) })
    const address = server.address() as AddressInfo
    overlayRoot = await mkdtemp(join(tmpdir(), 'agentrans-custom-provider-'))
    const overlay = join(overlayRoot, 'custom-provider.overlay.yml')
    await writeFile(overlay, `- id: llm-pi-ai
  config:
    providers:
      custom-provider:
        displayName: Custom Provider
        apiKeyEnv: AGENTRANS_TEST_CUSTOM_KEY
        api: openai-completions
        baseURL: http://127.0.0.1:${address.port}/v1
        models:
          - id: user-model
            name: User Model
            contextWindow: 8192
            maxTokens: 1024
            input: [text]
`, 'utf8')
    process.env.AGENTRANS_TEST_CUSTOM_KEY = 'local-test-key'
    scaffold = await launchWebScaffold({ extraOverlayPath: overlay })
    agentHandle = await scaffold.ctx.agents.create({
      sessionId: SessionId('custom-provider-smoke'),
      meta: { cwd: scaffold.workspaceCwd },
      agentOptions: { provider: 'custom-provider', model: 'user-model' },
      setup: async (agentCtx) => { await scaffold.ctx.agentPresets.mount(agentCtx) },
    })
    agentHandle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Say hello.' }], source: { kind: 'user' },
    }))
    await agentHandle.agent.whenIdle()
  })

  afterAll(async () => {
    await agentHandle?.dispose()
    await scaffold?.close()
    if (server !== undefined) await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    if (overlayRoot !== undefined) await rm(overlayRoot, { recursive: true, force: true })
    delete process.env.AGENTRANS_TEST_CUSTOM_KEY
  })

  it('uses the configured URL and protocol without an upstream model update or account channel', async () => {
    const session = agentHandle.agent.session
    expect(session.requestHeader()?.config).toMatchObject({ provider: 'custom-provider', model: 'user-model' })
    const assistants = session.snapshotEvents().flatMap(event => event.type === 'assistant/message' ? [event.data.message] : [])
    expect(assistants.at(-1)?.content).toEqual([{ type: 'text', text: 'Custom endpoint works.' }])
    expect(scaffold.ctx.llm.listConfigurableProviders().map(provider => provider.provider)).toContain('custom-provider')
    const entries = [...scaffold.ctx.loader.entries()].map(entry => entry.options.id)
    expect(entries).not.toContain('deepseek-account')
    expect(entries).not.toContain('llm-deepseek-account')
    expect(entries).not.toContain('web-deepseek-api')
  })
})
