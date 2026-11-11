// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { bindSnapshotSelector, makeTranslate } from '@agentrans/client-test-runtime'
import { createSnapshotStore } from '@agentrans/client-store'
import type { SessionBranchResultError, SessionListState } from '@agentrans/api-session-controller/client'
import { zh as commonZh } from '@agentrans/client-locale/src/locales/zh.ts'
import { SessionId, SessionSeq } from '@agentrans/session/types'
import { BranchResultAction, type BranchResultActionProps } from '../src/client/BranchResultAction.tsx'
import type {} from '../src/client/index.ts'
import { zh } from '../src/client/locales.ts'

const parent = SessionId('parent')
const child = SessionId('child')
const t: BranchResultActionProps['t'] = makeTranslate(zh, commonZh)

function fixture(options: {
  allowed?: boolean | undefined
  parentId?: SessionId | undefined
  origin?: 'subagent' | undefined
  parentOrigin?: 'subagent' | undefined
  text?: string | undefined
} = {}) {
  const current = {
    id: child, displayTitle: 'Child', running: false, retainedBy: {}, blank: false, updatedAt: 1,
    ...('parentId' in options
      ? options.parentId === undefined ? {} : { parentId: options.parentId }
      : { parentId: parent }),
    ...options.origin === undefined ? {} : { origin: options.origin },
  }
  const parentRow = {
    id: parent, displayTitle: 'Parent', running: false, retainedBy: {}, blank: false, updatedAt: 1,
    ...options.parentOrigin === undefined ? {} : { origin: options.parentOrigin },
  }
  const sessions = createSnapshotStore<SessionListState>({
    ids: [parent, child], byId: { [parent]: parentRow, [child]: current }, phase: 'ready', projectionsBySession: {},
  })
  const returnBranchResult = vi.fn<BranchResultActionProps['returnBranchResult']>()
  const openSession = vi.fn()
  const props = {
    sessionId: child,
    seq: 6,
    text: options.text ?? 'C1-result',
    useSessions: bindSnapshotSelector(sessions),
    useAccess: () => options.allowed ?? true,
    returnBranchResult,
    openSession,
    t,
  } as BranchResultActionProps
  return { props, returnBranchResult, openSession }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('BranchResultAction', () => {
  it('previews exact text and cancels without any request', () => {
    const b = fixture()
    const view = render(<BranchResultAction {...b.props} />)
    fireEvent.click(view.getByRole('button', { name: '回流到父分支' }))
    expect(view.getByText('C1-result')).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: '取消' }))

    expect(b.returnBranchResult).not.toHaveBeenCalled()
    expect(b.openSession).not.toHaveBeenCalled()
    expect(view.queryByText('C1-result')).toBeNull()
  })

  it('deduplicates a pending confirmation and opens the parent after success', async () => {
    const b = fixture()
    const completion = Promise.withResolvers<undefined>()
    b.returnBranchResult.mockReturnValueOnce(completion.promise as never)
    const view = render(<BranchResultAction {...b.props} />)
    fireEvent.click(view.getByRole('button', { name: '回流到父分支' }))
    const confirm = view.getByRole('button', { name: '确认回流' })
    fireEvent.click(confirm)
    fireEvent.click(confirm)
    expect(b.returnBranchResult).toHaveBeenCalledExactlyOnceWith({
      sessionId: parent, branchSessionId: child, resultSeq: 6,
    })
    expect(b.openSession).not.toHaveBeenCalled()

    completion.resolve(undefined)
    await vi.waitFor(() => { expect(b.openSession).toHaveBeenCalledExactlyOnceWith(parent) })
    expect(b.returnBranchResult).toHaveBeenCalledOnce()
  })

  it('retains the preview after failure and retries the same request', async () => {
    const b = fixture()
    b.returnBranchResult
      .mockRejectedValueOnce(new Error('busy'))
      .mockResolvedValueOnce({ parentSessionId: parent, eventSeq: SessionSeq(9), messageId: 'message' } as never)
    const view = render(<BranchResultAction {...b.props} />)
    fireEvent.click(view.getByRole('button', { name: '回流到父分支' }))
    fireEvent.click(view.getByRole('button', { name: '确认回流' }))
    await vi.waitFor(() => { expect(view.getByRole('alert').textContent).toBe('回流失败，请重试') })
    expect(view.getByText('C1-result')).toBeTruthy()
    expect(b.openSession).not.toHaveBeenCalled()

    fireEvent.click(view.getByRole('button', { name: '重试回流' }))
    await vi.waitFor(() => { expect(b.openSession).toHaveBeenCalledExactlyOnceWith(parent) })
    expect(b.returnBranchResult).toHaveBeenCalledTimes(2)
    expect(b.returnBranchResult.mock.calls).toEqual([
      [{ sessionId: parent, branchSessionId: child, resultSeq: 6 }],
      [{ sessionId: parent, branchSessionId: child, resultSeq: 6 }],
    ])
  })

  it('treats an evidence conflict as final and opens the parent without another return request', async () => {
    const b = fixture()
    const request = { sessionId: parent, branchSessionId: child, resultSeq: 6 }
    const failure = Object.assign(new Error('Diagnostic text unrelated to the recovery action'), {
      isDSHRemoteError: true as const, code: 'session/branch-result-conflict' as const,
      details: { parentSessionId: parent, branchSessionId: child, resultSeq: 6 },
    })
    const error: Pick<SessionBranchResultError, 'rpcError' | 'request'> = Object.assign(
      new Error('Client return failed'), { rpcError: failure, request },
    )
    b.returnBranchResult.mockRejectedValueOnce(error)
    const view = render(<BranchResultAction {...b.props} />)
    fireEvent.click(view.getByRole('button', { name: '回流到父分支' }))
    fireEvent.click(view.getByRole('button', { name: '确认回流' }))
    await vi.waitFor(() => {
      expect(view.getByRole('alert').textContent).toBe('此结论已通过不同证据回流。请打开父对话查看已采纳的内容。')
    })
    expect(view.queryByRole('button', { name: '重试回流' })).toBeNull()
    expect(view.queryByRole('button', { name: '确认回流' })).toBeNull()
    expect(view.getByText('C1-result')).toBeTruthy()
    expect(b.openSession).not.toHaveBeenCalled()
    fireEvent.click(view.getByRole('button', { name: '打开父对话' }))
    expect(b.openSession).toHaveBeenCalledExactlyOnceWith(parent)
    expect(b.returnBranchResult).toHaveBeenCalledExactlyOnceWith(request)
  })

  it.each([
    ['permission', { allowed: false }],
    ['not a branch', { parentId: undefined }],
    ['subagent child', { origin: 'subagent' as const }],
    ['subagent parent', { parentOrigin: 'subagent' as const }],
    ['empty result', { text: '  \n' }],
  ] as const)('hides the action for %s', (_name, options) => {
    const b = fixture(options)
    const view = render(<BranchResultAction {...b.props} />)
    expect(view.queryByRole('button', { name: '回流到父分支' })).toBeNull()
    expect(b.returnBranchResult).not.toHaveBeenCalled()
  })
})
