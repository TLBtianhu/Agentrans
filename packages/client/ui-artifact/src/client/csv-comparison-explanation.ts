import type {
  ArtifactCsvComparisonAttachment, ArtifactCsvComparisonPage, ArtifactCsvComparisonQuestionFacts,
} from '@agentrans/artifact-followup/types'
import { createSnapshotStore } from '@agentrans/client-store'
import { sameCsvSentQuestion, type CsvSentQuestion } from './csv-comparison-draft.ts'

export type CsvComparisonExplanation = NonNullable<ArtifactCsvComparisonQuestionFacts['explanation']>
export type CsvExplanationFailure = 'incompatible' | 'too-large' | 'failed'

export interface CsvExplanationPreview {
  readonly page: ArtifactCsvComparisonPage
  readonly explanation: CsvComparisonExplanation
  readonly replacesContext: boolean
}

type CsvExplanationPair = { readonly first: CsvSentQuestion; readonly second: CsvSentQuestion }
type CsvExplanationReview = CsvExplanationPair & { readonly phase: 'review' | 'saving'; readonly preview: CsvExplanationPreview }
export type CsvExplanationSelection = { readonly phase: 'first'; readonly first: CsvSentQuestion }
  | (CsvExplanationPair & ({ readonly phase: 'loading' } | { readonly phase: 'error'; readonly failure: CsvExplanationFailure }))
  | CsvExplanationReview

interface CsvExplanationCommands {
  readonly current: () => boolean
  readonly replacesContext: boolean
  readonly review: (first: CsvSentQuestion, second: CsvSentQuestion) => Promise<ArtifactCsvComparisonAttachment | CsvExplanationFailure>
  readonly save: (attachment: ArtifactCsvComparisonAttachment) => Promise<boolean>
}

/** One transient selection shared by all eligible comparison cards in a Session. */
export class CsvExplanationSelectionOwner {
  readonly state = createSnapshotStore<CsvExplanationSelection | undefined>(undefined)
  private review: { readonly state: CsvExplanationReview; readonly save: () => Promise<boolean> } | undefined

  clear(): void {
    this.review = undefined
    this.state.set(undefined)
  }

  async select(target: CsvSentQuestion, commands: CsvExplanationCommands): Promise<void> {
    const previous = this.state.getSnapshot()
    if (!commands.current() || previous?.phase === 'saving') return
    this.review = undefined
    if (sameCsvSentQuestion(previous?.first, target)) { this.clear(); return }
    if (previous === undefined) { this.state.set({ phase: 'first', first: target }); return }
    const { first } = previous
    const pair = { first, second: target }
    const loading = { ...pair, phase: 'loading' } as const
    this.state.set(loading)
    const result = await commands.review(first, target)
    if (this.state.getSnapshot() !== loading) return
    if (!commands.current()) { this.clear(); return }
    if (typeof result === 'string') { this.state.set({ ...pair, phase: 'error', failure: result }); return }
    const { explanation, comparison } = result.facts
    const matches = (aggregation: CsvSentQuestion, filtering: CsvSentQuestion): boolean =>
      sameCsvSentQuestion(explanation?.aggregation.message, aggregation) && sameCsvSentQuestion(explanation?.filtering, filtering)
    if (explanation === undefined || (!matches(first, target) && !matches(target, first))) {
      this.state.set({ ...pair, phase: 'error', failure: 'failed' })
      return
    }
    const state = { ...pair, phase: 'review', preview: { page: comparison, explanation, replacesContext: commands.replacesContext } } as const
    this.review = { state, save: async () => commands.current() && await commands.save(result) }
    this.state.set(state)
  }

  async confirm(target: CsvSentQuestion): Promise<void> {
    const review = this.review
    if (review === undefined || review.state !== this.state.getSnapshot() || !sameCsvSentQuestion(review.state.second, target)) return
    const saving = { ...review.state, phase: 'saving' } as const
    this.state.set(saving)
    const saved = await review.save().catch(() => false)
    if (this.state.getSnapshot() !== saving) return
    if (saved) this.clear()
    else {
      this.review = undefined
      this.state.set({ first: saving.first, second: saving.second, phase: 'error', failure: 'failed' })
    }
  }
}
