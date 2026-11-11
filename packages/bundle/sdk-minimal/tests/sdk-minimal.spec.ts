/** The standalone SDK-minimal bundle's complete declared Cordis tree. */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'
import { entryListSchema } from '@agentrans/cordis-plugin-include'

function packageName(specifier: string): string {
  return specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]!
}

describe('dsh-sdk-minimal bundle', () => {
  it('declares one standalone allowlisted tree with every row dependency', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
      dsh?: { bundle?: { patch?: string } }
    }
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    const patches = yaml.load(
      readFileSync(resolve(root, manifest.dsh!.bundle!.patch!), 'utf8'),
      { schema: entryListSchema },
    ) as Array<{ insert?: Array<{ id?: string; inject?: string[]; name?: string; config?: Record<string, unknown>; disabled?: unknown }> }>
    expect(patches).toHaveLength(1)
    const rows = patches[0]?.insert ?? []
    expect(rows.map(row => [row.id, row.name])).toEqual([
      ['sdk-app-startup', '@agentrans/sdk-app'],
      ['sdk-jsonrpc-server', '@agentrans/sdk-jsonrpc-server'],
      ['deepseek-llm-api-extensions', '@agentrans/deepseek-llm-api-extensions'],
      ['session-log-deepseek', '@agentrans/session-log-deepseek'],
      ['plugin-package-inventory-deepseek', '@agentrans/plugin-package-inventory-deepseek'],
      ['llm-deepseek', '@agentrans/llm-deepseek-api-key'],
      ['sandbox', '@agentrans/sandbox-local'],
      ['filesystem', '@agentrans/fs-local'],
      ['attachment-local', '@agentrans/attachment-local'],
      ['tool-fs', '@agentrans/tool-fs'],
      ['working-directory', '@agentrans/working-directory'],
      ['tool-working-directory', '@agentrans/tool-working-directory'],
      ['session-projection', '@agentrans/session-projection'],
      ['token-meter', '@agentrans/token-meter'],
      ['compaction-basic', '@agentrans/compaction-basic'],
      ['image-offload', '@agentrans/compaction-image-offload'],
      ['sandbox-policy', '@agentrans/sandbox-policy'],
      ['subprocess', '@agentrans/subprocess-local'],
      ['pty', '@agentrans/terminal'],
      ['terminal-bash', '@agentrans/terminal-bash'],
      ['terminal-pwsh', '@agentrans/terminal-bash'],
      ['timer', '@agentrans/cordis-plugin-timer'],
      ['llm', '@agentrans/llm'],
      ['session', '@agentrans/session'],
      ['session-title', '@agentrans/session-title'],
      ['system-prompt', '@agentrans/system-prompt'],
      ['tools', '@agentrans/tools'],
      ['tool-executor-native', '@agentrans/tool-executor-native'],
      ['mcp-resources', '@agentrans/mcp-resources'],
      ['agent', '@agentrans/agent'],
      ['llm-retry', '@agentrans/llm-retry'],
      ['jobs', '@agentrans/jobs-local'],
      ['agent-loop', '@agentrans/agent-loop'],
      ['persistent-bash', '@agentrans/tool-bash-persistent'],
      ['persistent-pwsh', '@agentrans/tool-pwsh-persistent'],
      ['sessions', '@agentrans/session-persistence-jsonl'],
      ['session-checkpoint-policy', '@agentrans/session-checkpoint-policy'],
    ])
    expect(rows.find(row => row.id === 'sdk-app-startup')?.config).toEqual({ profile: 'sdk-minimal' })
    expect(rows.find(row => row.id === 'sdk-jsonrpc-server')).toMatchObject({
      inject: ['sdkAppStartup', 'loader'],
      config: { maxTokensAsSuccess: false },
    })
    for (const id of ['session-log-deepseek', 'plugin-package-inventory-deepseek']) {
      expect(rows.find(row => row.id === id)?.disabled, id).toBe(true)
    }
    expect(rows.find(row => row.id === 'deepseek-llm-api-extensions')?.disabled).toBeUndefined()
    expect(rows.find(row => row.id === 'llm-deepseek')?.disabled).toBeUndefined()
    expect(rows.find(row => row.id === 'llm-deepseek')?.config).toEqual({
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      defaultContextWindow: { __jsExpr: 'Number(process.env.AGENTRANS_CONTEXT_WINDOW ?? 1000000)' },
      streamIdleTimeoutMs: 172800000,
    })
    expect(rows.find(row => row.id === 'system-prompt')?.config).toEqual({
      includeHarnessIdentity: false,
      includeRuntimeContext: false,
      personaPrefix: { __jsExpr: "process.env.AGENTRANS_SYSTEM_PROMPT ?? 'You are a helpful software engineer assistant.'" },
    })
    expect(rows.find(row => row.id === 'agent-loop')?.config).toEqual({ agents: [] })
    expect(rows.find(row => row.id === 'tool-fs')?.config).toEqual({ read: false, readImage: true, write: false, edit: false })
    expect(rows.find(row => row.id === 'compaction-basic')?.config).toBeUndefined()
    expect(rows.find(row => row.id === 'terminal-bash')).toMatchObject({
      disabled: { __jsExpr: "process.platform === 'win32'" },
    })
    expect(rows.find(row => row.id === 'terminal-pwsh')).toMatchObject({
      disabled: { __jsExpr: "process.platform !== 'win32'" },
      config: { shellDialect: 'pwsh', timeoutMs: 300000 },
    })
    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual(
      [...new Set(rows.map(row => row.name).filter((name): name is string => name !== undefined).map(packageName))].sort(),
    )
  })
})
