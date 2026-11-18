/** Browser checks for exact source cards and the draft that opened them. */
import type { MessageId } from '@agentrans/llm'
import type { Locator, Page } from 'playwright'
import { expect } from 'vitest'
import {
  compareReading, expectCsvComparisonRecords, type seedWitnessedCsvReturnComparisonDraft,
} from './csv-comparison-browser-fixture.ts'
import { selectDraftOffsets, selectedDraftOffsets } from './artifact-csv-explanation-support.ts'
import { writeComposerDraft } from './support.ts'
import type { WebScaffold } from './scaffold.ts'

const SOURCE_TRAIL_KEY = 'dsh.artifact.csv-comparison-source.v1'
type ReturnDraftFixture = Awaited<ReturnType<typeof seedWitnessedCsvReturnComparisonDraft>>
type InquiryReturns = ReturnDraftFixture['returns']
type ReturnSide = 'first' | 'second'

/** Check native browser focus on the exact control. */
export async function expectFocused(target: Locator): Promise<void> {
  await expect.poll(() => target.evaluate(element => document.activeElement === element)).toBe(true)
}

/** Select the source button within the correct side of a comparison. */
export function csvReturnLink(scope: Locator, side: ReturnSide): Locator {
  return scope.getByRole('button', { name: 'View original return', exact: true }).and(scope.locator(`[data-csv-return-source="${side}"]`))
}

/** Inspect both durable native returns using their exact parent-local addresses and revisions. */
export function frozenCsvReturnCards(conversation: Locator, returns: InquiryReturns, origin: 'comparison' | 'draft') {
  const original = ({ eventSeq, messageId }: Pick<InquiryReturns['first'], 'eventSeq' | 'messageId'>): Locator => conversation.locator(
    `[data-artifact-branch-evidence][data-chat-message-id="${messageId}"][data-chat-message-seq="${eventSeq}"]`,
  )
  const originalToggle = (source: Locator): Locator => source.locator('[data-chat-message-control="artifact-branch-result"]')
  const returnButtons = conversation.locator(`[data-csv-return-to-${origin}]`)
  const readings = [
    { side: 'first', aggregate: 'Mean of LatencyMs', value: '30', address: returns.first, other: returns.second },
    { side: 'second', aggregate: 'Sum of LatencyMs', value: '60', address: returns.second, other: returns.first },
  ] as const
  return readings.map(({ side, aggregate, value, address, other }) => {
    const source = original(address)
    const sourceControl = originalToggle(source)
    const sourceReplay = source.locator(`[data-artifact-question-replay-revision="${address.revision}"]`)
    const back = source.getByRole('button', { name: `Return to ${origin}`, exact: true }).and(returnButtons)
    const checkSource = async (): Promise<void> => {
      await back.waitFor({ state: 'visible' })
      await expectFocused(sourceControl)
      expect(await sourceReplay.getAttribute('data-artifact-question-replay-id')).toBe(address.artifactId)
      for (const [field, expected] of Object.entries({ key: 'Warm', aggregate, value, count: '2' })) {
        expect(await sourceReplay.locator(`[data-csv-reading="${field}"]`).textContent()).toBe(expected)
      }
      expect(await originalToggle(original(other)).getAttribute('aria-expanded')).toBe('false')
      expect(await returnButtons.count()).toBe(1)
    }
    return { side, address, source, sourceControl, back, checkSource }
  })
}

/** Check the two stored Warm readings and that both source records participated. */
export async function expectWarmReturnComparison(scope: Locator): Promise<void> {
  await compareReading(scope, 'original', { key: 'Warm', aggregate: 'Mean of LatencyMs', filter: 'No filter', value: '30', count: '2' })
  await compareReading(scope, 'locked', { key: 'Warm', aggregate: 'Sum of LatencyMs', filter: 'No filter', value: '60', count: '2' })
  await expectCsvComparisonRecords(scope, false)
}

type SourceAddress = { readonly eventSeq: number; readonly messageId: MessageId }
type SourceOrigin = { readonly kind: 'draft'; readonly receiptId: string }
  | { readonly kind: 'comparison'; readonly message: SourceAddress }

interface ImportedCsvSourceChainBrowser {
  readonly page: Page
  readonly conversation: Locator
  readonly sessionId: ReturnDraftFixture['sessionId']
  readonly first: SourceAddress
  readonly middle: SourceAddress
  readonly decoy?: SourceAddress | undefined
  readonly sourceKind: 'imported-explanation' | 'imported-return-comparison'
  readonly origin: SourceOrigin
  readonly reload: (check: () => Promise<void>) => Promise<void>
  readonly inspect: (scope: Locator, capture: (detail: Locator, part: string) => Promise<void>, knownOpen?: boolean) => Promise<void>
  readonly screenshot: (target: Locator, name: string) => Promise<void>
  readonly checkDraft: () => Promise<void>
  readonly name: string
}

