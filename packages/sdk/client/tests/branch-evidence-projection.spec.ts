/** Returned evidence remains complete user history without changing the SDK response. */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { createProcessDeepSeekHarness } from '../src/api.ts'

const fakeRuntime = fileURLToPath(new URL('./fake-runtime.ts', import.meta.url))
const fixture = new URL('../../../artifact/artifact-branch/tests/fixtures/returned-message.json', import.meta.url)

it('preserves the conclusion and second evidence block in SDK events and notifications', async () => {
  const message: unknown = JSON.parse(await readFile(fixture, 'utf8'))
  const finalResponse = 'The main SDK response remains unchanged.'
  const harness = createProcessDeepSeekHarness({ command: process.execPath, args: [fakeRuntime],
    environment: () => ({ ...process.env, FAKE_TEXT: finalResponse,
      FAKE_SESSION_EVENTS: JSON.stringify([{ type: 'user/message', surfaceOp: 'append', data: message }]) }),
    description: 'scripted branch evidence', initializeTimeoutMs: 5000 })
  try {
    const result = await harness.run([{ type: 'text', text: 'Continue explaining' }])
    const returned = result.events.filter(event => event.type === 'user/message')
    expect(returned).toHaveLength(1)
    expect(returned[0]?.data).toEqual(message)
    const notifications = result.notifications.filter(item => item.method === 'session.event').map((item) => {
      if (item.method !== 'session.event') throw new Error('Expected Session notification')
      return item.params.event
    })
    expect(notifications).toContainEqual(returned[0])
    expect(result.finalResponse).toBe(finalResponse)
    expect(result.events.filter(event => event.type === 'assistant/message')
      .flatMap(event => event.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : [])))
      .toEqual([finalResponse])
  } finally { await harness.close() }
})
