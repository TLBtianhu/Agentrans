import { describe, expect, it } from 'vitest'
import type { ChatNode } from '@agentrans/client-ui-chat/client'
import { MessageId } from '@agentrans/llm/brand'
import type { SessionEventLikeEntry } from '@agentrans/api-session-controller/client'
import { SessionSeq } from '@agentrans/session'
import { ConversationNodeAssembler } from '../../ui-conversation/src/client/conversation/assembler.ts'
import { artifactDefinition, type ReviewableSceneRevision } from '../src/client/definition.ts'
import type { ArtifactId, ArtifactSnapshot } from '../src/client/protocol.ts'

function snapshot(artifactId: string, revision: number, title = `Artifact ${revision}`): ArtifactSnapshot {
  return { artifactId: artifactId as ArtifactId, revision, format: 'html', title, source: `<h1>${title}</h1>`, presentation: 'inline' }
}

function upsert(seq: number, artifactId: string, revision: number, data = snapshot(artifactId, revision)): SessionEventLikeEntry {
  return { type: 'event', event: {
    type: 'artifact/upsert', seq: SessionSeq(seq), time: seq * 1000, data,
  } }
}

function particle(revision: number): ReviewableSceneRevision {
  return { artifactId: 'particle' as ArtifactId, revision, format: 'scene', title: 'Particles', presentation: 'inline', spec: {
    kind: 'particle-system', timeStep: 0.02, trails: false, gravity: { x: 0, y: -9.8 },
    particles: [{ id: 'a', x: 0, y: 0, vx: revision, vy: 0, mass: 1 }],
  } }
}

function plot(revision: number): ReviewableSceneRevision {
  return { artifactId: 'plot' as ArtifactId, revision, format: 'scene', title: 'Function plot', presentation: 'inline', spec: {
    kind: 'function-plot', functions: [{ id: 'f', label: 'Curve', expression: 'a*x' }],
    parameters: { a: { value: revision, min: 0, max: 4, step: 1 } },
    viewport: { x: [-4, 4], y: [-8, 8] }, trace: { x: 1, derivative: true, integral: false },
  } }
}

function turnStart(seq: number, turn: number): SessionEventLikeEntry {
  return { type: 'event', event: { type: 'turn/start', seq: SessionSeq(seq), time: seq * 1000, data: { turn } } }
}

function unrelated(seq: number): SessionEventLikeEntry {
  return { type: 'event', event: {
    type: 'user/message', seq: SessionSeq(seq), time: seq * 1000,
    data: { id: MessageId(`message-${seq}`), role: 'user', source: { kind: 'user' }, content: [] }, surfaceOp: 'append',
  } }
}

function harness() {
  let nodes: readonly ChatNode<'artifact'>[] = []
  const assembler = new ConversationNodeAssembler(
    { entries: () => [artifactDefinition], fallbackEntry: () => undefined },
    { entries: () => [{ target: 'chat', create: () => ({
      empty: nodes,
      replace: input => (nodes = input.nodes as ChatNode<'artifact'>[]),
      apply: (input) => {
        const changed = new Map(nodes.map(node => [node.key, node]))
        for (const node of input.upserts) changed.set(node.key, node as ChatNode<'artifact'>)
        return (nodes = [...changed.values()])
      },
    }) }] },
  )
  assembler.replaceWindow([], false)
  assembler.activateTarget('chat')
  return { assembler, nodes: () => nodes }
}

