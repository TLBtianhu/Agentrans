// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ComponentProps } from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { SessionEventLikeEntry } from '@agentrans/api-session-controller/client'
import { makeTranslate, sessionSnapshot } from '@agentrans/client-test-runtime'
import type { ChatNode } from '@agentrans/client-ui-chat/client'
import { MessageId } from '@agentrans/llm/brand'
import { SessionId, SessionSeq } from '@agentrans/session'
import type { ArtifactBranchContinuePlotRequestId } from '@agentrans/artifact-branch/types'
import type { SessionEvent } from '@agentrans/session/types'
import { ConversationNodeAssembler } from '../../ui-conversation/src/client/conversation/assembler.ts'
import { isVisibleChatNode } from '../../ui-chat/src/client/contract/chat-visibility.ts'
import { messageDefinition } from '../../ui-chat/src/client/conversation-nodes/message.ts'
import { BranchEvidenceMessage, BranchEvidenceNodeView } from '../src/client/BranchEvidenceMessage.tsx'
import { artifactBranchEvidenceDefinition } from '../src/client/branch-evidence-definition.ts'
import { parseBranchEvidenceNotice } from '../src/client/branch-evidence-text.ts'
import { CsvAttachedComparison, csvReturnComparisonSideLabels } from '../src/client/CsvQuestionComparison.tsx'
import { en } from '../src/client/locales.ts'

const fixture = JSON.parse(readFileSync(resolve('packages/artifact/artifact-branch/tests/fixtures/returned-message.json'), 'utf8')) as
  SessionEvent<'user/message'>['data']
const t = makeTranslate(en)

afterEach(cleanup)

it('projects a visible parent row alongside the original hidden context after assembling the durable window', () => {
  let nodes: readonly ChatNode[] = []
  const assembler = new ConversationNodeAssembler(
    { entries: () => [messageDefinition, artifactBranchEvidenceDefinition], fallbackEntry: () => undefined },
    { entries: () => [{ target: 'chat', create: () => ({
      empty: nodes,
      replace: input => (nodes = input.nodes as ChatNode[]),
      apply: () => nodes,
    }) }] },
  )
  const entry = (seq: number, data: typeof fixture): SessionEventLikeEntry => ({
    type: 'event', event: { type: 'user/message', seq: SessionSeq(seq), time: 0, data, surfaceOp: 'append' },
  })
  assembler.replaceWindow([entry(1, { ...fixture, id: MessageId('plain-branch-return'), content: fixture.content.slice(0, 1) }),
    entry(2, fixture)], false)
  assembler.activateTarget('chat')
  assembler.flush()
  expect(nodes.filter(node => node.kind === 'context').map(node => node.anchorSeq)).toEqual([1, 2])
  expect(nodes.filter(isVisibleChatNode)).toMatchObject([{
    kind: 'artifact-branch-evidence', anchorSeq: 2, data: { messageId: fixture.id, items: [{ role: 'control' }, { role: 'variant' }] },
  }])
})

it('shows a returned conclusion and can replay each side of its original saved comparison independently', () => {
  const matched = parseBranchEvidenceNotice(fixture)
  if (matched === null) throw new Error('Saved branch result must be replayable')
  expect(matched.items).toMatchObject([
    { role: 'control', replay: { artifact: { revision: 1 } } }, { role: 'variant', replay: { artifact: { revision: 1 } } },
  ])
  const view = render(<BranchEvidenceMessage matched={matched} t={t} />)
  expect(screen.getByText('At step 2, the lower-gravity trajectory stays higher.')).toBeTruthy()
  const items = view.container.querySelectorAll<HTMLElement>('[data-artifact-branch-evidence-item]')
  const [control, variant] = Array.from(items, item => within(item).getByRole('button', { name: 'Replay experiment' }))
  if (control === undefined || variant === undefined) throw new Error('Expected both replay controls')
  expect(control.hasAttribute('data-chat-message-control')).toBe(false)
  expect(variant.hasAttribute('data-chat-message-control')).toBe(false)
  expect(screen.queryByRole('img')).toBeNull()
  fireEvent.click(variant)
  expect(control.getAttribute('aria-expanded')).toBe('false')
  expect(variant.getAttribute('aria-expanded')).toBe('true')
  const rendered = view.container.querySelector('[data-artifact-question-replay-id="variant"][data-artifact-question-replay-revision="1"]')
  expect(rendered?.querySelector('[data-particle-step="2"] [data-particle-live-coordinate="y"]')?.textContent).toBe('1.75')
  fireEvent.click(control)
  expect(view.container.querySelector('[data-artifact-question-replay-id="control"] [data-particle-live-coordinate="y"]')?.textContent).toBe('1.7')
  fireEvent.click(variant)
  expect(view.container.querySelector('[data-artifact-question-replay-id="variant"]')).toBeNull()
  fireEvent.click(screen.getByText('Original attached context'))
  expect(view.container.querySelector('[data-artifact-branch-evidence-raw]')?.textContent).toBe(matched.raw)
})

