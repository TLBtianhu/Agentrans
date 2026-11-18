// @vitest-environment jsdom
import type { ArtifactId } from '@agentrans/artifact/types'
import type { AttachmentId } from '@agentrans/attachment'
import { makeTranslate } from '@agentrans/client-test-runtime'
import type { ChatNode, ChatSnapshot } from '@agentrans/client-ui-chat/client'
import { MessageId } from '@agentrans/llm/brand'
import { SessionId } from '@agentrans/session/types'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { EMPTY_CHAT_SNAPSHOT } from '../../ui-chat/src/client/contract/snapshot.ts'
import { InquiryReturnedResultAction } from '../src/client/InquiryReturnedResultAction.tsx'
import { en } from '../src/client/locales.ts'

const inquiryId = SessionId('inquiry-child')
const t = makeTranslate(en)
type ReturnedNode = ChatNode<'artifact-branch-evidence'>

afterEach(cleanup)

function returnedCsv(eventSeq: number, messageId: string, aggregate: 'mean' | 'sum', value: number,
  branchSessionId = inquiryId, visibility: ReturnedNode['visibility'] = 'visible'): ReturnedNode {
  const group = { key: 'Warm', value, count: 2 }
  return {
    key: `return:${messageId}`, id: messageId, target: 'chat', kind: 'artifact-branch-evidence',
    anchorSeq: eventSeq, location: { kind: 'session' }, visibility,
    data: {
      messageId: MessageId(messageId), branchSessionId, conclusion: ['Confirmed Warm reading.'], raw: '',
      items: [{ role: 'question', replay: {
        artifact: { artifactId: 'warm-latency' as ArtifactId, revision: aggregate === 'mean' ? 1 : 2,
          title: 'Sample latency', presentation: 'inline', format: 'scene', spec: {
            kind: 'csv-bar-chart', attachmentId: `sha256:${'a'.repeat(64)}` as AttachmentId, groupBy: 'Run',
            aggregate, valueColumn: 'LatencyMs', groups: [group], rowCount: 2,
          } },
        state: { kind: 'csv-bar-chart', group },
      } }],
    },
  }
}

function showReturns(nodes: readonly ReturnedNode[]) {
  const chat: ChatSnapshot = { ...EMPTY_CHAT_SNAPSHOT, nodes: { ...EMPTY_CHAT_SNAPSHOT.nodes, values: () => nodes } }
  const openView = vi.fn()
  render(<InquiryReturnedResultAction sessionId={SessionId('parent')} branchSessionId={inquiryId} openView={openView}
    useAccess={() => false} useChat={selector => selector(chat)} compareReturns={vi.fn()} reviewAttachment={vi.fn()} t={t} />)
  return { openView, button: screen.getByRole('button', { name: en['branchEvidence.inquiryResult'] }) }
}

function expectedFocus(eventSeq: number, messageId: string): string {
  return JSON.stringify({ kind: 'message', eventSeq, messageId, control: 'artifact-branch-result' })
}

it('lists both of the inquiry’s confirmed CSV returns in sequence order and opens each exact result', () => {
  const { button, openView } = showReturns([
    returnedCsv(28, 'locked-sum', 'sum', 60),
    returnedCsv(16, 'hidden-return', 'mean', 10, inquiryId, 'hidden'),
    returnedCsv(14, 'sibling-return', 'mean', 20, SessionId('sibling-child')),
    returnedCsv(11, 'locked-mean', 'mean', 30),
  ])
  expect(button.getAttribute('aria-haspopup')).toBe('menu')
  expect(button.getAttribute('aria-expanded')).toBe('false')
  fireEvent.click(button)
  const menu = screen.getByRole('menu')
  const options = within(menu).getAllByRole('menuitem')
  expect(options.map(option => option.querySelector<HTMLElement>('[data-inquiry-return-message-id]')?.dataset.inquiryReturnMessageId))
    .toEqual(['locked-mean', 'locked-sum'])
  expect(options[0]?.textContent).toMatch(/Warm.*Mean of LatencyMs.*30/u)
  expect(options[1]?.textContent).toMatch(/Warm.*Sum of LatencyMs.*60/u)
  expect(openView).not.toHaveBeenCalled()
  fireEvent.click(within(menu).getByRole('menuitem', { name: /Warm.*Mean of LatencyMs.*30/u }))
  expect(screen.queryByRole('menu')).toBeNull()
  expect(button.getAttribute('aria-expanded')).toBe('false')
  expect(openView).toHaveBeenCalledExactlyOnceWith('chat', expectedFocus(11, 'locked-mean'))

  fireEvent.click(button)
  fireEvent.click(screen.getByRole('menuitem', { name: /Warm.*Sum of LatencyMs.*60/u }))
  expect(screen.queryByRole('menu')).toBeNull()
  expect(openView.mock.calls).toEqual([
    ['chat', expectedFocus(11, 'locked-mean')],
    ['chat', expectedFocus(28, 'locked-sum')],
  ])
})

it('opens the exact return directly when it is the only option for the inquiry', () => {
  const { button, openView } = showReturns([returnedCsv(11, 'locked-mean', 'mean', 30)])
  expect(button.hasAttribute('aria-haspopup')).toBe(false)
  fireEvent.click(button)
  expect(screen.queryByRole('menu')).toBeNull()
  expect(openView).toHaveBeenCalledExactlyOnceWith('chat', expectedFocus(11, 'locked-mean'))
})
