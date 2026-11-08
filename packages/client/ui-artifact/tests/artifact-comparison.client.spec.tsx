// @vitest-environment jsdom
import type { ComponentProps } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { allowAllAccess, makeTranslate, sessionSnapshot } from '@deepseek-ai/dsh-client-test-runtime'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ArtifactRuntimeIdentity, ArtifactRuntimeId } from '@deepseek-ai/dsh-artifact-runtime/types'
import type { ArtifactId, ArtifactSnapshot } from '@deepseek-ai/dsh-artifact/types'
import { ArtifactComparisonNodeView } from './runtime-harness.tsx'
import { artifactComparisonDefinition } from '../src/client/comparison-definition.ts'
import { artifactDefinition } from '../src/client/definition.ts'
import { en } from '../src/client/locales.ts'
import type { ConfirmObservationComparison, RecordArtifactAction, SaveArtifactObservation, SendArtifactObservation } from '../src/client/protocol.ts'

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
    useSession: selector => selector(sessionSnapshot(SessionId('comparison'))),
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
    useSessions: () => ({ byId: {} }),
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
  } as ComponentProps<typeof ArtifactComparisonNodeView>
}

function post(source: HTMLIFrameElement, data: unknown): void {
  act(() => { window.dispatchEvent(new MessageEvent('message', { data, source: source.contentWindow, origin: 'null' })) })
}

