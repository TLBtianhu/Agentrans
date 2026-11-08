/** Follow-up context stays attached to its question in raw SDK history. */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { createProcessDeepSeekHarness } from '../src/api.ts'

const fakeRuntime = fileURLToPath(new URL('./fake-runtime.ts', import.meta.url))
const fixtures = ['question-message', 'program-state-message', 'program-error-message']

it.each(fixtures)('preserves %s as ordinary text with its original attribution', async (name) => {
  const fixture = new URL(`../../../artifact/artifact-followup/tests/fixtures/${name}.json`, import.meta.url)
  const message: unknown = JSON.parse(await readFile(fixture, 'utf8'))
  const finalResponse = 'The main SDK response remains unchanged.'
  const harness = createProcessDeepSeekHarness({ command: process.execPath, args: [fakeRuntime],
    environment: () => ({ ...process.env, FAKE_TEXT: finalResponse,
      FAKE_SESSION_EVENTS: JSON.stringify([{ type: 'user/message', surfaceOp: 'append', data: message }]) }),
    description: `scripted ${name} context`, initializeTimeoutMs: 5000 })
  try {
    const result = await harness.run([{ type: 'text', text: 'Continue explaining' }])
    const questions = result.events.filter(event => event.type === 'user/message')
    expect(questions).toHaveLength(1)
    expect(questions[0]?.data).toEqual(message)
    const notifications = result.notifications.filter(item => item.method === 'session.event').map((item) => {
      if (item.method !== 'session.event') throw new Error('Expected Session notification')
      return item.params.event
    })
    expect(notifications).toContainEqual(questions[0])
    expect(result.finalResponse).toBe(finalResponse)
    expect(result.events.filter(event => event.type === 'assistant/message')
      .flatMap(event => event.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : [])))
      .toEqual([finalResponse])
  } finally { await harness.close() }
})
