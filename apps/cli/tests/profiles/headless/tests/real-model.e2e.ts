import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { runLoaderSmoke } from '@agentrans/loader-smoke'

const binScript = fileURLToPath(new URL('../../../../../../packages/test-support/loader-smoke/tests/fixtures/headless-driver.ts', import.meta.url))
const configPath = fileURLToPath(new URL('../real-model.patch.yml', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../../../../tsconfig.json', import.meta.url))
const hasKey = Boolean(process.env.DEEPSEEK_API_KEY)

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('headless real-model driver returned a non-object record')
  }
  return value as Record<string, unknown>
}

describe.skipIf(!hasKey)('headless-agent with real model', () => {
  it('modifies a temporary workspace and verifies the file outside the agent', async () => {
    let verified = ''
    const { stdout } = await runLoaderSmoke({
      label: 'headless-agent real model',
      tempDirPrefix: 'headless-agent-real-',
      binScript,
      libBinScript: binScript,
      configPath,
      binArgs: [
        configPath,
        'Read task.txt, replace its complete contents with exactly "value=after" followed by a newline, read it again, and report briefly.',
      ],
      tsconfigPath,
      processTimeoutMs: 120_000,
      prepare: cwd => writeFile(join(cwd, 'task.txt'), 'value=before\n'),
      inspect: async (cwd) => { verified = await readFile(join(cwd, 'task.txt'), 'utf8') },
    })
    expect(verified).toBe('value=after\n')
    const rows = stdout.split(/\r?\n/u).filter(line => line.trim() !== '').map(line => object(JSON.parse(line)))
    const result = rows.findLast(row => row.type === 'result')
    if (result === undefined || typeof result.sessionId !== 'string') throw new Error('headless real-model driver returned no Session result')
    const events = rows.filter(row => row.type === 'session_event' && row.sessionId === result.sessionId)
      .map(row => object(row.event))
    const reasons = events.filter(event => event.type === 'turn/end').map(event => object(event.data).reason)
    expect(reasons.length).toBeGreaterThan(0)
    for (const reason of reasons) expect(reason).toMatchObject({ kind: 'completed' })
    const assistant = events.findLast(event => event.type === 'assistant/message')
    if (assistant === undefined) throw new Error('headless real-model turn returned no assistant message')
    const content = object(object(assistant.data).message).content
    if (!Array.isArray(content)) throw new Error('headless real-model assistant message returned no content')
    const text = content.flatMap((block) => {
      const value = object(block)
      return value.type === 'text' && typeof value.text === 'string' ? [value.text] : []
    }).join('')
    expect(text.trim().length).toBeGreaterThan(0)
    expect(result.output).toBe(text)
  }, 135_000)
})
