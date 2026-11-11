/** Required saved-observation facts must survive readers or stop restoration explicitly. */
import { describe, expect, it } from 'vitest'
import { brandString } from '@agentrans/brand'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@agentrans/session'
import {
  SessionFormatEventCollector, SessionFormatUnsupportedMigrationError, snapshotSessionFormatJson,
  type SessionFormatArtifact, type SessionFormatEvent,
} from '@agentrans/session-format'
import { releasedV4SessionFormatCodec, restoreReleasedV4Artifact } from '@agentrans/session-format-v3-to-v4'
import {
  advanceParticleState, createParticleCheckpoint, createParticleState, observeParticleState,
} from '../src/particle-runtime.ts'
import type { ArtifactId, ArtifactObservationId, SavedParticleObservation, SceneArtifactSnapshot } from '../src/types.ts'

function persistedObservationArtifact(): SessionFormatArtifact {
  const id = SessionId('saved-observation-reader')
  const session = Session.create(id, undefined, {
    version: SESSION_FORMAT_VERSION, id, createdAt: 1, isSeeded: false, delegationDepth: 0,
  })
  const artifact: SceneArtifactSnapshot = {
    artifactId: brandString<ArtifactId>('projectiles'), revision: 1, format: 'scene', title: 'Original source', presentation: 'inline',
    spec: {
      kind: 'particle-system', particles: [{ id: 'alpha', x: 1, y: 1, vx: 3, vy: 8, mass: 1 }],
      gravity: { x: 0, y: -9.8 }, timeStep: 1 / 30, trails: true,
    },
  }
  if (artifact.spec.kind !== 'particle-system') throw new Error('Particle source required')
  const state = advanceParticleState(artifact.spec, createParticleState(artifact.spec), 6)
  const observation: SavedParticleObservation = {
    observationId: brandString<ArtifactObservationId>('00000000-0000-4000-8000-000000000001'),
    label: 'A', artifact, checkpoint: createParticleCheckpoint(state), values: observeParticleState(state),
  }
  session.append('artifact/upsert', artifact)
  session.append('artifact/observations', { artifactId: artifact.artifactId, observations: [observation] })
  const events: SessionFormatEvent[] = session.snapshotEvents().map(({ type, seq, time, data }) => ({
    type, seq, time, data: snapshotSessionFormatJson(data),
  }))
  const header = session.header
  if (header.delegationDepth === undefined) throw new Error('The compatibility fixture requires explicit root depth')
  const physicalHeader = releasedV4SessionFormatCodec.encodeHeader({
    version: header.version, id: header.id, createdAt: header.createdAt,
    isSeeded: header.isSeeded, delegationDepth: header.delegationDepth,
  }, session.inheritedEventCount)
  const decoder = releasedV4SessionFormatCodec.createDecoder(physicalHeader, 'strict')
  const collector = new SessionFormatEventCollector()
  for (const event of events) decoder.decodeRow(releasedV4SessionFormatCodec.encodeEvent(event), collector)
  return { header: decoder.header, inheritedEventCount: decoder.finish(collector), events: collector.values }
}

describe('saved observation reader compatibility', () => {
  it('refuses a stored required observation when the installed reader does not know its event type', () => {
    const artifact = persistedObservationArtifact()
    const before = JSON.stringify(artifact)
    expect(artifact.events[1]?.['ignorable']).toBeUndefined()
    expect(() => restoreReleasedV4Artifact(artifact, new Set(['artifact/upsert'])))
      .toThrow(SessionFormatUnsupportedMigrationError)
    expect(JSON.stringify(artifact)).toBe(before)
  })

  it('keeps the complete original source, checkpoint, and observation when the reader knows the new fact', () => {
    const artifact = persistedObservationArtifact()
    const result = restoreReleasedV4Artifact(artifact, new Set(['artifact/upsert', 'artifact/observations']))
    expect(result).toBe(artifact)
    expect(result.events[1]?.data).toMatchObject({
      artifactId: 'projectiles', observations: [{
        label: 'A', artifact: { revision: 1, spec: { gravity: { y: -9.8 } } },
        checkpoint: { runtimeVersion: 1, stepCount: 6 },
        values: { time: 0.2, particles: [{ id: 'alpha', x: 1.6, vy: 6.04 }] },
      }],
    })
  })
})