beforeEach(() => {
  const context = new Proxy({}, { get: (_target, name) => name === 'measureText' ? () => ({ width: 20 }) : () => {} })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as CanvasRenderingContext2D)
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

function identityFor(frame: HTMLIFrameElement): ArtifactRuntimeIdentity {
  return { artifactId: frame.dataset.artifactId as ArtifactId, revision: Number(frame.dataset.artifactRevision),
    runtimeId: frame.dataset.artifactRuntimeId as ArtifactRuntimeId, renderer: 'html' }
}
function readyState(frame: HTMLIFrameElement, state: unknown): void {
  const identity = identityFor(frame)
  post(frame, { kind: 'artifact-runtime-report', identity, report: { status: 'ready', capabilities: { state: true, commands: ['step'] } } })
  post(frame, { kind: 'artifact-runtime-state', identity, state })
}


describe('ArtifactComparisonNodeView', () => {
  it('does not mistake an Object-property identity for saved observations in a comparison', () => {
    const data = { group: 'damping-study', control: { ...sceneSnapshot('control'), artifactId: 'constructor' as ArtifactId },
      variant: { ...sceneSnapshot('variant'), artifactId: '__proto__' as ArtifactId } }
    render(<ArtifactComparisonNodeView {...props(undefined, data)} />)
    expect(screen.queryByRole('button', { name: 'Saved observations' })).toBeNull()
  })
  it('checks export permissions for both comparison cards', () => {
    const base = props(undefined, { group: 'damping-study', control: sceneSnapshot('control'), variant: sceneSnapshot('variant') })
    const access = vi.fn().mockReturnValue(false)
    const commands = { create: vi.fn(), download: vi.fn() }
    const view = render(<ArtifactComparisonNodeView {...base} useAccess={access} exports={commands} />)
    expect(access).toHaveBeenCalledWith('artifactExports/create')
    expect(access).toHaveBeenCalledWith('artifactExports/read')
    expect(screen.queryByRole('button', { name: 'Export animation' })).toBeNull()
    view.rerender(<ArtifactComparisonNodeView {...base} useAccess={() => true} exports={commands} />)
    expect(screen.getAllByRole('button', { name: 'Export animation' })).toHaveLength(2)
    expect(commands.create).not.toHaveBeenCalled()
  })
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

    readyState(control, { time: 0.1, damping: 0.2 })
    readyState(variant, { time: 0.1, damping: 0.5 })
    fireEvent.click(await screen.findByRole('button', { name: 'Step all' }))
    expect(controlPost).toHaveBeenCalledWith(expect.objectContaining({ kind: 'artifact-runtime-command', identity: identityFor(control), command: 'step' }), '*')
    expect(variantPost).toHaveBeenCalledWith(expect.objectContaining({ kind: 'artifact-runtime-command', identity: identityFor(variant), command: 'step' }), '*')
    expect(screen.getByRole('button', { name: 'Step all' }).hasAttribute('disabled')).toBe(true)
    for (const [frame, sent] of [[control, controlPost], [variant, variantPost]] as const) {
      let requestId = ''
      for (const call of sent.mock.calls) {
        const message: unknown = call[0]
        if (typeof message === 'object' && message !== null && 'kind' in message && message.kind === 'artifact-runtime-command'
          && 'requestId' in message && typeof message.requestId === 'string') requestId = message.requestId
      }
      expect(requestId).not.toBe('')
      post(frame, { kind: 'artifact-runtime-command-result', identity: identityFor(frame), requestId, result: { ok: true } })
    }
    await waitFor(() => { expect(screen.getByRole('button', { name: 'Step all' }).hasAttribute('disabled')).toBe(false) })

    await waitFor(() => { expect(screen.getByRole('button', { name: 'Compare results' }).hasAttribute('disabled')).toBe(false) })
    fireEvent.click(screen.getByRole('button', { name: 'Compare results' }))
    await waitFor(() => { expect(recordAction).toHaveBeenCalledOnce() })
    expect(recordAction).toHaveBeenCalledWith('damping-control', 1, 'comparison.completed', {
      group: 'damping-study',
      control: { artifactId: 'damping-control', revision: 1, state: { time: 0.1, damping: 0.2 } },
      variant: { artifactId: 'damping-variant', revision: 1, state: { time: 0.1, damping: 0.5 } },
    }, true, expect.any(String))
  })

  it('keeps a partial shared-command refusal visible when the source itself has no failed command', async () => {
    const command = vi.fn<(key: string) => Promise<void>>().mockRejectedValueOnce(new Error('Remounted before dispatch')).mockResolvedValue(undefined)
    render(<ArtifactComparisonNodeView {...props()} runtimeCommand={command} />)
    readyState(screen.getByTitle('Control preview'), { time: 1 })
    readyState(screen.getByTitle('Variant preview'), { time: 1 })
    fireEvent.click(await screen.findByRole('button', { name: 'Step all' }))
    await screen.findByText('Could not confirm that both programs completed the command. Check the previews before retrying.')
    expect(command).toHaveBeenCalledTimes(2)
  })

  it('retries an unconfirmed current comparison with its original identity after the displayed source changes', async () => {
    const first = Promise.withResolvers<undefined>()
    const recordAction = vi.fn<RecordArtifactAction>().mockReturnValueOnce(first.promise).mockResolvedValue(undefined)
    const base = props(recordAction)
    const view = render(<ArtifactComparisonNodeView {...base} />)
    readyState(screen.getByTitle('Control preview'), { count: 1, nested: { selected: 'A' } })
    readyState(screen.getByTitle('Variant preview'), { count: 10 })
    await waitFor(() => { expect(screen.getByRole('button', { name: 'Compare results' }).hasAttribute('disabled')).toBe(false) })
    fireEvent.click(screen.getByRole('button', { name: 'Compare results' }))
    const original = recordAction.mock.calls[0]
    expect(original?.[5]).toEqual(expect.any(String))
    const control = { ...snapshot('control'), revision: 2 }
    const variant = { ...snapshot('variant'), revision: 2 }
    view.rerender(<ArtifactComparisonNodeView {...base} node={{ ...base.node, data: { group: 'damping-study', control, variant } }} />)
    readyState(screen.getByTitle('Control preview'), { count: 2, nested: { selected: 'B' } })
    readyState(screen.getByTitle('Variant preview'), { count: 20 })
    await act(async () => { first.reject(new Error('response lost')); await expect(first.promise).rejects.toThrow('response lost') })
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', en['actionSubmission.unknown'])
    expect(screen.getByRole('button', { name: 'Compare results' }).hasAttribute('disabled')).toBe(true)
    const details = screen.getByText(en['actionSubmission.original']).closest('details')
    const rawRequest: unknown = JSON.parse(details?.querySelector('pre')?.textContent ?? '')
    expect(rawRequest).toMatchObject({ revision: 1, payload: original?.[3] })
    fireEvent.click(screen.getByRole('button', { name: en['actionSubmission.retry'] }))
    await screen.findByText(en['comparison.sent'])
    expect(recordAction.mock.calls[1]).toEqual(original)
    fireEvent.click(screen.getByRole('button', { name: 'Compare results' }))
    await waitFor(() => { expect(recordAction).toHaveBeenCalledTimes(3) })
    expect(recordAction.mock.calls[2]?.[1]).toBe(2)
    expect(recordAction.mock.calls[2]?.[3]).toMatchObject({ control: { state: { count: 2 } }, variant: { state: { count: 20 } } })
    expect(recordAction.mock.calls[2]?.[5]).not.toBe(original?.[5])
  })

  it('retains the original current confirmation when new particle sources require saved comparison mode', async () => {
    const first = Promise.withResolvers<undefined>()
    const recordAction = vi.fn<RecordArtifactAction>().mockReturnValue(first.promise)
    const base = props(recordAction)
    const view = render(<ArtifactComparisonNodeView {...base} />)
    readyState(screen.getByTitle('Control preview'), { count: 1 })
    readyState(screen.getByTitle('Variant preview'), { count: 2 })
    await waitFor(() => { expect(screen.getByRole('button', { name: 'Compare results' }).hasAttribute('disabled')).toBe(false) })
    fireEvent.click(screen.getByRole('button', { name: 'Compare results' }))
    const particle = (role: 'control' | 'variant'): ArtifactSnapshot => ({
      ...snapshot(role), revision: 2, format: 'scene', spec: {
        kind: 'particle-system', particles: [{ id: 'p', x: 0, y: 0, vx: 0, vy: 0, mass: 1 }],
        gravity: { x: 0, y: 0 }, timeStep: 0.1, trails: false,
      },
    })
    view.rerender(<ArtifactComparisonNodeView {...base} node={{ ...base.node, data: {
      group: 'damping-study', control: particle('control'), variant: particle('variant'),
    } }} />)
    await act(async () => { first.reject(new Error('response lost')); await expect(first.promise).rejects.toThrow('response lost') })
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', en['actionSubmission.unknown'])
    expect(screen.getByRole('button', { name: 'Send comparison' }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Send comparison' }))
    expect(recordAction).toHaveBeenCalledOnce()
    expect(base.confirmObservationComparison).not.toHaveBeenCalled()
    expect(screen.queryByText(en['comparison.unknownSaved'])).toBeNull()
    expect(screen.getByText(en['actionSubmission.original']).closest('details')?.textContent).toContain('"count": 1')
  })

  it('completes a comparison of two native SceneSpecs through local state reports', async () => {
    const recordAction = vi.fn().mockResolvedValue(undefined)
    const base = props(recordAction, { group: 'damping-study', control: sceneSnapshot('control'), variant: sceneSnapshot('variant') })
    render(<ArtifactComparisonNodeView {...base} />)
    expect(screen.queryByRole('button', { name: 'Play all' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Step all' })).toBeNull()

    await waitFor(() => {
      const button = screen.getByRole('button', { name: 'Compare results' }) as HTMLButtonElement
      expect(button.disabled).toBe(false)
    })
    await waitFor(() => { expect(screen.getByRole('button', { name: 'Compare results' }).hasAttribute('disabled')).toBe(false) })
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
    await screen.findByText('Comparison sent to Agent.')
    fireEvent.change(within(screen.getByRole('complementary', { name: 'Artifact: Control' })).getByRole('slider'), {
      target: { value: '0.4' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Compare results' }))
    await waitFor(() => { expect(recordAction).toHaveBeenCalledTimes(2) })
    expect(recordAction.mock.calls[1]?.[3]).toMatchObject({ control: { state: { parameters: { d: 0.4 } } } })
  })

  it('requires reports from each current HTML revision and ignores replaced frames', async () => {
    const recordAction = vi.fn().mockResolvedValue(undefined)
    const base = props(recordAction)
    const view = render(<ArtifactComparisonNodeView {...base} />)
    const oldControl = screen.getByTitle('Control preview') as HTMLIFrameElement
    const oldVariant = screen.getByTitle('Variant preview') as HTMLIFrameElement
    readyState(oldControl, { version: 1 })
    readyState(oldVariant, { version: 1 })
    await waitFor(() => { expect(screen.getByRole('button', { name: 'Compare results' }).hasAttribute('disabled')).toBe(false) })

    const control = { ...snapshot('control'), revision: 2 }
    const variant = { ...snapshot('variant'), revision: 2 }
    view.rerender(<ArtifactComparisonNodeView {...base} node={{ ...base.node, data: { group: 'damping-study', control, variant } }} />)
    const compare = screen.getByRole('button', { name: 'Compare results' })
    expect(compare.hasAttribute('disabled')).toBe(true)
    readyState(oldControl, { version: 'old' })
    readyState(oldVariant, { version: 'old' })
    expect(compare.hasAttribute('disabled')).toBe(true)
    readyState(screen.getByTitle('Control preview'), { version: 2 })
    expect(compare.hasAttribute('disabled')).toBe(true)
    readyState(screen.getByTitle('Variant preview'), { version: 2 })
    await waitFor(() => { expect(compare.hasAttribute('disabled')).toBe(false) })
    fireEvent.click(compare)
    await waitFor(() => { expect(recordAction).toHaveBeenCalledOnce() })
    expect(recordAction).toHaveBeenCalledWith('damping-control', 2, 'comparison.completed', {
      group: 'damping-study',
      control: { artifactId: 'damping-control', revision: 2, state: { version: 2 } },
      variant: { artifactId: 'damping-variant', revision: 2, state: { version: 2 } },
    }, true, expect.any(String))
  })

  it('uses the new source analysis after native function-plot revisions change', async () => {
    const recordAction = vi.fn().mockResolvedValue(undefined)
    const base = props(recordAction, { group: 'damping-study', control: sceneSnapshot('control'), variant: sceneSnapshot('variant') })
    const view = render(<ArtifactComparisonNodeView {...base} />)
    const control = sceneSnapshot('control')
    const variant = sceneSnapshot('variant')
    if (control.format !== 'scene' || control.spec.kind !== 'function-plot') throw new Error('Expected function plot')
    if (variant.format !== 'scene' || variant.spec.kind !== 'function-plot') throw new Error('Expected function plot')
    view.rerender(<ArtifactComparisonNodeView {...base} node={{ ...base.node, data: {
      group: 'damping-study',
      control: { ...control, revision: 2, spec: { ...control.spec, parameters: { d: { value: 1.2, min: 0, max: 2, step: 0.1 } } } },
      variant: { ...variant, revision: 2, spec: { ...variant.spec, parameters: { d: { value: 1.4, min: 0, max: 2, step: 0.1 } } } },
    } }} />)
    await waitFor(() => { expect(screen.getByRole('button', { name: 'Compare results' }).hasAttribute('disabled')).toBe(false) })
    fireEvent.click(screen.getByRole('button', { name: 'Compare results' }))
    await waitFor(() => { expect(recordAction).toHaveBeenCalledOnce() })
    expect(recordAction.mock.calls[0]?.[1]).toBe(2)
    expect(recordAction.mock.calls[0]?.[3]).toMatchObject({
      control: { revision: 2, state: { parameters: { d: 1.2 } } },
      variant: { revision: 2, state: { parameters: { d: 1.4 } } },
    })
  })
})

describe('subagent comparison routing', () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks() })
  it.each(['continuable', 'one-shot', 'unknown'] as const)('keeps local %s previews but offers no Host comparison submission', (mode) => {
    const base = props()
    const snapshot = sessionSnapshot(base.sessionId)
    base.useSession = selector => selector({ ...snapshot, subagent: {
      address: { parentSessionId: SessionId('parent'), childSessionId: base.sessionId, mode }, parentAvailable: true,
    } })
    render(<ArtifactComparisonNodeView {...base} />)
    expect(screen.queryByRole('button', { name: en['comparison.send'] })).toBeNull()
    expect(screen.getAllByText(en['route.subagentLocalOnly'])).toHaveLength(2)
    expect(screen.getByTitle('Control preview')).toBeTruthy()
    expect(screen.getByTitle('Variant preview')).toBeTruthy()
    expect(base.recordAction).not.toHaveBeenCalled()
    expect(base.confirmObservationComparison).not.toHaveBeenCalled()
  })
})
