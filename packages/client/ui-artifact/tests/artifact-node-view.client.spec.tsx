// @vitest-environment jsdom
import { sessionSnapshot } from '@agentrans/client-test-runtime'
import type { ComponentProps } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate, allowAllAccess, bindSnapshotSelector } from '@agentrans/client-test-runtime'
import { createSnapshotStore } from '@agentrans/client-store'
import type { SessionListState } from '@agentrans/api-session-controller/client'
import { SessionId } from '@agentrans/session/types'
import { ArtifactNodeView } from './runtime-harness.tsx'
import { artifactPresentationStore } from '../src/client/presentation.ts'
import { en } from '../src/client/locales.ts'
import type {
  ArtifactId, ArtifactSnapshot, ConfirmObservationComparison, RecordArtifactAction, SaveArtifactObservation, SendArtifactObservation,
} from '../src/client/protocol.ts'

const t = makeTranslate(en)
const throwUnused = () => { throw new Error('unused standard prop') }
const snapshot = (revision = 1, presentation: ArtifactSnapshot['presentation'] = 'inline'): ArtifactSnapshot => ({
  artifactId: 'artifact-a' as ArtifactId, revision, format: 'html', title: `Report ${revision}`,
  source: `<h1>Report ${revision}</h1><script>window.revision = ${revision}</script>`, presentation,
})

type ViewProps = ComponentProps<typeof ArtifactNodeView>
function props(revision = 1, recordAction: RecordArtifactAction = vi.fn().mockResolvedValue(undefined), presentation: ArtifactSnapshot['presentation'] = 'inline'): ViewProps {
  const data = snapshot(revision, presentation)
  const store = artifactPresentationStore.create()
  return {
    node: {
      key: 'artifact:artifact-a', id: data.artifactId, kind: 'artifact', target: 'chat', anchorSeq: revision,
      location: { kind: 'session' }, visibility: 'visible', data,
    },
    sessionId: SessionId('artifact-a'),
    useStore: bindSnapshotSelector(store.store),
    actions: store.actions,
    useSession: selector => selector(sessionSnapshot(SessionId('test-session'))),
    useProjection: () => ({}),
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
    useSessions: selector => selector({ byId: {} } as SessionListState),
    useSessionStatus: throwUnused,
    useSessionRetainInfo: throwUnused,
    useWorkspaces: throwUnused,
    usePanelInfo: throwUnused,
    useContextMenu: throwUnused,
    useResource: throwUnused,
    ...allowAllAccess,
    recordAction,
    saveObservation: vi.fn<SaveArtifactObservation>().mockRejectedValue(new Error('Observation save not used')),
    sendObservation: vi.fn<SendArtifactObservation>().mockResolvedValue(undefined),
    confirmObservationComparison: vi.fn<ConfirmObservationComparison>().mockResolvedValue(undefined),
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
  vi.unstubAllGlobals()
})