describe('artifactDefinition', () => {
  it('replace and append retain one keyed node whose latest complete checkpoint wins', () => {
    const h = harness()
    h.assembler.append(upsert(1, 'a', 1))
    h.assembler.flush()
    const initial = h.nodes()[0]!
    expect(initial).toMatchObject({ kind: 'artifact', id: 'a', anchorSeq: 1, data: { snapshot: { revision: 1 } } })

    h.assembler.append(unrelated(2))
    h.assembler.flush()
    expect(h.nodes()[0]).toBe(initial)
    h.assembler.append(upsert(3, 'b', 1))
    h.assembler.append(upsert(4, 'a', 2))
    h.assembler.flush()

    expect(h.nodes()).toHaveLength(2)
    const updated = h.nodes().find(node => node.id === 'a')!
    expect(updated.key).toBe(initial.key)
    expect(updated.anchorSeq).toBe(1)
    expect(updated.data).toEqual({ snapshot: snapshot('a', 2), history: null, firstSeq: 1 })

    const replay = harness()
    replay.assembler.replaceWindow([upsert(1, 'a', 1), unrelated(2), upsert(3, 'b', 1), upsert(4, 'a', 2)], false)
    replay.assembler.flush()
    expect(replay.nodes().map(node => [node.key, node.data])).toEqual(h.nodes().map(node => [node.key, node.data]))
  })

  it('renders a tail-only checkpoint and keeps its key when an older checkpoint prepends', () => {
    const h = harness()
    h.assembler.replaceWindow([upsert(8, 'a', 4)], true)
    h.assembler.flush()
    const tail = h.nodes()[0]!
    expect(tail).toMatchObject({ key: tail.key, anchorSeq: 8, data: { snapshot: { revision: 4 } } })

    h.assembler.prepend([upsert(2, 'a', 1)], false)
    h.assembler.flush()
    const expanded = h.nodes()[0]!
    expect(expanded.key).toBe(tail.key)
    expect(expanded.anchorSeq).toBe(2)
    expect(expanded.data).toEqual({ snapshot: snapshot('a', 4), history: null, firstSeq: 2 })
  })

  it('prepends unrelated history without replacing unchanged artifact data', () => {
    const h = harness()
    h.assembler.replaceWindow([upsert(5, 'a', 2)], true)
    h.assembler.flush()
    const current = h.nodes()[0]!
    h.assembler.prepend([unrelated(1), upsert(3, 'b', 1)], false)
    h.assembler.flush()
    expect(h.nodes().find(node => node.id === 'a')).toBe(current)
    expect(h.nodes().find(node => node.id === 'b')?.data.snapshot).toEqual(snapshot('b', 1))
  })

  it.each([
    { kind: 'particle system', scene: particle },
    { kind: 'function plot', scene: plot },
  ])('shows the current $kind revision in its turn and recovers earlier source from loaded history', ({ scene }) => {
    const original = scene(1)
    const revised = scene(2)
    const first = [turnStart(1, 1), upsert(2, original.artifactId, 1, original)]
    const second = [turnStart(3, 2), upsert(4, revised.artifactId, 2, revised)]
    const h = harness()
    h.assembler.replaceWindow(first, false)
    h.assembler.flush()
    const initial = h.nodes()[0]!
    expect(initial).toMatchObject({ anchorSeq: 2, location: { kind: 'turn', turn: { turn: 1 } } })
    for (const entry of second) h.assembler.append(entry)
    h.assembler.flush()
    expect(h.nodes()).toHaveLength(1)
    const current = h.nodes()[0]!
    expect(current).toMatchObject({ key: initial.key, anchorSeq: 4, groupTree: 'turn', location: { kind: 'turn', turn: { turn: 2 } } })
    expect(current.data).toEqual({ snapshot: revised, history: { snapshot: original, earlier: null }, firstSeq: 2 })

    const replay = harness()
    replay.assembler.replaceWindow(second, true)
    replay.assembler.flush()
    expect(replay.nodes()[0]).toMatchObject({ key: current.key, anchorSeq: 4, data: { snapshot: revised, history: null, firstSeq: 4 } })
    replay.assembler.prepend(first, false)
    replay.assembler.flush()
    expect(replay.nodes()[0]).toMatchObject({ key: current.key, anchorSeq: 4, data: current.data })
  })

  it('claims only artifact events and requires both a checkpoint and a start for a node', () => {
    expect(artifactDefinition.match(unrelated(1).event)).toBeNull()
    expect(artifactDefinition.match(upsert(1, 'a', 1).event)).toEqual({ id: 'a', role: 'start', exclusive: true })
    expect(() => artifactDefinition.start(
      {} as never, { event: unrelated(1).event } as never, {} as never,
    )).toThrow(/requires artifact\/upsert/)
    expect(artifactDefinition.buildViewNode?.({ state: undefined, start: undefined } as never)).toBeNull()
    expect(artifactDefinition.buildViewNode?.({ state: snapshot('a', 1), start: undefined } as never)).toBeNull()
  })
})
