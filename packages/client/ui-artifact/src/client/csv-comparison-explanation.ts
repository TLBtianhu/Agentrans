import type {
  ArtifactCsvComparisonAttachment, ArtifactCsvComparisonPage, ArtifactCsvComparisonQuestionFacts,
} from '@agentrans/artifact-followup/types'
import { createSnapshotStore } from '@agentrans/client-store'
import { sameCsvSentQuestion, type CsvSentQuestion } from './csv-comparison-draft.ts'

/** Aggregation and filtering steps recorded on a two-step comparison. */
export type CsvComparisonExplanation = NonNullable<ArtifactCsvComparisonQuestionFacts['explanation']>
/** Why reviewing a selected pair failed: incompatible pages, a sealed result above the byte limit, or another failure. */
export type CsvExplanationFailure = 'incompatible' | 'too-large' | 'failed'

/** Reviewed filtering page, both recorded steps, and whether confirming replaces the current question context. */
export interface CsvExplanationPreview {
  readonly page: ArtifactCsvComparisonPage
  readonly explanation: CsvComparisonExplanation
  readonly replacesContext: boolean
}

type CsvExplanationPair = { readonly first: CsvSentQuestion; readonly second: CsvSentQuestion }
type CsvExplanationReview = CsvExplanationPair & { readonly phase: 'review' | 'saving'; readonly preview: CsvExplanationPreview }
/** Progress of choosing two sent comparisons: first pick, review loading or failure, review, or saving. */
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
  /** Current selection progress, or `undefined` when no comparison is selected. */
  readonly state = createSnapshotStore<CsvExplanationSelection | undefined>(undefined)
  private review: { readonly state: CsvExplanationReview; readonly save: () => Promise<boolean> } | undefined

  /** Abandon the selection and any review awaiting confirmation. */
  clear(): void {
    this.review = undefined
    this.state.set(undefined)
  }

  /**
   * Pick the first comparison, deselect it, or pick the second and request a Host review of the pair.
   * @param target - Sent comparison the user chose.
   * @param commands - Session-scoped liveness check, context replacement flag, review and save operations.
   */
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

  /**
   * Save the reviewed pair as the next question draft; a failed save returns the pair to the error phase.
   * @param target - Second comparison of the reviewed pair, confirming the review shown on it.
   */
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