describe('ArtifactNodeView', () => {
  it.each(['root', 'branch', 'subagent'] as const)('offers program context only through a supported %s prompt route', async (route) => {
    const base = props()
    const lifecycle = sessionSnapshot(base.sessionId)
    base.useSession = bindSnapshotSelector(createSnapshotStore({ ...lifecycle, subagent: route === 'subagent'
      ? { address: { parentSessionId: SessionId('parent'), childSessionId: base.sessionId, mode: 'continuable' as const }, parentAvailable: true }
      : null }))
    if (route === 'branch') base.useSessions = bindSnapshotSelector(createSnapshotStore<SessionListState>({
      ids: [base.sessionId, SessionId('parent')], byId: {
        [base.sessionId]: { id: base.sessionId, displayTitle: 'Branch', parentId: SessionId('parent'), running: false, retainedBy: {}, blank: false, updatedAt: 1 },
        [SessionId('parent')]: { id: SessionId('parent'), displayTitle: 'Parent', running: false, retainedBy: {}, blank: false, updatedAt: 1 },
      }, phase: 'ready', projectionsBySession: {},
    }))
    render(<ArtifactNodeView {...base} />)
    const target = frame()
    const identity = { artifactId: base.node.data.artifactId, revision: 1, renderer: 'html', runtimeId: target.dataset.artifactRuntimeId }
    post(target, { kind: 'artifact-runtime-report', identity, report: { status: 'ready', capabilities: { state: true, commands: [] } } })
    post(target, { kind: 'artifact-runtime-state', identity, state: { count: 1 } })
    if (route === 'subagent') {
      expect(screen.queryByRole('button', { name: en['promptContext.programAttach'] })).toBeNull()
      expect(screen.getByText(en['route.subagentLocalOnly'])).toBeTruthy()
      expect(screen.getByTitle('Report 1 preview')).toBeTruthy()
    } else {
      await waitFor(() => { expect(screen.getByRole('button', { name: en['promptContext.programAttach'] }).hasAttribute('disabled')).toBe(false) })
      expect(screen.queryByText(en['promptContext.subagentUnsupported'])).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: en['promptContext.programAttach'] }))
    }
    expect(base.recordAction).not.toHaveBeenCalled()
  })

  it('treats a valid Object-property Artifact identity as an empty projected list and permits saving', () => {
    const base = props()
    const data = { artifactId: 'constructor' as ArtifactId, revision: 1, format: 'scene', title: 'Constructor', presentation: 'inline',
      spec: { kind: 'particle-system', particles: [{ id: 'p', x: 0, y: 0, vx: 1, vy: 0, mass: 1 }],
        gravity: { x: 0, y: 0 }, timeStep: 0.1, trails: false } } as const
    render(<ArtifactNodeView {...base} node={{ ...base.node, data }} />)
    expect(screen.getByText('No saved observations yet.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Save observation' }).hasAttribute('disabled')).toBe(false)
  })
  it('checks create and read permissions separately before exposing export actions', () => {
    const base = props()
    const scene = { artifactId: base.node.data.artifactId, revision: 1, format: 'scene', title: 'Protected', presentation: 'inline',
      spec: { kind: 'flowchart', nodes: [], edges: [] } } as const
    const record = { request: { exportId: 'protected-export', format: 'html', source: { kind: 'current', artifactId: scene.artifactId, revision: 1 } },
      frozen: { artifact: scene, exporterVersion: 1, parameters: 'source-defaults' }, status: 'ready',
      file: { attachmentId: 'sha256:abc', bytes: 8, name: 'protected.html' } }
    const access = vi.fn().mockReturnValue(false)
    const commands = { create: vi.fn(), download: vi.fn() }
    const view = render(<ArtifactNodeView {...base} node={{ ...base.node, data: scene }} exports={commands}
      useAccess={access} useProjection={vi.fn(key => key === 'artifactExports' ? { 'protected-export': record } : {}) as never} />)
    expect(access).toHaveBeenCalledWith('artifactExports/create')
    expect(access).toHaveBeenCalledWith('artifactExports/read')
    expect(screen.queryByRole('button', { name: 'Export animation' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Download HTML' })).toBeNull()
    view.rerender(<ArtifactNodeView {...base} node={{ ...base.node, data: scene }} exports={commands}
      useAccess={vi.fn(method => method === 'artifactExports/read')}
      useProjection={vi.fn(key => key === 'artifactExports' ? { 'protected-export': record } : {}) as never} />)
    expect(screen.queryByRole('button', { name: 'Export animation' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Download HTML' })).toBeTruthy()
    expect(commands.create).not.toHaveBeenCalled()
    expect(commands.download).not.toHaveBeenCalled()
  })
  it('renders an opaque srcDoc iframe, revision, local focus, and source inspection', () => {
    const base = props(1, undefined, 'focus')
    base.useSessions = bindSnapshotSelector(createSnapshotStore<SessionListState>({
      ids: [SessionId('artifact-a')],
      byId: {
        [SessionId('artifact-a')]: { id: SessionId('artifact-a'), displayTitle: 'A', running: true, retainedBy: {}, blank: false, updatedAt: 1 },
      },
      phase: 'ready', projectionsBySession: {},
    }))
    const view = render(<ArtifactNodeView {...base} />)
    const iframe = frame()
    expect(iframe.getAttribute('sandbox')).toBe('allow-scripts')
    expect(iframe.getAttribute('sandbox')).not.toContain('allow-same-origin')
    expect(iframe.getAttribute('srcdoc')).toContain("default-src 'none'")
    expect(iframe.getAttribute('srcdoc')).toContain("connect-src 'none'")
    expect(screen.getByText('Report 1')).toBeTruthy()
    expect(screen.getByText('Revision 1')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Inline' }).getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByRole('button', { name: 'Expand' }).getAttribute('aria-pressed')).toBe('true')

    fireEvent.click(screen.getByRole('button', { name: 'Inline' }))
    expect(screen.getByRole('button', { name: 'Expand' }).getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(screen.getByRole('button', { name: 'View source' }))
    expect(screen.queryByTitle('Report 1 preview')).toBeNull()
    expect(screen.getByLabelText('HTML source').textContent).toContain('window.revision = 1')
    fireEvent.click(screen.getByRole('button', { name: 'Show preview' }))
    expect(frame()).toBeTruthy()
    view.unmount()
  })

  it('keeps inline placement in the flow and portals the other views outside it', () => {
    const base = props(1, undefined, 'focus')
    base.useSessions = bindSnapshotSelector(createSnapshotStore<SessionListState>({
      ids: [SessionId('artifact-a')],
      byId: {
        [SessionId('artifact-a')]: { id: SessionId('artifact-a'), displayTitle: 'A', running: true, retainedBy: {}, blank: false, updatedAt: 1 },
      },
      phase: 'ready', projectionsBySession: {},
    }))
    const view = render(<div className="flowItem"><ArtifactNodeView {...base} /></div>)
    const flowItem = view.container.querySelector('.flowItem')!
    expect(screen.getByLabelText('Artifact: Report 1').parentElement).toBe(document.body)
    expect(screen.getByLabelText('Artifact: Report 1').getAttribute('data-placement')).toBe('focus')
    fireEvent.click(screen.getByRole('button', { name: 'Inline' }))
    const inline = screen.getByLabelText('Artifact: Report 1')
    expect(inline.getAttribute('data-placement')).toBe('inline')
    expect(inline.closest('.flowItem')).toBe(flowItem)
    expect(inline.parentElement).not.toBe(document.body)
    view.unmount()
  })

  it('exports a SceneSpec through the fixed-input service and delegates its file transfer', async () => {
    const base = props(1)
    base.node = {
      ...base.node,
      data: {
        artifactId: 'artifact-a' as ArtifactId, revision: 1, format: 'scene', title: 'Plot', presentation: 'inline',
        spec: {
          kind: 'function-plot',
          functions: [{ id: 'sine', label: 'sin(x)', expression: 'sin(x)' }],
          parameters: { a: { value: 1, min: -2, max: 2, step: 0.1 } },
          viewport: { x: [-6, 6], y: [-2, 2] },
          trace: { x: 1, derivative: true, integral: false },
        },
      },
    }
    const create = vi.fn().mockResolvedValue({ request: { exportId: 'created' }, status: 'ready',
      frozen: { sessionId: base.sessionId, artifact: base.node.data, exporterVersion: 1, parameters: 'source-defaults' },
      file: { attachmentId: 'sha256:abc', bytes: 8, name: 'plot.html' } })
    const download = vi.fn().mockResolvedValue({ status: 'requested' })
    render(<ArtifactNodeView {...base} exports={{ create, download }} />)
    fireEvent.click(screen.getByRole('button', { name: 'Export animation' }))
    await waitFor(() => { expect(download).toHaveBeenCalledOnce() })
    expect(create).toHaveBeenCalledOnce()
    expect(create.mock.calls[0]?.[0]).toMatchObject({ format: 'html',
      source: { kind: 'current', artifactId: 'artifact-a', revision: 1 } })
  })

  it('forks an inquiry branch from the Artifact checkpoint without changing placement', () => {
    const base = props(1)
    render(<ArtifactNodeView {...base} />)
    fireEvent.click(screen.getByRole('button', { name: 'Branch inquiry' }))
    expect(base.forkAt).toHaveBeenCalledExactlyOnceWith(1)
    expect(screen.getByLabelText('Artifact: Report 1').getAttribute('data-placement')).toBe('inline')
  })

  it('reserves the conversation body while docked and releases it on return', () => {
    const observed: Element[] = []
    class Observer {
      observe(target: Element): void { observed.push(target) }
      disconnect(): void { observed.length = 0 }
    }
    vi.stubGlobal('ResizeObserver', Observer)
    const view = render(
      <div data-conversation-content>
        <div className="flowItem"><ArtifactNodeView {...props(1)} /></div>
      </div>,
    )
    const body = view.container.querySelector('[data-conversation-content]')!
    fireEvent.click(screen.getByRole('button', { name: 'Dock' }))
    expect(body.hasAttribute('data-artifact-dock')).toBe(true)
    expect(observed).toEqual([body])
    expect(screen.getByLabelText('Artifact: Report 1').getAttribute('data-placement')).toBe('beside')
    fireEvent.click(screen.getByRole('button', { name: 'Inline' }))
    expect(body.hasAttribute('data-artifact-dock')).toBe(false)
    expect(observed).toEqual([])
    view.unmount()
  })

  it('leaves the full-screen view on Escape without closing the artifact', () => {
    const base = props(1, undefined, 'focus')
    base.useSessions = bindSnapshotSelector(createSnapshotStore<SessionListState>({
      ids: [SessionId('artifact-a')],
      byId: {
        [SessionId('artifact-a')]: { id: SessionId('artifact-a'), displayTitle: 'A', running: true, retainedBy: {}, blank: false, updatedAt: 1 },
      },
      phase: 'ready', projectionsBySession: {},
    }))
    render(<ArtifactNodeView {...base} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.getByLabelText('Artifact: Report 1').getAttribute('data-placement')).toBe('inline')
  })

  it('does not expand a restored checkpoint on mount', () => {
    render(<ArtifactNodeView {...props(1, undefined, 'focus')} />)
    expect(screen.getByLabelText('Artifact: Report 1').getAttribute('data-placement')).toBe('inline')
  })

  it('stages a valid action without Remote traffic and sends only after explicit confirmation', async () => {
    const recordAction = vi.fn<RecordArtifactAction>().mockResolvedValue(undefined)
    render(<ArtifactNodeView {...props(1, recordAction)} />)
    post(frame(), action())
    expect(await screen.findByText('Action: approve')).toBeTruthy()
    expect(recordAction).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Send to Agent' }))
    await waitFor(() => { expect(screen.queryByText('Action: approve')).toBeNull() })
    expect(recordAction).toHaveBeenCalledExactlyOnceWith('artifact-a', 1, 'approve', { accepted: true }, true, expect.any(String))
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

    fireEvent.click(screen.getByRole('button', { name: 'Float' }))
    expect(screen.getByLabelText('Artifact: Report 1').getAttribute('data-placement')).toBe('pip')
    expect(screen.getByText('Branched from Parent topic')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Inline' }))
    expect(screen.getByLabelText('Artifact: Report 1').getAttribute('data-placement')).toBe('inline')
  })

  it('moves the same scene through beside, focus, and PiP without losing pending actions', async () => {
    const recordAction = vi.fn<RecordArtifactAction>().mockResolvedValue(undefined)
    render(<ArtifactNodeView {...props(1, recordAction)} />)
    post(frame(), action())
    expect(await screen.findByText('Action: approve')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Dock' }))
    expect(screen.getByLabelText('Artifact: Report 1').getAttribute('data-placement')).toBe('beside')
    expect(screen.getByText('Action: approve')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Float' }))
    expect(screen.getByLabelText('Artifact: Report 1').getAttribute('data-placement')).toBe('pip')
    expect(frame().srcdoc).toContain('window.revision = 1')
    expect(screen.getByText('Action: approve')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Expand' }))
    expect(screen.getByLabelText('Artifact: Report 1').getAttribute('data-placement')).toBe('focus')
    expect(frame().srcdoc).toContain('window.revision = 1')
    expect(screen.getByText('Action: approve')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Send to Agent' }))
    await waitFor(() => { expect(screen.queryByText('Action: approve')).toBeNull() })
    expect(recordAction).toHaveBeenCalledExactlyOnceWith('artifact-a', 1, 'approve', { accepted: true }, true, expect.any(String))
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

    expect(await screen.findByRole('alert')).toHaveProperty('textContent', en['actionSubmission.unknown'])
    expect(screen.getByText('Action: approve')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Retry original action' }))
    await waitFor(() => { expect(screen.queryByText('Action: approve')).toBeNull() })
    expect(recordAction).toHaveBeenCalledTimes(2)
    expect(recordAction).toHaveBeenNthCalledWith(2, 'artifact-a', 1, 'approve', { accepted: true }, true, expect.any(String))
    expect(recordAction.mock.calls[1]).toEqual(recordAction.mock.calls[0])
  })

  it('retries only the captured HTML action identity and leaves later queued actions available', async () => {
    const first = Promise.withResolvers<undefined>()
    const recordAction = vi.fn<RecordArtifactAction>().mockReturnValueOnce(first.promise).mockResolvedValue(undefined)
    render(<ArtifactNodeView {...props(1, recordAction)} />)
    const target = frame()
    post(target, action(1, 'first'))
    fireEvent.click(screen.getByRole('button', { name: 'Send to Agent' }))
    post(target, action(1, 'second'))
    await act(async () => { first.reject(new Error('lost response')); await expect(first.promise).rejects.toThrow('lost response') })
    expect(screen.getByRole('button', { name: 'Send to Agent' }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: en['actionSubmission.retry'] }))
    await screen.findByText('Action: second')
    expect(recordAction.mock.calls[1]).toEqual(recordAction.mock.calls[0])
    fireEvent.click(screen.getByRole('button', { name: 'Send to Agent' }))
    await waitFor(() => { expect(recordAction).toHaveBeenCalledTimes(3) })
    expect(recordAction.mock.calls[2]?.[2]).toBe('second')
    expect(recordAction.mock.calls[2]?.[5]).not.toBe(recordAction.mock.calls[0]?.[5])
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
    expect(recordAction).toHaveBeenCalledWith('artifact-a', 1, 'first', { accepted: true }, true, expect.any(String))
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
    expect(recordAction).toHaveBeenCalledWith('artifact-a', 1, 'action-0', { accepted: true }, true, expect.any(String))
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
