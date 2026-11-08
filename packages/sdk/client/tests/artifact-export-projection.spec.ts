/** Stored export facts remain complete raw SDK history without altering assistant output. */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { createProcessDeepSeekHarness } from '../src/api.ts'

const fakeRuntime = fileURLToPath(new URL('./fake-runtime.ts', import.meta.url))
const fixture = new URL('../../../artifact/artifact-export/tests/fixtures/export-record.json', import.meta.url)

it('preserves frozen source, replay conditions, status and file identity in events and notifications', async () => {
  const record: unknown = JSON.parse(await readFile(fixture, 'utf8'))
  const finalResponse = 'The main SDK response remains unchanged.'
  const harness = createProcessDeepSeekHarness({ command: process.execPath, args: [fakeRuntime],
    environment: () => ({ ...process.env, FAKE_TEXT: finalResponse,
      FAKE_SESSION_EVENTS: JSON.stringify([{ type: 'artifact/export', data: record }]) }),
    description: 'scripted Artifact export', initializeTimeoutMs: 5000 })
  try {
    const result = await harness.run([{ type: 'text', text: 'Continue explaining' }])
    const exports = result.events.filter(event => event.type === 'artifact/export')
    expect(exports).toHaveLength(1)
    expect(exports[0]?.data).toEqual(record)
    const notifications = result.notifications.filter(item => item.method === 'session.event').map((item) => {
      if (item.method !== 'session.event') throw new Error('Expected Session notification')
      return item.params.event
    })
    expect(notifications).toContainEqual(exports[0])
    expect(result.finalResponse).toBe(finalResponse)
    expect(result.events.filter(event => event.type === 'assistant/message')
      .flatMap(event => event.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : [])))
      .toEqual([finalResponse])
  } finally { await harness.close() }
})