/** Follow two exact imported sources, reload the oldest, and return to the same origin. */
export async function walkImportedCsvSourceChain({
  page, conversation, sessionId, first, middle, decoy, sourceKind, origin, reload, inspect, screenshot, checkDraft, name,
}: ImportedCsvSourceChainBrowser): Promise<void> {
  const address = ({ eventSeq, messageId }: SourceAddress): SourceAddress => ({ eventSeq, messageId })
  const comparisonOrigin = (message: SourceAddress): SourceOrigin => ({ kind: 'comparison', message: address(message) })
  const visit = (source: SourceAddress, from: SourceOrigin) => ({ source: address(source), sourceKind, origin: from })
  const card = ({ eventSeq, messageId }: SourceAddress): Locator => conversation
    .locator(`[data-chat-message-id="${messageId}"][data-chat-message-seq="${eventSeq}"] [data-csv-compare-attached]`)
  const toggle = (target: Locator): Locator => target.getByRole('button', { name: 'Replay attached comparison', exact: true })
  const fromDraft = origin.kind === 'draft'
  const originScope = origin.kind === 'draft'
    ? conversation.locator('[data-artifact-prompt-context="csv-question-comparison"]')
    : card(origin.message)
  const firstCard = card(first)
  const middleCard = card(middle)
  const storedTrail = () => page.evaluate(key => sessionStorage.getItem(key), SOURCE_TRAIL_KEY)
  const storedTrailData = async (): Promise<unknown> => {
    const parsed: unknown = JSON.parse(await storedTrail() ?? 'null')
    return parsed
  }
  const checkTrail = async (trail: readonly ReturnType<typeof visit>[]): Promise<void> => {
    const assertion = expect.poll(storedTrailData)
    if (fromDraft) await assertion.toMatchObject({ sessionId, trail })
    else await assertion.toEqual({ sessionId, trail })
  }
  const shots = (phase: string) => async (detail: Locator, part: string): Promise<void> => {
    await detail.evaluate((element) => { element.scrollIntoView({ block: 'center' }) })
    await screenshot(detail, `${name}-${phase}-${part}.png`)
  }
  const checkActive = async (target: Locator, expected: SourceAddress, phase: string): Promise<void> => {
    await expectFocused(toggle(target))
    await expect.poll(() => toggle(target).getAttribute('aria-expanded')).toBe('true')
    const current = target.locator('[data-csv-source-trail-stop][aria-current="location"]')
    await expect.poll(() => current.getAttribute('data-csv-source-message-id')).toBe(expected.messageId)
    expect(await current.getAttribute('data-csv-source-event-seq')).toBe(String(expected.eventSeq))
    await inspect(target, shots(phase), true)
    if (decoy !== undefined) expect(await toggle(card(decoy)).getAttribute('aria-expanded')).toBe('false')
  }
  async function jumpThroughPreview(scope: Locator, phase: string, targets: readonly [SourceAddress, ...SourceAddress[]]): Promise<void> {
    const previousTrail = await storedTrail()
    await scope.getByRole('button', { name: 'View full source chain', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Source chain', exact: true })
    const stops = dialog.locator('[data-csv-full-source-chain] [data-csv-source-chain-stop]')
    await expect.poll(() => stops.evaluateAll(elements => elements.map(element => ({
      eventSeq: Number(element.getAttribute('data-csv-source-event-seq')),
      messageId: element.getAttribute('data-csv-source-message-id'),
    })))).toEqual(targets.map(address))
    expect(await storedTrail()).toBe(previousTrail)
    const target = targets[0]
    expect(await toggle(card(target)).getAttribute('aria-expanded')).toBe('false')
    await checkDraft()
    await screenshot(dialog, `${name}-${phase}-preview.png`)
    const targetStop = `[data-csv-source-chain-stop][data-csv-source-event-seq="${target.eventSeq}"]`
      + `[data-csv-source-message-id="${target.messageId}"]`
    await dialog.locator(targetStop).getByRole('button').click()
    await dialog.waitFor({ state: 'hidden' })
  }

  const middleVisit = visit(middle, origin)
  const firstVisit = visit(first, comparisonOrigin(middle))
  await jumpThroughPreview(originScope, 'origin', [middle, first])
  await checkActive(middleCard, middle, 'middle-forward')
  await checkTrail([middleVisit])
  await jumpThroughPreview(middleCard, 'middle', [first])
  await checkTrail([middleVisit, firstVisit])
  await checkActive(firstCard, first, 'first-forward')
  await reload(async () => {
    await checkActive(firstCard, first, 'first-after-refresh')
    expect(await toggle(middleCard).getAttribute('aria-expanded')).toBe('false')
    await checkTrail([middleVisit, firstVisit])
    await checkDraft()
  })

  await firstCard.getByRole('button', { name: 'Return to comparison', exact: true }).click()
  await checkActive(middleCard, middle, 'middle-return')
  await checkTrail([middleVisit])
  const returnLabel = fromDraft ? 'Return to draft' : 'Return to comparison'
  await middleCard.getByRole('button', { name: returnLabel, exact: true }).click()
  if (!fromDraft) {
    await expectFocused(toggle(originScope))
    await expect.poll(() => toggle(originScope).getAttribute('aria-expanded')).toBe('true')
    await inspect(originScope, shots('restored-history'), true)
  }
  await expect.poll(storedTrail).toBeNull()
  await checkDraft()
}

interface CsvReturnDraftBrowser extends ReturnDraftFixture {
  readonly world: WebScaffold
  readonly page: Page
  readonly conversation: Locator
  readonly text: string
  readonly reload: (check: () => Promise<void>) => Promise<void>
  readonly screenshot: (target: Locator, name: string) => Promise<void>
  readonly reloadAfterFinalReturn?: boolean
}

/** Visit and refresh each exact return, then restore and inspect the same unsent draft. */
export async function visitCsvReturnDraftSources({
  world, page, conversation, sessionId, draft, returns, text, reload, screenshot, reloadAfterFinalReturn = true,
}: CsvReturnDraftBrowser) {
  const input = conversation.locator('[data-composer-input][contenteditable="true"]')
  const chip = conversation.locator('[data-artifact-prompt-context="csv-question-comparison"]')
  const review = chip.getByRole('button', { name: 'Review attached comparison', exact: true })
  const returnButtons = conversation.locator('[data-csv-return-to-draft]')
  const storedTrail = () => page.evaluate(key => sessionStorage.getItem(key), SOURCE_TRAIL_KEY)
  const checkDraft = async (): Promise<void> => {
    await expect.poll(() => input.textContent()).toBe(text)
    await chip.waitFor({ state: 'visible' })
    expect(await world.ctx.artifactBranchResults.readCsvComparisonDraft({ sessionId })).toEqual(draft)
  }
  const openReview = async (): Promise<void> => {
    if ((await review.getAttribute('aria-expanded')) !== 'true') await review.click()
    await expectWarmReturnComparison(chip)
  }
  const selected = { first: { start: 8, end: 19 }, second: { start: 25, end: 25 } }
  const digest: unknown = expect.stringMatching(/^[a-f0-9]{64}$/u)
  const cards = frozenCsvReturnCards(conversation, returns, 'draft')
  await writeComposerDraft(page, input, text)
  await checkDraft()
  for (const { side, address, source, back, checkSource } of cards) {
    const offsets = selected[side]
    await openReview()
    await selectDraftOffsets(page, input, offsets)
    await csvReturnLink(chip, side).click()
    await checkSource()
    await expect.poll(async () => {
      const data: unknown = JSON.parse(await storedTrail() ?? 'null')
      return data
    }).toEqual({ sessionId, trail: [{
      source: { eventSeq: address.eventSeq, messageId: address.messageId },
      origin: { kind: 'draft', receiptId: draft.receiptId, returnSide: side, ...offsets, digest },
    }] })
    await reload(async () => {
      await checkSource()
      await checkDraft()
    })
    await screenshot(source, `csv-inquiry-draft-${side}-source-after-refresh.png`)
    if (side === 'first') await back.click()
    else await back.press('Enter')
    await expect.poll(() => selectedDraftOffsets(input)).toEqual(offsets)
    await checkDraft()
    await expect.poll(storedTrail).toBeNull()
    expect(await returnButtons.count()).toBe(0)
    await screenshot(conversation.locator('[data-composer-seat]'), `csv-inquiry-draft-returned-from-${side}.png`)
    await openReview()
    await screenshot(chip, `csv-inquiry-draft-${side}-attachment-preserved.png`)

    if (side === 'first' || reloadAfterFinalReturn) await reload(async () => {
      await checkDraft()
      for (const { sourceControl } of cards) expect(await sourceControl.getAttribute('aria-expanded')).toBe('false')
      expect(await returnButtons.count()).toBe(0)
      expect(await storedTrail()).toBeNull()
    })
  }
  await openReview()
  return selected
}
