// @vitest-environment jsdom
import type { ComponentProps } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { allowAllAccess, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ArtifactId, ArtifactSnapshot } from '@deepseek-ai/dsh-artifact/types'
import { ArtifactComparisonNodeView } from '../src/client/ArtifactComparisonNodeView.tsx'
import { artifactComparisonDefinition } from '../src/client/comparison-definition.ts'
import { artifactDefinition } from '../src/client/definition.ts'
import { en } from '../src/client/locales.ts'

const t = makeTranslate(en)
const throwUnused = () => { throw new Error('unused standard prop') }

function snapshot(role: 'control' | 'variant'): ArtifactSnapshot {
  return {
    artifactId: `damping-${role}` as ArtifactId, revision: 1, format: 'html',
    title: role === 'control' ? 'Control' : 'Variant', source: `<h1>${role}</h1>`, presentation: 'inline',
    comparison: { group: 'damping-study', role },
  }
}

function sceneSnapshot(role: 'control' | 'variant'): ArtifactSnapshot {
  return {
    artifactId: `damping-${role}` as ArtifactId, revision: 1, format: 'scene',
    title: role === 'control' ? 'Control' : 'Variant',
    spec: {
      kind: 'function-plot',
      functions: [{ id: 'x', label: 'displacement', expression: 'exp(-d*t)*sin(2*pi*1.5*t)' }],
      parameters: { d: { value: role === 'control' ? 0.2 : 0.8, min: 0, max: 2, step: 0.1 } },
      viewport: { x: [0, 12], y: [-10, 10] },
      trace: { x: 0.8, derivative: false, integral: false },
    },
    presentation: 'inline',
    comparison: { group: 'damping-study', role },
  }
}

function props(recordAction = vi.fn().mockResolvedValue(undefined), data?: ComponentProps<typeof ArtifactComparisonNodeView>['node']['data']): ComponentProps<typeof ArtifactComparisonNodeView> {
  return {
    node: {
      key: 'comparison:damping-study', id: 'comparison:damping-study', kind: 'artifact-comparison', target: 'chat', anchorSeq: 1,
      location: { kind: 'session' }, visibility: 'visible',
      data: data ?? { group: 'damping-study', control: snapshot('control'), variant: snapshot('variant') },
    },
    sessionId: SessionId('comparison'),
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
  } as ComponentProps<typeof ArtifactComparisonNodeView>
}

function post(source: HTMLIFrameElement, data: unknown): void {
  act(() => { window.dispatchEvent(new MessageEvent('message', { data, source: source.contentWindow, origin: 'null' })) })
}

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('ArtifactComparisonNodeView', () => {
  it('groups comparison events by group instead of rendering ordinary Artifact nodes', () => {
    const control = snapshot('control')
    const variant = snapshot('variant')
    expect(artifactComparisonDefinition.match({ type: 'artifact/upsert', data: control } as never)?.id).toBe('comparison:damping-study')
    expect(artifactComparisonDefinition.match({ type: 'artifact/upsert', data: variant } as never)?.id).toBe('comparison:damping-study')
    expect(artifactDefinition.match({ type: 'artifact/upsert', data: control } as never)).toBeNull()
  })

  it('synchronizes commands without merging parameters and confirms one comparison result', async () => {
    const recordAction = vi.fn().mockResolvedValue(undefined)
    render(<ArtifactComparisonNodeView {...props(recordAction)} />)
    const control = screen.getByTitle('Control preview') as HTMLIFrameElement
    const variant = screen.getByTitle('Variant preview') as HTMLIFrameElement
    const controlPost = vi.spyOn(control.contentWindow!, 'postMessage')
    const variantPost = vi.spyOn(variant.contentWindow!, 'postMessage')

    post(control, { kind: 'artifact-state', state: { time: 0.1, damping: 0.2 } })
    post(variant, { kind: 'artifact-state', state: { time: 0.1, damping: 0.5 } })
    fireEvent.click(screen.getByRole('button', { name: 'Step all' }))
    expect(controlPost).toHaveBeenCalledWith({ kind: 'artifact-command', command: 'step' }, '*')
    expect(variantPost).toHaveBeenCalledWith({ kind: 'artifact-command', command: 'step' }, '*')

    fireEvent.click(screen.getByRole('button', { name: 'Compare results' }))
    await waitFor(() => { expect(recordAction).toHaveBeenCalledOnce() })
    expect(recordAction).toHaveBeenCalledWith('damping-control', 1, 'comparison.completed', {
      group: 'damping-study',
      control: { artifactId: 'damping-control', revision: 1, state: { time: 0.1, damping: 0.2 } },
      variant: { artifactId: 'damping-variant', revision: 1, state: { time: 0.1, damping: 0.5 } },
    }, true)
  })

  it('completes a comparison of two native SceneSpecs through local state reports', async () => {
    const recordAction = vi.fn().mockResolvedValue(undefined)
    const base = props(recordAction, { group: 'damping-study', control: sceneSnapshot('control'), variant: sceneSnapshot('variant') })
    render(<ArtifactComparisonNodeView {...base} />)

    await waitFor(() => {
      const button = screen.getByRole('button', { name: 'Compare results' }) as HTMLButtonElement
      expect(button.disabled).toBe(false)
    })
    fireEvent.click(screen.getByRole('button', { name: 'Compare results' }))
    await waitFor(() => { expect(recordAction).toHaveBeenCalledOnce() })
    const payload = recordAction.mock.calls[0]?.[3] as {
      group: string
      control: { artifactId: string; state: { parameters: Record<string, number> } }
      variant: { artifactId: string; state: { parameters: Record<string, number> } }
    }
    expect(payload.group).toBe('damping-study')
    expect(payload.control.artifactId).toBe('damping-control')
    expect(payload.control.state.parameters.d).toBe(0.2)
    expect(payload.variant.artifactId).toBe('damping-variant')
    expect(payload.variant.state.parameters.d).toBe(0.8)
  })
})