it('reads a single saved observation from the existing result format', () => {
  const attachment = fixture.content.at(-1)
  if (attachment?.type !== 'text') throw new Error('Missing fixture evidence')
  const newline = attachment.text.indexOf('\n') + 1
  const { evidence: { control }, ...envelope } = JSON.parse(attachment.text.slice(newline)) as {
    readonly evidence: { readonly control: unknown }
  }
  const raw = attachment.text.slice(0, newline) + JSON.stringify({ ...envelope, evidence: { kind: 'observation', observation: control } })
  const matched = parseBranchEvidenceNotice({ ...fixture, content: [...fixture.content.slice(0, -1), { type: 'text', text: raw }] })
  expect(matched?.items).toMatchObject([{ role: 'observation', label: 'control', replay: { state: { kind: 'particle-system' } } }])
})

function returnedParticleEvidence() {
  const matched = parseBranchEvidenceNotice(fixture)
  const reading = matched?.items.find(item => item.role === 'control')
  if (matched === null || reading?.role !== 'control') throw new Error('Expected a saved particle reading')
  return { ...matched, items: [{ role: 'question', replay: reading.replay }] } as const
}

it('addresses a returned particle question and replays its locked step without playback controls', () => {
  const view = render(<BranchEvidenceMessage matched={returnedParticleEvidence()} t={t} />)
  const replay = screen.getByRole('button', { name: 'Replay experiment' })
  expect(replay.getAttribute('data-chat-message-control')).toBe('artifact-branch-result')
  fireEvent.click(replay)
  const checkpoint = view.container.querySelector('[data-particle-step="2"]')
  expect(checkpoint?.querySelector('[data-particle-live-coordinate="y"]')?.textContent).toBe('1.7')
  expect(checkpoint?.querySelector('[data-particle-live-readings]')?.getAttribute('aria-live')).toBe('polite')
  expect(screen.queryByRole('button', { name: /^(Play sweep|Pause sweep|Step|Reset)$/u })).toBeNull()
})

function returnedFunctionEvidence() {
  const raw = 'The user selected the following Artifact readings from a branch question to accompany this conclusion. '
    + 'This does not state that the assistant used them when producing the conclusion.\n'
    + JSON.stringify({ kind: 'branch-result-artifact-evidence', branchSessionId: 'evidence-child', evidence: {
      kind: 'question', questionSeq: 4, facts: {
        kind: 'current-function-plot', functionId: 'linear', x: 1, parameters: { a: 1.25 }, values: { value: 1.25, derivative: 1.25, integral: 0.625 },
        artifact: { artifactId: 'slope', revision: 1, title: 'Slope lab', presentation: 'inline', format: 'scene', spec: {
          kind: 'function-plot', functions: [{ id: 'linear', label: 'Linear', expression: 'a*x' }],
          parameters: { a: { value: 1, min: 0, max: 4, step: 0.25 } }, viewport: { x: [-2, 2], y: [-4, 4] },
          trace: { x: 0, derivative: true, integral: true },
        } },
      },
    } })
  const matched = parseBranchEvidenceNotice({ ...fixture, content: [...fixture.content.slice(0, -1), { type: 'text', text: raw }] })
  if (matched === null) throw new Error('Missing plot replay')
  return matched
}

