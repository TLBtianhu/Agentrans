// @vitest-environment jsdom
import { sessionSnapshot } from '@deepseek-ai/dsh-client-test-runtime'
import type { ComponentProps } from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { allowAllAccess, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { advanceParticleState, createParticleState, observeParticleState } from '@deepseek-ai/dsh-artifact/particle-runtime'
import type {
  ArtifactId, ArtifactObservationId, ArtifactObservations, ArtifactSnapshot, SavedParticleObservation, SceneArtifactSnapshot,
} from '@deepseek-ai/dsh-artifact/types'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { ArtifactComparisonNodeView } from './runtime-harness.tsx'
import { en } from '../src/client/locales.ts'
import {
  ArtifactComparisonRequestError, type ConfirmObservationComparison, type RecordArtifactAction,
  type SaveArtifactObservation, type SendArtifactObservation,
} from '../src/client/protocol.ts'

type Props = ComponentProps<typeof ArtifactComparisonNodeView>
type Role = 'control' | 'variant'
const GROUP = 'gravity-study'
const t = makeTranslate(en)
const throwUnused = () => { throw new Error('unused standard prop') }

function source(role: Role, revision = 1): SceneArtifactSnapshot {
  return {
    artifactId: `gravity-${role}` as ArtifactId, revision, format: 'scene', presentation: 'inline',
    title: role === 'control' ? 'Control' : 'Variant', comparison: { group: GROUP, role },
    spec: {
      kind: 'particle-system', particles: [{ id: 'alpha', x: revision === 1 ? 1 : 10, y: 1, vx: 3, vy: 8, mass: 1 }],
      gravity: { x: 0, y: role === 'control' ? -9.8 : -4 }, timeStep: 1 / 30, trails: true,
    },
  }
}

function saved(role: Role, label: string, stepCount = 6): SavedParticleObservation {
  const artifact = source(role)
  if (artifact.spec.kind !== 'particle-system') throw new Error('Expected particle source')
  return {
    observationId: `observation-${label}` as ArtifactObservationId, label, artifact,
    checkpoint: { runtimeVersion: 1, stepCount },
    values: observeParticleState(advanceParticleState(artifact.spec, createParticleState(artifact.spec), stepCount)),
  }
}

const A = saved('control', 'A')
const A2 = saved('control', 'A2')
const A7 = saved('control', 'A7', 7)
const B = saved('variant', 'B')
const observations: ArtifactObservations = { 'gravity-control': [A, A2, A7], 'gravity-variant': [B] }

function harness(confirm = vi.fn<ConfirmObservationComparison>().mockResolvedValue(undefined)) {
  const recordAction = vi.fn<RecordArtifactAction>().mockResolvedValue(undefined)
  const saveObservation = vi.fn<SaveArtifactObservation>().mockRejectedValue(new Error('Save not requested'))
  const sendObservation = vi.fn<SendArtifactObservation>().mockResolvedValue(undefined)
  const props = {
    node: {
      key: `comparison:${GROUP}`, id: `comparison:${GROUP}`, kind: 'artifact-comparison', target: 'chat', anchorSeq: 1,
      location: { kind: 'session' }, visibility: 'visible',
      data: { group: GROUP, control: source('control'), variant: source('variant') },
    },
    sessionId: SessionId('saved-comparison'),
    useSession: selector => selector(sessionSnapshot(SessionId('test-session'))),
    useProjection: (() => observations) as Props['useProjection'],
    useConversation: throwUnused,
    useTrajectory: throwUnused,
    useChat: throwUnused,
    useInput: throwUnused,
    inputActions: {
      insertQuote: () => false,
      captureInsertion: () => ({ start: 0, end: 0, draftRev: 0 }),
      insertText: () => false,
      setDraft: () => {}, persistDraft: () => {}, addAttachments: () => true,
      removeAttachment: () => {}, pruneAttachments: () => {}, submit: () => {},
    },
    useSessions: () => ({ kind: 'current' }),
    useSessionStatus: throwUnused, useSessionRetainInfo: throwUnused, useWorkspaces: throwUnused,
    usePanelInfo: throwUnused, useContextMenu: throwUnused, useResource: throwUnused,
    ...allowAllAccess,
    recordAction, saveObservation, sendObservation, confirmObservationComparison: confirm,
    openFile: vi.fn(), inspectCall: undefined, forkAt: vi.fn(), loadImage: async () => { throw new Error('not used') },
    useTurnData: () => undefined, useDisclosure: throwUnused, useGroupAction: throwUnused, t,
  } as Props
  return { props, confirm, recordAction, saveObservation, sendObservation }
}

function wrapper(role: Role): HTMLElement {
  const element = document.querySelector(`[data-comparison-role="${role}"]`)
  if (!(element instanceof HTMLElement)) throw new Error(`Comparison has no ${role} side`)
  return element
}

function row(role: Role, label: string): HTMLElement {
  const item = within(wrapper(role)).getByText(label, { exact: true }).closest('li')
  if (!(item instanceof HTMLElement)) throw new Error(`Comparison has no saved observation ${label}`)
  return item
}

function select(role: Role, label: string): void {
  fireEvent.click(within(row(role, label)).getByRole('button', { name: 'Use for comparison' }))
}

function card(role: Role): HTMLElement {
  const element = wrapper(role).querySelector('section[data-artifact-revision]')
  if (!(element instanceof HTMLElement)) throw new Error(`Comparison has no ${role} card`)
  return element
}

const send = () => screen.getByRole('button', { name: 'Send comparison' })
const selectPair = () => { select('control', 'A'); select('variant', 'B') }

function updatedProps(props: Props, format: 'scene' | 'html' = 'scene'): Props {
  const updated = (role: Role): ArtifactSnapshot => {
    const particle = source(role, 2)
    return format === 'scene' ? particle : {
      artifactId: particle.artifactId, revision: 2, format: 'html', title: particle.title,
      presentation: 'inline', comparison: { group: GROUP, role }, source: `<h1>${role} revision 2</h1>`,
    }
  }
  return { ...props, node: { ...props.node, data: { group: GROUP, control: updated('control'), variant: updated('variant') } } }
}

beforeEach(() => { vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null) })
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('saved observation comparison', () => {
  it('keeps saved observation views local without offering question context in a subagent chat', () => {
    const h = harness()
    const snapshot = sessionSnapshot(h.props.sessionId)
    h.props.useSession = selector => selector({ ...snapshot, subagent: {
      address: { parentSessionId: SessionId('parent'), childSessionId: h.props.sessionId, mode: 'continuable' }, parentAvailable: true,
    } })
    render(<ArtifactComparisonNodeView {...h.props} />)
    selectPair()
    expect(screen.queryByRole('button', { name: en['promptContext.attachComparison'] })).toBeNull()
    expect(screen.queryByRole('button', { name: en['promptContext.attach'] })).toBeNull()
    expect(screen.getAllByText(en['route.subagentLocalOnly'])).toHaveLength(2)
    expect(card('control').querySelector('[data-particle-step]')?.getAttribute('data-particle-step')).toBe('6')
    expect(card('variant').querySelector('[data-particle-step]')?.getAttribute('data-particle-step')).toBe('6')
    expect(h.confirm).not.toHaveBeenCalled()
    expect(h.recordAction).not.toHaveBeenCalled()
  })

  it('requires equal saved steps and keeps selection and restoration local', () => {
    const h = harness()
    render(<ArtifactComparisonNodeView {...h.props} />)
    expect(send().hasAttribute('disabled')).toBe(true)
    select('control', 'A7')
    select('variant', 'B')
    expect(screen.getByText('Select observations with the same runtime version, time step, and step count.')).toBeTruthy()
    expect(send().hasAttribute('disabled')).toBe(true)
    select('control', 'A')
    expect(send().hasAttribute('disabled')).toBe(false)
    expect(screen.getByText('A / B · fixed step 6')).toBeTruthy()
    for (const role of ['control', 'variant'] as const) {
      expect(card(role).getAttribute('data-artifact-revision')).toBe('1')
      expect(card(role).querySelector('[data-particle-step]')?.getAttribute('data-particle-step')).toBe('6')
    }
    expect(h.confirm).not.toHaveBeenCalled()
    expect(h.recordAction).not.toHaveBeenCalled()
    expect(h.saveObservation).not.toHaveBeenCalled()
    expect(h.sendObservation).not.toHaveBeenCalled()
  })

  it('keeps selected source revision and checkpoint when current sources advance and clears one selection on return', () => {
    const h = harness()
    const view = render(<ArtifactComparisonNodeView {...h.props} />)
    selectPair()
    view.rerender(<ArtifactComparisonNodeView {...updatedProps(h.props)} />)
    for (const role of ['control', 'variant'] as const) {
      expect(card(role).getAttribute('data-artifact-revision')).toBe('1')
      expect(card(role).querySelector('[data-particle-step]')?.getAttribute('data-particle-step')).toBe('6')
      fireEvent.click(within(wrapper(role)).getByRole('button', { name: 'View source' }))
      const spec: unknown = JSON.parse(within(wrapper(role)).getByLabelText('HTML source').textContent ?? '')
      expect(spec).toMatchObject({ particles: [{ id: 'alpha', x: 1 }] })
    }
    fireEvent.click(within(wrapper('control')).getByRole('button', { name: 'Return to latest' }))
    expect(card('control').getAttribute('data-artifact-revision')).toBe('2')
    expect(card('variant').getAttribute('data-artifact-revision')).toBe('1')
    expect(send().hasAttribute('disabled')).toBe(true)
    select('control', 'A')
    expect(send().hasAttribute('disabled')).toBe(false)
    expect(h.confirm).not.toHaveBeenCalled()
    expect(h.recordAction).not.toHaveBeenCalled()
    expect(h.sendObservation).not.toHaveBeenCalled()
  })

  it('sends only the saved ordered references once through explicit comparison confirmation', async () => {
    const h = harness()
    render(<ArtifactComparisonNodeView {...h.props} />)
    selectPair()
    const button = send()
    fireEvent.click(button)
    fireEvent.click(button)
    await screen.findByText('Comparison sent to Agent.')
    expect(h.confirm).toHaveBeenCalledExactlyOnceWith(GROUP,
      { artifactId: 'gravity-control', observationId: A.observationId },
      { artifactId: 'gravity-variant', observationId: B.observationId }, true)
    expect(send().hasAttribute('disabled')).toBe(true)
    expect(h.recordAction).not.toHaveBeenCalled()
    expect(h.saveObservation).not.toHaveBeenCalled()
    expect(h.sendObservation).not.toHaveBeenCalled()
  })

  it('retains the same retry references across source and format changes and locks selection until cancellation', async () => {
    const confirm = vi.fn<ConfirmObservationComparison>()
      .mockRejectedValueOnce(new Error('connection lost')).mockRejectedValueOnce(new Error('reply lost'))
    const h = harness(confirm)
    const view = render(<ArtifactComparisonNodeView {...h.props} />)
    selectPair()
    fireEvent.click(send())
    await screen.findByRole('alert')
    view.rerender(<ArtifactComparisonNodeView {...updatedProps(h.props, 'html')} />)
    for (const role of ['control', 'variant'] as const) {
      expect(card(role).getAttribute('data-artifact-revision')).toBe('1')
      expect(card(role).querySelector('[data-particle-step]')?.getAttribute('data-particle-step')).toBe('6')
      expect(within(wrapper(role)).getByRole('button', { name: 'Return to latest' }).hasAttribute('disabled')).toBe(true)
    }
    expect(within(row('control', 'A2')).getByRole('button', { name: 'Use for comparison' }).hasAttribute('disabled')).toBe(true)
    select('control', 'A2')
    fireEvent.click(screen.getByRole('button', { name: 'Retry comparison' }))
    await waitFor(() => { expect(confirm).toHaveBeenCalledTimes(2) })
    await screen.findByRole('alert')
    expect(confirm.mock.calls[1]).toEqual(confirm.mock.calls[0])
    expect(confirm.mock.calls[1]).toEqual([GROUP,
      { artifactId: 'gravity-control', observationId: A.observationId },
      { artifactId: 'gravity-variant', observationId: B.observationId }, true])
    fireEvent.click(screen.getByRole('button', { name: 'Cancel comparison retry' }))
    expect(screen.queryByRole('button', { name: 'Retry comparison' })).toBeNull()
    expect(within(row('control', 'A2')).getByRole('button', { name: 'Use for comparison' }).hasAttribute('disabled')).toBe(false)
    select('control', 'A2')
    expect(screen.getByText('A2 / B · fixed step 6')).toBeTruthy()
    expect(send().hasAttribute('disabled')).toBe(false)
    expect(confirm).toHaveBeenCalledTimes(2)
    expect(h.recordAction).not.toHaveBeenCalled()
    expect(h.sendObservation).not.toHaveBeenCalled()
  })

  it.each([
    ['ACTION_TOO_LARGE',
      'Comparison was not sent because it exceeds the input size limit. Create a smaller experiment, then save and select new observations.'],
    ['OBSERVATION_NOT_FOUND',
      'Comparison was not sent because a selected observation is unavailable. Reload the conversation, then select saved observations again.'],
    ['STEP_COUNT_MISMATCH', 'Comparison was not sent. Select compatible saved observations to start a new comparison.'],
  ] as const)('reports %s with its recovery action and keeps the refused pair disabled until selection changes', async (reason, message) => {
    const confirm = vi.fn<ConfirmObservationComparison>().mockRejectedValueOnce(
      new ArtifactComparisonRequestError(reason, new Error('Host refused before admission')),
    ).mockResolvedValueOnce(undefined)
    const h = harness(confirm)
    render(<ArtifactComparisonNodeView {...h.props} />)
    selectPair()
    fireEvent.click(send())
    await screen.findByText(message)
    expect(send().hasAttribute('disabled')).toBe(true)
    expect(screen.queryByRole('button', { name: 'Retry comparison' })).toBeNull()
    select('control', 'A')
    expect(send().hasAttribute('disabled')).toBe(true)
    fireEvent.click(send())
    expect(confirm).toHaveBeenCalledTimes(1)
    select('control', 'A2')
    expect(send().hasAttribute('disabled')).toBe(false)
    fireEvent.click(send())
    await screen.findByText('Comparison sent to Agent.')
    expect(confirm).toHaveBeenCalledTimes(2)
    expect(confirm.mock.calls[1]).toEqual([GROUP,
      { artifactId: 'gravity-control', observationId: A2.observationId },
      { artifactId: 'gravity-variant', observationId: B.observationId }, true])
    expect(h.recordAction).not.toHaveBeenCalled()
    expect(h.sendObservation).not.toHaveBeenCalled()
  })
})
