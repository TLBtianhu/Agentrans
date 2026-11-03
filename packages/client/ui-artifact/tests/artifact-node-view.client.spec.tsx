// @vitest-environment jsdom
import type { ComponentProps } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate, allowAllAccess, bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { ArtifactNodeView } from '../src/client/ArtifactNodeView.tsx'
import { en } from '../src/client/locales.ts'
import type { ArtifactId, ArtifactSnapshot, RecordArtifactAction } from '../src/client/protocol.ts'

const t = makeTranslate(en)
const throwUnused = () => { throw new Error('unused standard prop') }
const snapshot = (revision = 1, presentation: ArtifactSnapshot['presentation'] = 'inline'): ArtifactSnapshot => ({
  artifactId: 'artifact-a' as ArtifactId, revision, format: 'html', title: `Report ${revision}`,
  source: `<h1>Report ${revision}</h1><script>window.revision = ${revision}</script>`, presentation,
})

type ViewProps = ComponentProps<typeof ArtifactNodeView>
function props(revision = 1, recordAction: RecordArtifactAction = vi.fn().mockResolvedValue(undefined), presentation: ArtifactSnapshot['presentation'] = 'inline'): ViewProps {
  const data = snapshot(revision, presentation)
  return {
    node: {
      key: 'artifact:artifact-a', id: data.artifactId, kind: 'artifact', target: 'chat', anchorSeq: revision,
      location: { kind: 'session' }, visibility: 'visible', data,
    },
    sessionId: SessionId('artifact-a'),
    useSession: throwUnused,
    useProjection: throwUnused,
    useConversation: throwUnused,
    useTrajectory: throwUnused,
    useChat: throwUnused,
    useInput: throwUnused,
    inputActions: {
      insertQuote: () => false,
      captureInsertion: () => ({ start: 0, end: 0, draftRev: 0 }),
      insertText: () => false,
      setDraft: () => {},
      persistDraft: () => {},
      addAttachments: () => true,
      removeAttachment: () => {},
      pruneAttachments: () => {},
      submit: () => {},
    },
    useSessions: () => ({ byId: {} }),
    useSessionStatus: throwUnused,
    useSessionRetainInfo: throwUnused,
    useWorkspaces: throwUnused,
    usePanelInfo: throwUnused,
    useContextMenu: throwUnused,
    useResource: throwUnused,
    ...allowAllAccess,
    recordAction,
    openFile: vi.fn(), inspectCall: undefined, forkAt: vi.fn(), loadImage: async () => { throw new Error('not used') },
    useTurnData: () => undefined,
    useDisclosure: () => { throw new Error('unused disclosure') },
    useGroupAction: () => { throw new Error('unused group action') },
    t,
  } as ViewProps
}

function frame(): HTMLIFrameElement {
  return screen.getByTitle('Report 1 preview') as HTMLIFrameElement
}

function post(target: HTMLIFrameElement, data: unknown, source: MessageEventSource | null = target.contentWindow): void {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data, source, origin: 'null' }))
  })
}