it('replays a historical function question and retries opening its experiment with the same identity', async () => {
  const matched = returnedFunctionEvidence()
  const onFollowup = vi.fn<(replay: import('../src/client/question-context-text.ts').ArtifactQuestionReplay) => void>()
  const child = SessionId('experiment-child')
  const continuation = {
    start: vi.fn<(requestId: ArtifactBranchContinuePlotRequestId) => Promise<SessionId>>()
      .mockRejectedValueOnce(new Error('response lost')).mockResolvedValue(child),
    open: vi.fn(),
  }
  const messageRef = { eventSeq: 17, messageId: MessageId('returned-plot') }
  const view = render(<BranchEvidenceMessage matched={matched} messageRef={messageRef}
    onFollowup={onFollowup} continuation={continuation} t={t} />)
  const result = screen.getByRole('region', { name: en['branchEvidence.returned'] })
  expect(result.getAttribute('data-chat-message-seq')).toBe('17')
  expect(result.getAttribute('data-chat-message-id')).toBe(messageRef.messageId)
  const replayButton = within(result).getByRole('button', { name: 'Replay experiment' })
  expect(replayButton.getAttribute('data-chat-message-control')).toBe('artifact-branch-result')
  fireEvent.click(replayButton)
  expect(view.container.querySelector('[data-function-source-parameter="a"]')?.textContent).toBe('1.25')
  expect(view.container.querySelector('[data-function-source-value="x"]')?.textContent).toBe('1')
  expect(view.container.querySelector('[data-function-source-value="integral"]')?.textContent).toBe('0.625')
  expect(screen.queryByRole('button', { name: 'Use for next question' })).toBeNull()
  expect(onFollowup).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Use this evidence for next question' }))
  const selected = matched.items[0]
  if (selected === undefined || !('replay' in selected)) throw new Error('Expected the recorded function replay')
  expect(onFollowup).toHaveBeenCalledExactlyOnceWith(selected.replay)
  expect(continuation.start).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Continue experiment' }))
  expect(screen.getByRole('button', { name: 'Opening experiment branch…' }).hasAttribute('disabled')).toBe(true)
  await screen.findByRole('alert')
  expect(continuation.open).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Continue experiment' }))
  await waitFor(() => { expect(continuation.open).toHaveBeenCalledExactlyOnceWith(child) })
  expect(continuation.start).toHaveBeenCalledTimes(2)
  expect(continuation.start.mock.calls[1]).toEqual(continuation.start.mock.calls[0])
})

it.each([
  {
    kind: 'function-plot', endpoint: 'artifactBranchResults/exportReturnedPlot',
    evidence: returnedFunctionEvidence, replayLabel: en['questionContext.replay'],
  },
  {
    kind: 'particle-system', endpoint: 'artifactBranchResults/exportReturnedParticle',
    evidence: returnedParticleEvidence, replayLabel: en['questionContext.replay'],
  },
  {
    kind: 'bfs-checkpoint', endpoint: 'artifactBranchResults/exportReturnedBfs',
    evidence: () => returnedBfsNotice().matched, replayLabel: en['bfs.reopen'],
  },
  {
    kind: 'half-adder-checkpoint', endpoint: 'artifactBranchResults/exportReturnedHalfAdder',
    evidence: () => returnedHalfAdderNotice().matched, replayLabel: en['halfAdder.reopen'],
  },
] as const)('downloads $kind with its own permission and retries the exact reading', async ({ kind, endpoint, evidence, replayLabel }) => {
  const session = sessionSnapshot(SessionId('parent'))
  const messageId = MessageId('returned-experiment')
  const branchSessionId = SessionId('evidence-child')
  type Props = ComponentProps<typeof BranchEvidenceNodeView>
  const downloadReturnedExperiment = vi.fn<Props['downloadReturnedExperiment']>().mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce({ status: 'requested' })
  const unavailable = { 'function-plot': false, 'particle-system': false, 'bfs-checkpoint': false, 'half-adder-checkpoint': false }
  const props: Props = {
    node: { key: 'returned-experiment', kind: 'artifact-branch-evidence', id: messageId, target: 'chat', anchorSeq: 17,
      location: { kind: 'session' }, visibility: 'visible', data: { ...evidence(), messageId, branchSessionId } },
    sessionId: session.sessionId,
    useSession: selector => selector(session),
    useSessions: selector => selector({ ids: [], byId: {}, phase: 'ready', projectionsBySession: {} }),
    useAccess: action => action === endpoint,
    chooseBranchEvidence: vi.fn(), chooseBranchHtml: vi.fn(), csvAnalysis: vi.fn(), readReturnedCsvRows: vi.fn(),
    downloadReturnedExperiment,
    useContinuationAvailable: selector => selector(false),
    useReturnedExperimentExports: selector => selector({ ...unavailable, [kind]: true }),
    continueExperiment: vi.fn(), openExperimentBranch: vi.fn(), t,
    useCsvReturnedComparisonSource: selector => selector(undefined), returnToCsvOrigin: vi.fn(), openView: vi.fn(),
  }
  const view = render(<BranchEvidenceNodeView {...props} useAccess={() => false} />)
  const name = en['branchEvidence.downloadExperiment']
  expect(screen.queryByRole('button', { name })).toBeNull()
  const available = { 'function-plot': true, 'particle-system': true, 'bfs-checkpoint': true, 'half-adder-checkpoint': true }
  view.rerender(<BranchEvidenceNodeView {...props}
    useReturnedExperimentExports={selector => selector({ ...available, [kind]: false })} />)
  expect(screen.queryByRole('button', { name })).toBeNull()
  view.rerender(<BranchEvidenceNodeView {...props} />)

  const download = screen.getByRole('button', { name })
  expect(downloadReturnedExperiment).not.toHaveBeenCalled()
  const replay = screen.getByRole('button', { name: replayLabel })
  expect(replay.getAttribute('aria-expanded')).toBe('false')
  expect(screen.queryByRole('button', { name: 'Continue experiment' })).toBeNull()
  fireEvent.click(download)
  expect(download.hasAttribute('disabled')).toBe(true)
  expect(download.getAttribute('aria-busy')).toBe('true')
  expect((await screen.findByRole('alert')).textContent).toBe(en['branchEvidence.downloadExperimentFailed'])
  fireEvent.click(download)
  await screen.findByText(en['export.requested'])
  expect(downloadReturnedExperiment.mock.calls).toEqual([[kind, { eventSeq: 17, messageId }], [kind, { eventSeq: 17, messageId }]])
  expect(replay.getAttribute('aria-expanded')).toBe('false')
  expect(view.container.querySelector('iframe')).toBeNull()
})

