/** The shipped ACP profile reserves stdout for JSON-RPC during model and MCP requests. */
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { startMockLlmServer } from '@agentrans/llm-mock-server'
import { launchAcpTestAgent, type LaunchedAcpTestAgent } from '@agentrans/session-snapshot'
import { expect, it } from 'vitest'
import { cleanupAcpExampleTest } from './cleanup.ts'

const repoRoot = fileURLToPath(new URL('../../../../../../', import.meta.url))
const binScript = join(repoRoot, 'apps/cli/src/bin.ts')
const tsconfigPath = join(repoRoot, 'tsconfig.json')
const networkGuard = new URL('../../../../../../packages/test-support/session-snapshot/tests/fixtures/replay-network-guard.mjs', import.meta.url)

/** Parse every stdout line as a JSON-RPC frame; a diagnostic line fails the parse with its leading text. */
function jsonRpcFrames(launched: LaunchedAcpTestAgent): Record<string, unknown>[] {
  const frames = launched.rawStdout().trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
  for (const frame of frames) expect(frame).toMatchObject({ jsonrpc: '2.0' })
  return frames
}

it('keeps stdout JSON-RPC only during an API-key turn on the default ACP profile', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-acp-stdout-'))
  const apiKey = 'acp-fixture-api-key'
  const model = 'deepseek-v4-flash'
  const answer = 'ACP loopback answer.'
  let llm: Awaited<ReturnType<typeof startMockLlmServer>> | undefined
  let launched: LaunchedAcpTestAgent | undefined
  try {
    llm = await startMockLlmServer({ apiKey, sequence: ['success'], successText: answer })
    const configPath = join(cwd, 'empty.patch.yml')
    const auditPath = join(cwd, 'network-audit.jsonl')
    await writeFile(configPath, '[]\n')
    launched = launchAcpTestAgent({
      agent: { binScript, configPath, profile: 'acp', tsconfigPath },
      cwd,
      env: {
        DEEPSEEK_API_KEY: apiKey,
        DEEPSEEK_BASE_URL: llm.baseURL,
        AGENTRANS_TELEMETRY_DISABLED: '1',
        NODE_OPTIONS: `--import=${networkGuard.href}`,
        AGENTRANS_SNAPSHOT_NETWORK_AUDIT_FILE: auditPath,
      },
    })
    await launched.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const created = await launched.client.newSession({ cwd, mcpServers: [] })
    expect(created.configOptions).toContainEqual(expect.objectContaining({
      id: 'model',
      currentValue: JSON.stringify(['deepseek-official', model]),
      options: [expect.objectContaining({ group: 'deepseek-official' })],
    }))
    expect(llm.requests).toHaveLength(0)
    await expect(launched.client.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: 'Reply using the loopback endpoint.' }],
    })).resolves.toEqual({ stopReason: 'end_turn' })
    await launched.client.closeSession({ sessionId: created.sessionId })
    await launched.close()

    expect(launched.child.signalCode).toBeNull()
    expect(launched.child.exitCode).toBe(0)
    const text = launched.updates.flatMap(update =>
      update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text' ? [update.content.text] : [])
    expect(text.join('')).toBe(answer)
    expect(jsonRpcFrames(launched).length).toBeGreaterThanOrEqual(5)
    expect(launched.rawStdout()).not.toContain(apiKey)
    expect(launched.stderr()).not.toContain(apiKey)
    expect(llm.requests).toMatchObject([{
      path: '/v1/messages', body: { model }, headers: { 'x-api-key': apiKey },
    }])
    expect(llm.requests[0]?.headers['x-dsh-auth-token']).toBeUndefined()
    const audit = (await readFile(auditPath, 'utf8')).trim().split('\n').map((line): unknown => JSON.parse(line))
    expect(audit).toContainEqual({ kind: 'installed', pid: launched.child.pid })
    expect(audit).not.toContainEqual(expect.objectContaining({ kind: 'blocked' }))
  } finally {
    const cleanup = await Promise.allSettled([cleanupAcpExampleTest(launched, cwd), llm?.close()])
    const failures: unknown[] = []
    for (const result of cleanup) if (result.status === 'rejected') failures.push(result.reason)
    if (failures.length > 0) throw new AggregateError(failures, 'ACP API-key test cleanup failed')
  }
})

it('keeps MCP resource-listing diagnostics off stdout for a tools-only client server', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-acp-stdout-'))
  const llm = await startMockLlmServer({
    sequence: ['tool_call_success', 'success'],
    toolName: 'list_mcp_resources',
    toolArguments: JSON.stringify({ server: 'fixture' }),
  })
  let launched: LaunchedAcpTestAgent | undefined
  try {
    const configPath = join(cwd, 'mcp.patch.yml')
    await writeFile(configPath, JSON.stringify([
      { id: 'llm-deepseek', config: { baseURL: llm.baseURL, models: [{ id: 'fixture-api-key-model' }] } },
      { id: 'acp', config: { provider: 'deepseek-official', model: 'fixture-api-key-model' } },
      { id: 'session-persistence-jsonl', config: { root: join(cwd, 'sessions'), compression: 'none' } },
    ]) + '\n')
    launched = launchAcpTestAgent({
      agent: { binScript, configPath, profile: 'acp', tsconfigPath },
      cwd,
      env: { DEEPSEEK_API_KEY: 'acp-fixture-api-key', DEEPSEEK_BASE_URL: llm.baseURL, AGENTRANS_TELEMETRY_DISABLED: '1' },
    })
    await launched.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    // The fixture server advertises only the tools capability.
    const mcpServer = join(repoRoot, 'packages/mcp/mcp-client/tests/fixture-server.ts')
    const created = await launched.client.newSession({
      cwd, mcpServers: [{ name: 'fixture', command: process.execPath, args: [mcpServer], env: [] }],
    })
    await expect(launched.client.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: 'list the fixture resources' }],
    })).resolves.toEqual({ stopReason: 'end_turn' })
    expect(launched.updates).toContainEqual(expect.objectContaining({ sessionUpdate: 'tool_call_update', status: 'completed' }))
    await launched.client.closeSession({ sessionId: created.sessionId })
    await launched.close()

    expect(launched.child.exitCode).toBe(0)
    expect(llm.requests.map(request => request.behavior)).toEqual(['tool_call_success', 'success'])
    expect(jsonRpcFrames(launched).length).toBeGreaterThanOrEqual(5)
  } finally {
    const cleanup = await Promise.allSettled([cleanupAcpExampleTest(launched, cwd), llm.close()])
    const failures: unknown[] = []
    for (const result of cleanup) if (result.status === 'rejected') failures.push(result.reason)
    if (failures.length > 0) throw new AggregateError(failures, 'ACP MCP test cleanup failed')
  }
})
