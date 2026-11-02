import { describe, expect, it } from 'vitest'
import type { ChatConversationViewNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { SessionEventLikeEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import { ConversationNodeAssembler } from '../../ui-conversation/src/client/conversation/assembler.ts'
import { artifactDefinition } from '../src/client/definition.ts'
import type { ArtifactId, ArtifactSnapshot } from '../src/client/protocol.ts'

function snapshot(artifactId: string, revision: number, title = `Artifact ${revision}`): ArtifactSnapshot {
  return { artifactId: artifactId as ArtifactId, revision, format: 'html', title, source: `<h1>${title}</h1>`, presentation: 'inline' }
}

function upsert(seq: number, artifactId: string, revision: number): SessionEventLikeEntry {
  return { type: 'event', event: {
    type: 'artifact/upsert', seq: SessionSeq(seq), time: seq * 1000, data: snapshot(artifactId, revision),
  } }
}

function unrelated(seq: number): SessionEventLikeEntry {
  return { type: 'event', event: {
    type: 'user/message', seq: SessionSeq(seq), time: seq * 1000,
    data: { id: MessageId(`message-${seq}`), role: 'user', source: { kind: 'user' }, content: [] }, surfaceOp: 'append',
  } }
}

function harness() {
  let nodes: readonly ChatConversationViewNode[] = []
  const assembler = new ConversationNodeAssembler(
    { entries: () => [artifactDefinition], fallbackEntry: () => undefined },
    { entries: () => [{ target: 'chat', create: () => ({
      empty: nodes,
      replace: input => (nodes = input.nodes as ChatConversationViewNode[]),
      apply: (input) => {
        const changed = new Map(nodes.map(node => [node.key, node]))
        for (const node of input.upserts) changed.set(node.key, node as ChatConversationViewNode)
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
    expect(initial).toMatchObject({ kind: 'artifact', id: 'a', anchorSeq: 1, data: { revision: 1 } })

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
    expect(updated.data).toEqual(snapshot('a', 2))

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
    expect(tail).toMatchObject({ key: tail.key, anchorSeq: 8, data: { revision: 4 } })

    h.assembler.prepend([upsert(2, 'a', 1)], false)
    h.assembler.flush()
    const expanded = h.nodes()[0]!
    expect(expanded.key).toBe(tail.key)
    expect(expanded.anchorSeq).toBe(2)
    expect(expanded.data).toEqual(snapshot('a', 4))
  })

  it('prepends unrelated history without replacing unchanged artifact data', () => {
    const h = harness()
    h.assembler.replaceWindow([upsert(5, 'a', 2)], true)
    h.assembler.flush()
    const current = h.nodes()[0]!
    h.assembler.prepend([unrelated(1), upsert(3, 'b', 1)], false)
    h.assembler.flush()
    expect(h.nodes().find(node => node.id === 'a')).toBe(current)
    expect(h.nodes().find(node => node.id === 'b')?.data).toEqual(snapshot('b', 1))
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