const action = (revision = 1, name = 'approve') => ({
  kind: 'artifact-action', artifactId: 'artifact-a', revision, action: name, payload: { accepted: true },
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('ArtifactNodeView', () => {
  it('renders an opaque srcDoc iframe, revision, local focus, and source inspection', () => {
    const view = render(<ArtifactNodeView {...props(1, undefined, 'focus')} />)
    const iframe = frame()
    expect(iframe.getAttribute('sandbox')).toBe('allow-scripts')
    expect(iframe.getAttribute('sandbox')).not.toContain('allow-same-origin')
    expect(iframe.getAttribute('srcdoc')).toContain("default-src 'none'")
    expect(iframe.getAttribute('srcdoc')).toContain("connect-src 'none'")
    expect(screen.getByText('Report 1')).toBeTruthy()
    expect(screen.getByText('Revision 1')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Use inline view' }).getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByRole('button', { name: 'Expand artifact' }).getAttribute('aria-pressed')).toBe('true')

    fireEvent.click(screen.getByRole('button', { name: 'Use inline view' }))
    expect(screen.getByRole('button', { name: 'Expand artifact' }).getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(screen.getByRole('button', { name: 'View source' }))
    expect(screen.queryByTitle('Report 1 preview')).toBeNull()
    expect(screen.getByLabelText('HTML source').textContent).toContain('window.revision = 1')
    fireEvent.click(screen.getByRole('button', { name: 'Show preview' }))
    expect(frame()).toBeTruthy()
    view.unmount()
  })

  it('stages a valid action without Remote traffic and sends only after explicit confirmation', async () => {
    const recordAction = vi.fn<RecordArtifactAction>().mockResolvedValue(undefined)
    render(<ArtifactNodeView {...props(1, recordAction)} />)
    post(frame(), action())
    expect(await screen.findByText('Action: approve')).toBeTruthy()
    expect(recordAction).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Send to Agent' }))
    await waitFor(() => { expect(screen.queryByText('Action: approve')).toBeNull() })
    expect(recordAction).toHaveBeenCalledExactlyOnceWith('artifact-a', 1, 'approve', { accepted: true }, true)
  })

  it('rejects a wrong source, revision, schema, and oversized message', () => {
    const recordAction = vi.fn<RecordArtifactAction>().mockResolvedValue(undefined)
    render(<ArtifactNodeView {...props(1, recordAction)} />)
    const iframe = frame()
    post(iframe, action(), window)
    for (const data of [
      { ...action(), artifactId: 'other' },
      { ...action(), revision: 2 },
      { ...action(), kind: 'other' },
      { ...action(), action: '' },
      { ...action(), payload: Number.NaN },
      { ...action(), payload: '😀'.repeat(5000) },
    ]) post(iframe, data)
    expect(screen.queryByText(/Action:/)).toBeNull()
    expect(recordAction).not.toHaveBeenCalled()
  })

  it('shows branch lineage and returns to the source conversation', () => {
    const parent = SessionId('parent')
    const child = SessionId('artifact-a')
    const sessions = createSnapshotStore<SessionListState>({
      ids: [child, parent],
      byId: {
        [child]: { id: child, displayTitle: 'Child', running: false, retainedBy: {}, blank: false, updatedAt: 1, parentId: parent },
        [parent]: { id: parent, displayTitle: 'Parent topic', running: false, retainedBy: {}, blank: false, updatedAt: 1 },
      },
      phase: 'ready', projectionsBySession: {},
    })
    const base = props(1)
    base.useSessions = bindSnapshotSelector(sessions)
    render(<ArtifactNodeView {...base} />)
    expect(screen.getByText('Branched from Parent topic')).toBeTruthy()

    const scene = screen.getByLabelText('Artifact: Report 1')
    fireEvent.click(screen.getByRole('button', { name: 'Picture in picture' }))
    expect(scene.getAttribute('data-placement')).toBe('pip')
    expect(screen.getByText('Branched from Parent topic')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'View in conversation' }))
    expect(scene.getAttribute('data-placement')).toBe('inline')
  })

  it('moves the same scene through beside, focus, and PiP without losing pending actions', async () => {
    const recordAction = vi.fn<RecordArtifactAction>().mockResolvedValue(undefined)
    render(<ArtifactNodeView {...props(1, recordAction)} />)
    const scene = screen.getByLabelText('Artifact: Report 1')
    const firstFrame = frame()
    post(firstFrame, action())
    expect(await screen.findByText('Action: approve')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Dock beside chat' }))
    expect(scene.getAttribute('data-placement')).toBe('beside')
    expect(screen.getByText('Action: approve')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Picture in picture' }))
    expect(scene.getAttribute('data-placement')).toBe('pip')
    expect(frame()).toBe(firstFrame)
    expect(screen.getByText('Action: approve')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Expand artifact' }))
    expect(scene.getAttribute('data-placement')).toBe('focus')
    expect(frame()).toBe(firstFrame)
    expect(screen.getByText('Action: approve')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Send to Agent' }))
    await waitFor(() => { expect(screen.queryByText('Action: approve')).toBeNull() })
    expect(recordAction).toHaveBeenCalledExactlyOnceWith('artifact-a', 1, 'approve', { accepted: true }, true)
  })

  it('removes message listeners and transient state on revision update and unmount', async () => {
    const add = vi.spyOn(window, 'addEventListener')
    const remove = vi.spyOn(window, 'removeEventListener')
    const recordAction = vi.fn<RecordArtifactAction>().mockResolvedValue(undefined)
    const view = render(<ArtifactNodeView {...props(1, recordAction)} />)
    const first = frame()
    const firstListener = add.mock.calls.find(call => call[0] === 'message')?.[1]
    expect(firstListener).toBeDefined()
    post(first, action())
    expect(await screen.findByText('Action: approve')).toBeTruthy()

    view.rerender(<ArtifactNodeView {...props(2, recordAction)} />)
    const second = screen.getByTitle('Report 2 preview') as HTMLIFrameElement
    expect(second).not.toBe(first)
    expect(first.isConnected).toBe(false)
    expect(screen.queryByText('Action: approve')).toBeNull()
    expect(remove).toHaveBeenCalledWith('message', firstListener)
    post(first, action())
    expect(screen.queryByText('Action: approve')).toBeNull()

    const secondListener = add.mock.calls.filter(call => call[0] === 'message').at(-1)?.[1]
    view.unmount()
    expect(remove).toHaveBeenCalledWith('message', secondListener)
  })

  it('keeps a failed action visible and retries it with wake enabled', async () => {
    const recordAction = vi.fn<RecordArtifactAction>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(undefined)
    render(<ArtifactNodeView {...props(1, recordAction)} />)
    post(frame(), action())
    fireEvent.click(await screen.findByRole('button', { name: 'Send to Agent' }))

    expect(await screen.findByRole('alert')).toHaveProperty('textContent', en['send.failed'])
    expect(screen.getByText('Action: approve')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Retry sending to Agent' }))
    await waitFor(() => { expect(screen.queryByText('Action: approve')).toBeNull() })
    expect(recordAction).toHaveBeenCalledTimes(2)
    expect(recordAction).toHaveBeenNthCalledWith(2, 'artifact-a', 1, 'approve', { accepted: true }, true)
  })

  it('serializes confirmation and preserves actions that arrive during a send', async () => {
    const pending = Promise.withResolvers<undefined>()
    const recordAction = vi.fn<RecordArtifactAction>().mockReturnValue(pending.promise)
    render(<ArtifactNodeView {...props(1, recordAction)} />)
    const iframe = frame()
    post(iframe, action(1, 'first'))
    post(iframe, action(1, 'second'))
    expect(await screen.findByText('2 actions pending')).toBeTruthy()
    const button = screen.getByRole('button', { name: 'Send to Agent' })
    act(() => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(recordAction).toHaveBeenCalledTimes(1)
    expect(recordAction).toHaveBeenCalledWith('artifact-a', 1, 'first', { accepted: true }, true)
    await act(async () => { pending.resolve(undefined); await pending.promise })
    expect(await screen.findByText('Action: second')).toBeTruthy()
    expect(screen.queryByText('Action: first')).toBeNull()
  })

  it('bounds pending actions and makes overflow visible until a send frees capacity', async () => {
    const recordAction = vi.fn<RecordArtifactAction>().mockResolvedValue(undefined)
    render(<ArtifactNodeView {...props(1, recordAction)} />)
    const iframe = frame()
    for (let index = 0; index < 32; index += 1) post(iframe, action(1, `action-${index}`))
    expect(await screen.findByText('32 actions pending')).toBeTruthy()
    post(iframe, action(1, 'overflow'))
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', en['pending.overflow'])
    expect(screen.queryByText('Action: overflow')).toBeNull()
    expect(recordAction).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Send to Agent' }))
    await waitFor(() => { expect(screen.queryByRole('alert')).toBeNull() })
    expect(screen.getByText('31 actions pending')).toBeTruthy()
    expect(recordAction).toHaveBeenCalledWith('artifact-a', 1, 'action-0', { accepted: true }, true)
  })

  it('ignores a failed Remote completion after unmount', async () => {
    const pending = Promise.withResolvers<undefined>()
    const recordAction = vi.fn<RecordArtifactAction>().mockReturnValue(pending.promise)
    const view = render(<ArtifactNodeView {...props(1, recordAction)} />)
    post(frame(), action())
    fireEvent.click(await screen.findByRole('button', { name: 'Send to Agent' }))
    view.unmount()
    await act(async () => { pending.reject(new Error('offline')); await expect(pending.promise).rejects.toThrow('offline') })
    expect(recordAction).toHaveBeenCalledOnce()
  })

  it('detaches the listener in source view and ignores async settlement after unmount', async () => {
    const pending = Promise.withResolvers<undefined>()
    const recordAction = vi.fn<RecordArtifactAction>().mockReturnValue(pending.promise)
    const remove = vi.spyOn(window, 'removeEventListener')
    const view = render(<ArtifactNodeView {...props(1, recordAction)} />)
    const iframe = frame()
    post(iframe, action())
    fireEvent.click(await screen.findByRole('button', { name: 'Send to Agent' }))
    fireEvent.click(screen.getByRole('button', { name: 'View source' }))
    expect(remove).toHaveBeenCalledWith('message', expect.any(Function))
    post(iframe, action(1, 'late'))
    expect(screen.queryByText('Action: late')).toBeNull()
    view.unmount()
    await act(async () => { pending.resolve(undefined); await pending.promise })
    expect(recordAction).toHaveBeenCalledOnce()
  })
})
