/** Released readers preserve evidence text without knowing the Artifact producer. */
import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import { SessionFormatEventCollector, snapshotSessionFormatJson } from '@deepseek-ai/dsh-session-format'
import { releasedV4SessionFormatCodec, restoreReleasedV4Artifact } from '@deepseek-ai/dsh-session-format-v3-to-v4'

it('retains both conclusion and complete evidence through a released reader that knows only user messages', async () => {
  const message: unknown = JSON.parse(await readFile(new URL('./fixtures/returned-message.json', import.meta.url), 'utf8'))
  const header = releasedV4SessionFormatCodec.encodeHeader({
    version: SESSION_FORMAT_VERSION, id: SessionId('evidence-parent'), createdAt: 0, isSeeded: false, delegationDepth: 0,
  }, 0)
  const decoder = releasedV4SessionFormatCodec.createDecoder(header, 'strict')
  const collector = new SessionFormatEventCollector()
  decoder.decodeRow(releasedV4SessionFormatCodec.encodeEvent({
    type: 'user/message', seq: 0, time: 0, surfaceOp: 'append', data: snapshotSessionFormatJson(message),
  }), collector)
  const artifact = { header: decoder.header, inheritedEventCount: decoder.finish(collector), events: collector.values }
  expect(restoreReleasedV4Artifact(artifact, new Set(['user/message']))).toBe(artifact)
  expect(artifact.events[0]?.data).toEqual(message)
})
