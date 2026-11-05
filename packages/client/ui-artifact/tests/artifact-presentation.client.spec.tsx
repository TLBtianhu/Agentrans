// @vitest-environment jsdom
import type { ComponentProps } from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate, allowAllAccess, bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { ArtifactNodeView } from '../src/client/ArtifactNodeView.tsx'
import { artifactPresentationStore, type ArtifactPresentationState } from '../src/client/presentation.ts'
import { en } from '../src/client/locales.ts'
import type { ArtifactId, ArtifactSnapshot, RecordArtifactAction } from '../src/client/protocol.ts'

const t = makeTranslate(en)
const throwUnused = () => { throw new Error('unused standard prop') }

type ViewProps = ComponentProps<typeof ArtifactNodeView>
interface Presentation {
  readonly useStore: ViewProps['useStore']
  readonly actions: ViewProps['actions']
  readonly read: () => ArtifactPresentationState
}

function createPresentation(): Presentation {
  const instance = artifactPresentationStore.create()
  return { useStore: bindSnapshotSelector(instance.store), actions: instance.actions, read: () => instance.getSnapshot() }
}

function propsFor(id: string, presentation: Presentation, revision = 1): ViewProps {
  const data: ArtifactSnapshot = {
    artifactId: id as ArtifactId, revision, format: 'html', title: `Report ${id}`,
    source: `<h1>${id}</h1><script>window.revision = ${revision}</script>`, presentation: 'inline',
  }
  const recordAction = vi.fn<RecordArtifactAction>().mockResolvedValue(undefined)
  return {
    node: {
      key: `artifact:${id}`, id: data.artifactId, kind: 'artifact', target: 'chat', anchorSeq: revision,
      location: { kind: 'session' }, visibility: 'visible', data,
    },
    sessionId: SessionId('session'),
    useStore: presentation.useStore,
    actions: presentation.actions,
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

function card(id: string): HTMLElement {
  return screen.getByLabelText(`Artifact: Report ${id}`)
}

function placementButton(id: string, name: string): HTMLElement {
  return within(card(id)).getByRole('button', { name })
}

function dockAttribute(): boolean {
  return document.querySelector('[data-conversation-content]')?.hasAttribute('data-artifact-dock') ?? false
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('Artifact presentation sharing', () => {
  it('docks a second Artifact as a background tab instead of covering the first', () => {
    const presentation = createPresentation()
    render(
      <div data-conversation-content>
        <div className="flowItem"><ArtifactNodeView {...propsFor('a', presentation)} /></div>
        <div className="flowItem"><ArtifactNodeView {...propsFor('b', presentation)} /></div>
      </div>,
    )
    fireEvent.click(placementButton('a', 'Dock'))
    expect(card('a').getAttribute('data-placement')).toBe('beside')
    expect(card('a').hidden).toBe(false)

    fireEvent.click(placementButton('b', 'Dock'))
    expect(card('a').getAttribute('data-placement')).toBe('beside')
    expect(card('b').getAttribute('data-placement')).toBe('beside')
    expect(card('a').hidden).toBe(true)
    expect(card('b').hidden).toBe(false)
    expect(dockAttribute()).toBe(true)
    expect(presentation.read().docks.map(entry => entry.artifactId)).toEqual(['a', 'b'])

    // The active tab's strip lists both Artifacts; selecting the other tab swaps them.
    fireEvent.click(within(card('b')).getByRole('button', { name: 'Report a' }))
    expect(card('a').hidden).toBe(false)
    expect(card('b').hidden).toBe(true)

    // Closing the active tab selects its neighbour; closing the last one releases the pane.
    fireEvent.click(within(card('a')).getByRole('button', { name: 'Close Report a' }))
    expect(card('a').getAttribute('data-placement')).toBe('inline')
    expect(card('b').hidden).toBe(false)
    // A single dock has no tab strip, so it returns to the flow through its placement control.
    fireEvent.click(placementButton('b', 'Inline'))
    expect(card('b').getAttribute('data-placement')).toBe('inline')
    expect(presentation.read().docks).toEqual([])
    expect(dockAttribute()).toBe(false)
  })

  it('keeps only one float and one focus per Session', () => {
    const presentation = createPresentation()
    render(
      <>
        <ArtifactNodeView {...propsFor('a', presentation)} />
        <ArtifactNodeView {...propsFor('b', presentation)} />
      </>,
    )
    fireEvent.click(placementButton('a', 'Float'))
    expect(card('a').getAttribute('data-placement')).toBe('pip')

    fireEvent.click(placementButton('b', 'Float'))
    expect(card('a').getAttribute('data-placement')).toBe('inline')
    expect(card('b').getAttribute('data-placement')).toBe('pip')

    fireEvent.click(placementButton('a', 'Expand'))
    expect(card('a').getAttribute('data-placement')).toBe('focus')
    // Another Artifact's float is a separate surface; expanding does not close it.
    expect(card('b').getAttribute('data-placement')).toBe('pip')

    fireEvent.click(placementButton('b', 'Expand'))
    expect(card('a').getAttribute('data-placement')).toBe('inline')
    expect(card('b').getAttribute('data-placement')).toBe('focus')
  })

  it('gives one Artifact only one detached surface at a time', () => {
    const presentation = createPresentation()
    render(<ArtifactNodeView {...propsFor('a', presentation)} />)
    fireEvent.click(placementButton('a', 'Float'))
    expect(card('a').getAttribute('data-placement')).toBe('pip')

    fireEvent.click(placementButton('a', 'Dock'))
    expect(card('a').getAttribute('data-placement')).toBe('beside')
    expect(presentation.read().floatId).toBeNull()

    fireEvent.click(placementButton('a', 'Expand'))
    expect(card('a').getAttribute('data-placement')).toBe('focus')
    expect(presentation.read().docks).toEqual([])

    fireEvent.click(placementButton('a', 'Inline'))
    expect(card('a').getAttribute('data-placement')).toBe('inline')
  })

  it('moves the active dock tab to its neighbour on close', () => {
    const presentation = createPresentation()
    render(
      <>
        <ArtifactNodeView {...propsFor('a', presentation)} />
        <ArtifactNodeView {...propsFor('b', presentation)} />
        <ArtifactNodeView {...propsFor('c', presentation)} />
      </>,
    )
    for (const id of ['a', 'b', 'c']) fireEvent.click(placementButton(id, 'Dock'))
    expect(card('c').hidden).toBe(false)

    fireEvent.click(within(card('c')).getByRole('button', { name: 'Close Report c' }))
    expect(card('b').hidden).toBe(false)
    expect(card('a').hidden).toBe(true)

    fireEvent.click(within(card('b')).getByRole('button', { name: 'Close Report b' }))
    expect(card('a').hidden).toBe(false)
    expect(presentation.read().activeDockId).toBe('a')
  })

  it('releases an Artifact surface when its Node unmounts', () => {
    const presentation = createPresentation()
    const view = render(
      <div data-conversation-content>
        <div key="a" className="flowItem"><ArtifactNodeView {...propsFor('a', presentation)} /></div>
        <div key="b" className="flowItem"><ArtifactNodeView {...propsFor('b', presentation)} /></div>
      </div>,
    )
    fireEvent.click(placementButton('a', 'Dock'))
    fireEvent.click(placementButton('b', 'Dock'))
    expect(card('a').hidden).toBe(true)

    view.rerender(
      <div data-conversation-content>
        <div key="b" className="flowItem"><ArtifactNodeView {...propsFor('b', presentation)} /></div>
      </div>,
    )
    expect(presentation.read().docks.map(entry => entry.artifactId)).toEqual(['b'])
    expect(card('b').hidden).toBe(false)
    expect(dockAttribute()).toBe(true)

    view.rerender(<div data-conversation-content />)
    expect(presentation.read().docks).toEqual([])
    expect(dockAttribute()).toBe(false)
  })

  it('keeps a docked Artifact docked when a new revision arrives', () => {
    const presentation = createPresentation()
    const view = render(<ArtifactNodeView {...propsFor('a', presentation)} />)
    fireEvent.click(placementButton('a', 'Dock'))
    expect(card('a').getAttribute('data-placement')).toBe('beside')

    view.rerender(<ArtifactNodeView {...propsFor('a', presentation, 2)} />)
    expect(card('a').getAttribute('data-placement')).toBe('beside')
    expect(screen.getByText('Revision 2')).toBeTruthy()
    expect(presentation.read().docks[0]?.revision).toBe(2)
  })
})