function returnedBfsNotice() {
  const source = { kind: 'branch-result', branchSessionId: SessionId('evidence-child'), resultSeq: SessionSeq(13),
    resultMessageId: MessageId('child-conclusion'), form: 'notice' } as const
  const artifact = { artifactId: 'bfs', revision: 2, title: 'BFS stepper', presentation: 'inline', format: 'html',
    source: '<main><button>Step</button></main>' }
  const capture = { status: 'ready', restore: 'bfs-checkpoint', state: {
    kind: 'bfs-checkpoint', current: 'B', queue: ['C', 'D'], visited: ['A', 'B'],
  } }
  const raw = 'The user selected the following Artifact readings from a branch question to accompany this conclusion. '
    + 'This does not state that the assistant used them when producing the conclusion.\n'
    + JSON.stringify({ kind: 'branch-result-artifact-evidence', branchSessionId: 'evidence-child', evidence: {
      kind: 'question', questionSeq: 4, facts: { kind: 'html-runtime', artifact, runtimeId: 'run-bfs', attribution: 'program-reported', capture },
    } })
  const content = [{ type: 'text', text: 'C is first in the queue.' }, { type: 'text', text: raw }] as const
  const markedSource = { ...source, artifactEvidence: 'bfs-checkpoint' as const }
  const matched = parseBranchEvidenceNotice({ source: markedSource, content })
  if (matched === null) throw new Error('Confirmed BFS notice must be restorable')
  return { matched, source, content, markedSource, artifact, capture }
}

