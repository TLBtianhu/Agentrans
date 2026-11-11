/** The SDK preserves saved observations as raw log facts without changing assistant output. */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { expect, it, vi } from 'vitest'
import { Context } from '@agentrans/cordis'
import SessionStore, { SessionId, type SessionEvent } from '@agentrans/session'
import { createUserMessage } from '@agentrans/llm'
import type { ArtifactId, ArtifactObservationId, SceneArtifactSnapshot } from '@agentrans/artifact/types'
import { advanceParticleState, createParticleCheckpoint, createParticleState, observeParticleState } from '@agentrans/artifact/particle-runtime'
import { createProcessDeepSeekHarness } from '../src/api.ts'

const expectedPath = fileURLToPath(new URL('./expected/artifact-observation-projection.json', import.meta.url))
const fakeRuntime = fileURLToPath(new URL('./fake-runtime.ts', import.meta.url))
type ObservationEvent = SessionEvent<'artifact/observations'>

function isObservationEvent(value: unknown): value is ObservationEvent {
  return typeof value === 'object' && value !== null && 'type' in value && value.type === 'artifact/observations'
}

it('preserves a saved source revision and checkpoint in SDK events and notifications', async () => {
  const expected = JSON.parse(await readFile(expectedPath, 'utf8')) as {
    finalResponse: string
    observationEvents: ObservationEvent[]
  }
  const ctx = new Context()
  const clock = vi.spyOn(Date, 'now').mockReturnValue(0)
  let saved: ObservationEvent
  try {
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('sdk-observation'))
    const artifact: SceneArtifactSnapshot = {
      artifactId: 'experiment' as ArtifactId, revision: 1, format: 'scene', title: 'Experiment', presentation: 'inline',
      spec: { kind: 'particle-system', particles: [{ id: 'p', x: 0, y: 1, vx: 1, vy: 0, mass: 1 }],
        gravity: { x: 0, y: -10 }, timeStep: 0.1, trails: false },
    }
    if (artifact.spec.kind !== 'particle-system') throw new Error('Expected particle source')
    const state = advanceParticleState(artifact.spec, createParticleState(artifact.spec), 2)
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({ source: { kind: 'user' },
      content: [{ type: 'text', text: 'Inspect the experiment' }] }), { surfaceOp: 'append' })
    session.append('artifact/upsert', artifact)
    saved = session.append('artifact/observations', { artifactId: artifact.artifactId, observations: [{
      observationId: 'saved-a' as ArtifactObservationId, label: 'A', artifact,
      checkpoint: createParticleCheckpoint(state), values: observeParticleState(state),
    }] })
    expect(saved).toEqual(expected.observationEvents[0])
  } finally {
    clock.mockRestore()
    await ctx.fiber.dispose()
  }
  const harness = createProcessDeepSeekHarness({ command: process.execPath, args: [fakeRuntime],
    environment: () => ({ ...process.env, FAKE_TEXT: expected.finalResponse, FAKE_SESSION_EVENTS: JSON.stringify([saved]) }),
    description: 'scripted observation projection', initializeTimeoutMs: 5000 })
  try {
    const result = await harness.run([{ type: 'text', text: 'Continue explaining' }])
    const projection = {
      finalResponse: result.finalResponse,
      observationEvents: result.events.filter(event => event.type === 'artifact/observations'),
      observationNotifications: result.notifications.filter(notification => notification.method === 'session.event'
        && isObservationEvent(notification.params.event)).map((notification) => {
        if (notification.method !== 'session.event') throw new Error('Expected Session event notification')
        expect(notification.params.sessionId).toBe(result.sessionId)
        return { method: notification.method, event: notification.params.event }
      }),
      assistantTexts: result.events.filter(event => event.type === 'assistant/message')
        .flatMap(event => event.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : [])),
    }
    expect(projection).toEqual(JSON.parse(await readFile(expectedPath, 'utf8')))
  } finally { await harness.close() }
})
