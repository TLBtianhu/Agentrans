import { describe, expect, it } from 'vitest'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { MessageId } from '@deepseek-ai/dsh-llm/brand'
import { SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import {
  createBranchResultMessage, findBranchResult, selectBranchResult,
} from '../src/index.ts'
import type { BranchLogObservation, BranchResultSource } from '../src/types.ts'

const sid = (value: string): SessionId => value as SessionId
const parentId = sid('parent')

function assistant(seq: number, text: string): SessionEvent<'assistant/message'> {
  return {
    type: 'assistant/message',
    seq: SessionSeq(seq),
    time: seq,
    data: {
      turn: 1,
      step: 1,
      stream: [],
      message: createAssistantMessage({
        content: [
          { type: 'reasoning', text: 'private reasoning' },
          { type: 'text', text },
        ],
        source: { provider: 'test', model: 'test' },
      }),
    },
    surfaceOp: 'append',
  }
}

function observation(overrides: Partial<BranchLogObservation> = {}): BranchLogObservation {
  return {
    header: {
      id: sid('child'),
      parentSession: parentId,
      isSeeded: true,
    },
    inheritedEventCount: SessionLogOffset(1),
    events: [assistant(0, 'inherited'), assistant(1, 'confirmed answer')],
    ...overrides,
  }
}

describe('selectBranchResult', () => {
  it('selects only visible child-owned text and constructs a parent-local referenced message', () => {
    const selected = selectBranchResult(observation(), parentId, SessionSeq(1))
    expect(selected.ok).toBe(true)
    if (!selected.ok) return
    expect(selected.value.content).toEqual([{ type: 'text', text: 'confirmed answer' }])
    expect(selected.value.reference).toMatchObject({
      kind: 'branch-result', branchSessionId: 'child', resultSeq: 1, form: 'notice',
    })

    const message = createBranchResultMessage(selected.value)
    expect(message.role).toBe('user')
    expect(message.id).not.toBe(selected.value.reference.resultMessageId)
    expect(message.content).toEqual([{ type: 'text', text: 'confirmed answer' }])
    expect(message.source).toEqual(selected.value.reference)
    expect(JSON.stringify(message)).not.toContain('private reasoning')
  })

  it.each([
    ['subagent', observation({ header: { id: sid('child'), parentSession: parentId, isSeeded: true, origin: 'subagent' } })],
    ['not-branch', observation({ header: { id: sid('child'), isSeeded: false } })],
    ['not-branch', observation({ header: { id: sid('child'), parentSession: parentId, isSeeded: false } })],
    ['wrong-parent', observation()],
  ] as const)('rejects %s without selecting text', (reason, candidate) => {
    const requestedParent = reason === 'wrong-parent' ? sid('grandparent') : parentId
    expect(selectBranchResult(candidate, requestedParent, SessionSeq(1))).toEqual({ ok: false, reason })
  })

  it('rejects inherited, missing, non-assistant, and empty results', () => {
    expect(selectBranchResult(observation(), parentId, SessionSeq(0))).toEqual({ ok: false, reason: 'inherited-result' })
    expect(selectBranchResult(observation(), parentId, SessionSeq(8))).toEqual({ ok: false, reason: 'result-not-found' })
    const user: SessionEvent<'user/message'> = {
      type: 'user/message', seq: SessionSeq(1), time: 1, surfaceOp: 'append',
      data: createUserMessage({ content: [{ type: 'text', text: 'not assistant' }], source: { kind: 'user' } }),
    }
    expect(selectBranchResult(observation({ events: [assistant(0, 'inherited'), user] }), parentId, SessionSeq(1)))
      .toEqual({ ok: false, reason: 'result-not-found' })
    expect(selectBranchResult(observation({ events: [assistant(0, 'inherited'), assistant(1, '  \n')] }), parentId, SessionSeq(1)))
      .toEqual({ ok: false, reason: 'empty-result' })
  })
})

describe('findBranchResult', () => {
  it('returns the existing parent event only for the exact branch result reference', () => {
    const selected = selectBranchResult(observation(), parentId, SessionSeq(1))
    if (!selected.ok) throw new Error('fixture did not select')
    const message = createBranchResultMessage(selected.value)
    const returned: SessionEvent<'user/message'> = {
      type: 'user/message', seq: SessionSeq(9), time: 9, surfaceOp: 'append', data: message,
    }
    expect(findBranchResult([returned], selected.value.reference)).toEqual({ eventSeq: 9, messageId: message.id })
    const other: BranchResultSource = { ...selected.value.reference, branchSessionId: sid('sibling') }
    expect(findBranchResult([returned], other)).toBeUndefined()
    expect(findBranchResult([returned], { ...selected.value.reference, resultSeq: SessionSeq(0) })).toBeUndefined()
    expect(findBranchResult([returned], { ...selected.value.reference, resultMessageId: MessageId('different') }))
      .toEqual({ eventSeq: 9, messageId: message.id })
  })

  it('ignores ordinary user messages', () => {
    const selected = selectBranchResult(observation(), parentId, SessionSeq(1))
    if (!selected.ok) throw new Error('fixture did not select')
    const ordinary: SessionEvent<'user/message'> = {
      type: 'user/message', seq: SessionSeq(2), time: 2, surfaceOp: 'append',
      data: createUserMessage({ content: [{ type: 'text', text: 'ordinary' }], source: { kind: 'user' } }),
    }
    expect(findBranchResult([ordinary], selected.value.reference)).toBeUndefined()
  })
})
