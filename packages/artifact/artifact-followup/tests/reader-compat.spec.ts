/** Existing user-message readers retain the exact context of an ordinary question. */
import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { SESSION_FORMAT_VERSION, SessionId } from '@agentrans/session'
import { SessionFormatEventCollector, snapshotSessionFormatJson } from '@agentrans/session-format'
import { releasedV4SessionFormatCodec, restoreReleasedV4Artifact } from '@agentrans/session-format-v3-to-v4'

const fixtures = ['question-message', 'program-state-message', 'program-error-message']

it.each(fixtures)('preserves %s through the released user-message reader', async (fixture) => {
  const message: unknown = JSON.parse(await readFile(new URL(`./fixtures/${fixture}.json`, import.meta.url), 'utf8'))
  const header = releasedV4SessionFormatCodec.encodeHeader({
    version: SESSION_FORMAT_VERSION, id: SessionId('question-session'), createdAt: 0, isSeeded: false, delegationDepth: 0,
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