it('opens locked BFS from the confirmed notice in a fresh sandbox and never executes plain returned text', () => {
  const { matched, source, content, markedSource, artifact, capture } = returnedBfsNotice()
  expect(parseBranchEvidenceNotice({ source, content })).toBeNull()
  expect(parseBranchEvidenceNotice({ source: { ...markedSource, resultSeq: SessionSeq(4) }, content })).toBeNull()
  const messageRef = { eventSeq: 17, messageId: MessageId('returned-bfs') }
  const attach = vi.fn(() => true)
  const view = render(<BranchEvidenceMessage matched={matched} messageRef={messageRef} onHtmlFollowup={attach} t={t} />)
  const row = screen.getByRole('region', { name: en['branchEvidence.returned'] })
  const toggle = within(row).getByRole('button', { name: 'Restore BFS experiment' })
  expect(row.getAttribute('data-chat-message-seq')).toBe('17')
  expect(row.getAttribute('data-chat-message-id')).toBe(messageRef.messageId)
  expect(toggle.getAttribute('data-chat-message-control')).toBe('artifact-branch-result')
  expect(screen.getByText('C is first in the queue.')).toBeTruthy()
  expect(screen.getByText('Program-reported state · BFS stepper · revision 2')).toBeTruthy()
  const lockedCurrent = row.querySelector('[data-artifact-bfs-current]')
  expect(lockedCurrent?.textContent).toBe('B')
  expect(row.querySelector('[data-artifact-bfs-queue]')?.textContent).toBe('C, D')
  expect(row.querySelector('[data-artifact-bfs-visited]')?.textContent).toBe('A, B')
  expect(toggle.getAttribute('aria-expanded')).toBe('false')
  expect(view.container.querySelector('iframe')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Use this evidence for next question' })).toBeNull()

  const frame = (): HTMLIFrameElement => {
    const active = view.container.querySelector<HTMLIFrameElement>('iframe[data-artifact-replay-frame]')
    if (active === null) throw new Error('Expected the checkpoint sandbox')
    return active
  }
  const send = (target: HTMLIFrameElement, kind: string, state: unknown): void => {
    const identity = { artifactId: artifact.artifactId, revision: artifact.revision, renderer: 'html', runtimeId: target.dataset.artifactRuntimeId }
    fireEvent(window, new MessageEvent('message', { source: target.contentWindow, origin: 'null', data: { kind, identity, state } }))
  }
  fireEvent.click(toggle)
  expect(toggle.getAttribute('aria-expanded')).toBe('true')
  const original = frame()
  expect(original.getAttribute('data-artifact-revision')).toBe('2')
  expect(original.getAttribute('sandbox')).toBe('allow-scripts')
  expect(original.getAttribute('srcdoc')).toContain(artifact.source)
  fireEvent.load(original)
  send(original, 'artifact-runtime-restored', capture.state)
  expect(original.hidden).toBe(false)
  send(original, 'artifact-runtime-replay-state', { ...capture.state, current: 'C', queue: ['D'], visited: ['A', 'B', 'C'] })
  fireEvent.click(within(row).getByRole('button', { name: en['bfs.review'] }))
  const review = within(row).getByRole('region', { name: en['bfs.review'] })
  expect(review.querySelector('[data-artifact-bfs-current]')?.textContent).toBe('C')
  expect(lockedCurrent?.textContent).toBe('B')
  expect(attach).not.toHaveBeenCalled()
  fireEvent.click(toggle)
  expect(view.container.querySelector('iframe')).toBeNull()
  fireEvent.click(toggle)
  const reopened = frame()
  expect(reopened.dataset.artifactRuntimeId).not.toBe(original.dataset.artifactRuntimeId)
  fireEvent.load(reopened)
  send(reopened, 'artifact-runtime-restored', capture.state)
  expect(reopened.hidden).toBe(false)
  expect(within(row).queryByRole('region', { name: en['bfs.review'] })).toBeNull()
})

function returnedHalfAdderNotice() {
  const source = { kind: 'branch-result', branchSessionId: SessionId('half-adder-child'), resultSeq: SessionSeq(14),
    resultMessageId: MessageId('half-adder-conclusion'), form: 'notice' } as const
  const artifact = { artifactId: 'half-adder', revision: 3, title: 'Half-adder lab', presentation: 'inline', format: 'html',
    source: '<main><button>Change input</button></main>' }
  const state = { kind: 'half-adder-checkpoint', a: 1, b: 1, sum: 0, carry: 1 } as const
  const contentFor = (carry: number) => [{ type: 'text', text: 'The locked inputs produce a carry.' }, { type: 'text',
    text: 'The user selected the following Artifact readings from a branch question to accompany this conclusion. '
      + 'This does not state that the assistant used them when producing the conclusion.\n'
      + JSON.stringify({ kind: 'branch-result-artifact-evidence', branchSessionId: source.branchSessionId, evidence: {
        kind: 'question', questionSeq: 4, facts: { kind: 'html-runtime', artifact, runtimeId: 'run-half-adder', attribution: 'program-reported',
          capture: { status: 'ready', restore: state.kind, state: { ...state, carry } } },
      } }),
  }] as const
  const markedSource = { ...source, artifactEvidence: state.kind }
  const content = contentFor(state.carry)
  const matched = parseBranchEvidenceNotice({ source: markedSource, content })
  if (matched === null) throw new Error('Missing confirmed half-adder notice')
  return { matched, source, artifact, state, content, markedSource, contentFor }
}

it('addresses the validated half-adder return and opens its locked input pair', () => {
  const { matched, source, artifact, state, content, markedSource, contentFor } = returnedHalfAdderNotice()
  expect(parseBranchEvidenceNotice({ source, content })).toBeNull()
  expect(parseBranchEvidenceNotice({ source: { ...markedSource, artifactEvidence: 'bfs-checkpoint' }, content })).toBeNull()
  expect(parseBranchEvidenceNotice({ source: markedSource, content: contentFor(0) })).toBeNull()

  const messageRef = { eventSeq: 18, messageId: MessageId('returned-half-adder') }
  const view = render(<BranchEvidenceMessage matched={matched} messageRef={messageRef} t={t} />)
  const row = screen.getByRole('region', { name: en['branchEvidence.returned'] })
  const toggle = within(row).getByRole('button', { name: en['halfAdder.reopen'] })
  expect(row.getAttribute('data-chat-message-id')).toBe(messageRef.messageId)
  expect(row.getAttribute('data-chat-message-seq')).toBe('18')
  expect(toggle.getAttribute('data-chat-message-control')).toBe('artifact-branch-result')
  for (const field of ['a', 'b', 'sum', 'carry'] as const) {
    expect(row.querySelector(`[data-artifact-half-adder-${field}]`)?.textContent).toBe(String(state[field]))
  }
  expect(view.container.querySelector('iframe')).toBeNull()
  fireEvent.click(toggle)
  const frame = view.container.querySelector<HTMLIFrameElement>('iframe[data-artifact-replay-frame]')
  if (frame === null) throw new Error('Missing half-adder sandbox')
  expect(frame.getAttribute('sandbox')).toBe('allow-scripts')
  expect(frame.getAttribute('data-artifact-revision')).toBe('3')
  expect(frame.hidden).toBe(true)
  fireEvent.load(frame)
  fireEvent(window, new MessageEvent('message', { source: frame.contentWindow, origin: 'null', data: {
    kind: 'artifact-runtime-restored', state,
    identity: { artifactId: artifact.artifactId, revision: artifact.revision, runtimeId: frame.dataset.artifactRuntimeId, renderer: 'html' },
  } }))
  expect(frame.hidden).toBe(false)
  expect(toggle.getAttribute('aria-expanded')).toBe('true')
})

it('loads original returned CSV rows with only read access and keeps its replay when the source is unavailable', async () => {
  const group = { key: 'Warm', value: 30, count: 2 }
  const raw = 'The user selected the following Artifact readings from a branch question to accompany this conclusion. '
    + 'This does not state that the assistant used them when producing the conclusion.\n'
    + JSON.stringify({ kind: 'branch-result-artifact-evidence', branchSessionId: 'evidence-child', evidence: {
      kind: 'question', questionSeq: 4, facts: {
        kind: 'current-csv-bar-chart', groupKey: group.key, values: group,
        artifact: { artifactId: 'latency', revision: 1, title: 'Original latency', presentation: 'inline', format: 'scene', spec: {
          kind: 'csv-bar-chart', attachmentId: `sha256:${'a'.repeat(64)}`, groupBy: 'Trial', aggregate: 'mean',
          valueColumn: 'LatencyMs', rowCount: 4, groups: [{ key: 'Cold', value: 50, count: 2 }, group],
        } },
      },
    } })
  const matched = parseBranchEvidenceNotice({ ...fixture, content: [...fixture.content.slice(0, -1), { type: 'text', text: raw }] })
  if (matched === null) throw new Error('Missing original CSV replay')
  const session = sessionSnapshot(SessionId('parent'))
  type Props = ComponentProps<typeof BranchEvidenceNodeView>
  const readReturnedCsvRows = vi.fn<Props['readReturnedCsvRows']>()
    .mockRejectedValueOnce(new Error('missing CSV'))
    .mockResolvedValueOnce({ total: 2, offset: 0, rows: [{ record: 2, value: '25' }, { record: 5, value: '35' }] })
  const props: Props = {
    node: { key: 'returned-csv', kind: 'artifact-branch-evidence', id: fixture.id, target: 'chat', anchorSeq: 7,
      location: { kind: 'session' }, visibility: 'visible',
      data: { ...matched, messageId: fixture.id, branchSessionId: SessionId('evidence-child') } },
    sessionId: session.sessionId,
    useSession: selector => selector(session),
    useSessions: selector => selector({ ids: [], byId: {}, phase: 'ready', projectionsBySession: {} }),
    useAccess: endpoint => endpoint === 'artifactBranchResults/csvReturnedParticipatingRows',
    chooseBranchEvidence: vi.fn(), chooseBranchHtml: vi.fn(), csvAnalysis: vi.fn(), readReturnedCsvRows,
    downloadReturnedExperiment: vi.fn(),
    useContinuationAvailable: selector => selector(false),
    useReturnedExperimentExports: selector => selector({
      'function-plot': false, 'particle-system': false, 'bfs-checkpoint': false, 'half-adder-checkpoint': false,
    }),
    continueExperiment: vi.fn(), openExperimentBranch: vi.fn(), t,
    useCsvReturnedComparisonSource: selector => selector(undefined), returnToCsvOrigin: vi.fn(), openView: vi.fn(),
  }
  const view = render(<BranchEvidenceNodeView {...props} useAccess={() => false} />)
  const row = screen.getByRole('region', { name: en['branchEvidence.returned'] })
  expect(row.getAttribute('data-chat-message-seq')).toBe('7')
  expect(row.getAttribute('data-chat-message-id')).toBe(fixture.id)
  const replayButton = within(row).getByRole('button', { name: 'Replay experiment' })
  expect(replayButton.getAttribute('data-chat-message-control')).toBe('artifact-branch-result')
  expect(readReturnedCsvRows).not.toHaveBeenCalled()
  fireEvent.click(replayButton)
  const replay = view.container.querySelector<HTMLElement>('[data-artifact-question-replay-id="latency"]')
  if (replay === null) throw new Error('Missing rendered CSV replay')
  expect(replay.getAttribute('data-artifact-question-replay-revision')).toBe('1')
  expect(replay.querySelector('[data-csv-reading="key"]')?.textContent).toBe('Warm')
  expect(replay.querySelector('[data-csv-reading="aggregate"]')?.textContent).toBe('Mean of LatencyMs')
  expect(replay.querySelector('[data-csv-reading="value"]')?.textContent).toBe('30')
  expect(replay.querySelector('[data-csv-reading="count"]')?.textContent).toBe('2')
  expect(readReturnedCsvRows).not.toHaveBeenCalled()
  expect(screen.queryByRole('button', { name: 'View participating rows' })).toBeNull()
  view.rerender(<BranchEvidenceNodeView {...props} useSession={selector => selector({ ...session,
    subagent: { address: { parentSessionId: SessionId('host'), childSessionId: session.sessionId, mode: 'unknown' } },
  })} />)
  expect(screen.queryByRole('button', { name: 'View participating rows' })).toBeNull()
  view.rerender(<BranchEvidenceNodeView {...props} />)
  expect(screen.queryByRole('button', { name: 'Continue analysis' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Use this evidence for next question' })).toBeNull()
  expect(screen.queryByRole('button', { name: en['csvCompare.returnToComparison'] })).toBeNull()
  const origin = { kind: 'returned-comparison', message: { eventSeq: 18, messageId: MessageId('sent-comparison') }, side: 'first' } as const
  view.rerender(<BranchEvidenceNodeView {...props}
    useCsvReturnedComparisonSource={selector => selector([{ source: { eventSeq: 8, messageId: fixture.id }, origin }])} />)
  expect(screen.queryByRole('button', { name: en['csvCompare.returnToComparison'] })).toBeNull()
  view.rerender(<BranchEvidenceNodeView {...props}
    useCsvReturnedComparisonSource={selector => selector([{ source: { eventSeq: 7, messageId: fixture.id }, origin }])} />)
  const replayPanel = view.container.querySelector<HTMLElement>('[data-artifact-question-replay-panel]')!
  fireEvent.click(within(replayPanel).getByRole('button', { name: en['csvCompare.returnToComparison'] }))
  expect(props.returnToCsvOrigin).toHaveBeenCalledExactlyOnceWith({ eventSeq: 7, messageId: fixture.id }, props.openView)
  const draftOrigin = { kind: 'draft', receiptId: 'exact-csv-draft', selection: { start: 4, end: 4, draftRev: 1 }, returnSide: 'second' } as const
  view.rerender(<BranchEvidenceNodeView {...props} useCsvReturnedComparisonSource={selector => selector([
    { source: { eventSeq: 7, messageId: fixture.id }, origin: draftOrigin },
  ])} />)
  expect(within(replayPanel).queryByRole('button', { name: en['csvCompare.returnToComparison'] })).toBeNull()
  fireEvent.click(within(replayPanel).getByRole('button', { name: en['csvCompare.returnToDraft'] }))
  expect(props.returnToCsvOrigin).toHaveBeenCalledTimes(2)
  expect(props.returnToCsvOrigin).toHaveBeenLastCalledWith({ eventSeq: 7, messageId: fixture.id }, props.openView)
  expect(readReturnedCsvRows).not.toHaveBeenCalled()
  fireEvent.click(within(replay).getByRole('button', { name: 'View participating rows' }))
  const panel = within(replay).getByRole('region', { name: 'View participating rows' })
  expect((await within(panel).findByRole('alert')).textContent).toBe('Could not load participating rows.')
  expect(replay.querySelector('[data-csv-reading="value"]')?.textContent).toBe('30')
  fireEvent.click(within(panel).getByRole('button', { name: 'Retry' }))
  expect(await within(panel).findByRole('row', { name: '2 25' })).toBeDefined()
  expect(within(panel).getByRole('row', { name: '5 35' })).toBeDefined()
  expect(readReturnedCsvRows.mock.calls).toEqual(Array.from({ length: 2 }, () => [{ eventSeq: 7, messageId: fixture.id }, 0]))
})

it('routes each side of an expanded comparison through its own control', () => {
  const original = { groupKey: 'Warm', aggregate: 'mean', value: 30, count: 2, valueColumn: 'LatencyMs' } as const
  const page = { original, current: { ...original, aggregate: 'sum', value: 60 } as const,
    rows: [], kept: 2, excluded: 0, added: 0, total: 2, offset: 0 }
  const openReturnedSource = vi.fn()
  const view = render(<CsvAttachedComparison page={page} sideLabels={csvReturnComparisonSideLabels(t)}
    openReturnedSource={openReturnedSource} t={t} />)
  expect(screen.queryByRole('button', { name: en['csvCompare.viewOriginalReturn'] })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: en['csvCompare.replay'] }))
  const first = view.container.querySelector<HTMLElement>('[data-csv-compare-reading="original"]')!
  const second = view.container.querySelector<HTMLElement>('[data-csv-compare-reading="locked"]')!
  const firstSource = within(first).getByRole('button', { name: en['csvCompare.viewOriginalReturn'] })
  const secondSource = within(second).getByRole('button', { name: en['csvCompare.viewOriginalReturn'] })
  expect(firstSource.getAttribute('data-csv-return-source')).toBe('first')
  expect(secondSource.getAttribute('data-csv-return-source')).toBe('second')
  expect(firstSource.getAttribute('data-chat-message-control')).toBe('artifact-csv-return-first')
  expect(secondSource.getAttribute('data-chat-message-control')).toBe('artifact-csv-return-second')
  fireEvent.click(firstSource)
  fireEvent.click(secondSource)
  expect(openReturnedSource.mock.calls).toEqual([['first'], ['second']])
})

it('keeps ordinary, incomplete, mismatched and invalid notices on the generic context renderer', () => {
  expect(parseBranchEvidenceNotice({ ...fixture, source: { kind: 'user' } })).toBeNull()
  expect(parseBranchEvidenceNotice({ ...fixture, content: fixture.content.slice(0, -1) })).toBeNull()
  expect(parseBranchEvidenceNotice({ ...fixture, source: { kind: 'branch-result', branchSessionId: 'other-child' } })).toBeNull()
  const attachment = fixture.content.at(-1)
  if (attachment?.type !== 'text') throw new Error('Missing fixture evidence')
  expect(parseBranchEvidenceNotice({ ...fixture, content: [attachment] })).toBeNull()
  for (const text of [attachment.text + '\nextra text', attachment.text.replace('"timeStep":0.1', '"timeStep":0.9'), attachment.text + 'x']) {
    expect(parseBranchEvidenceNotice({ ...fixture, content: [...fixture.content.slice(0, -1), { type: 'text', text }] })).toBeNull()
  }
})
