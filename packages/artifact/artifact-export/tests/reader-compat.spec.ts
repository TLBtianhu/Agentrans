/** Required export facts survive supported readers or stop restoration explicitly. */
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import {
  SessionFormatEventCollector, SessionFormatUnsupportedMigrationError, snapshotSessionFormatJson,
} from '@deepseek-ai/dsh-session-format'
import { releasedV4SessionFormatCodec, restoreReleasedV4Artifact } from '@deepseek-ai/dsh-session-format-v3-to-v4'

async function storedExport() {
  const record: unknown = JSON.parse(await readFile(new URL('./fixtures/export-record.json', import.meta.url), 'utf8'))
  const header = releasedV4SessionFormatCodec.encodeHeader({
    version: SESSION_FORMAT_VERSION, id: SessionId('export-reader'), createdAt: 0, isSeeded: false, delegationDepth: 0,
  }, 0)
  const decoder = releasedV4SessionFormatCodec.createDecoder(header, 'strict')
  const collector = new SessionFormatEventCollector()
  decoder.decodeRow(releasedV4SessionFormatCodec.encodeEvent({
    type: 'artifact/export', seq: 0, time: 0, data: snapshotSessionFormatJson(record),
  }), collector)
  return { record, artifact: { header: decoder.header, inheritedEventCount: decoder.finish(collector), events: collector.values } }
}

describe('fixed-source export reader compatibility', () => {
  it('refuses an unknown required export without changing its stored facts', async () => {
    const { artifact } = await storedExport()
    const before = JSON.stringify(artifact)
    expect(artifact.events[0]?.['ignorable']).toBeUndefined()
    expect(() => restoreReleasedV4Artifact(artifact, new Set(['artifact/upsert'])))
      .toThrow(SessionFormatUnsupportedMigrationError)
    expect(JSON.stringify(artifact)).toBe(before)
  })

  it('preserves complete original input and the immutable file reference', async () => {
    const { artifact, record } = await storedExport()
    expect(restoreReleasedV4Artifact(artifact, new Set(['artifact/export']))).toBe(artifact)
    expect(artifact.events[0]?.data).toEqual(record)
  })
})
