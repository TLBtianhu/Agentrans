/** Typed framework-hook stand-ins for Artifact component specs that render outside the slot renderer. */
import { allowAllAccess } from '@agentrans/client-test-runtime'
import type { GlobalStandardProps, SessionStandardProps } from '@agentrans/client-ui-slots'
import type { SessionId } from '@agentrans/session/types'
import type { ComponentProps } from 'react'
import type { ArtifactPromptContextDock, ArtifactPromptContextInjected } from '../src/client/ArtifactPromptContext.tsx'
import type { CsvComparisonDraftPhase, CsvSentQuestion } from '../src/client/csv-comparison-draft.ts'
import type { CsvComparisonContextInjected } from '../src/client/QuestionContextMessage.tsx'

const unused = (): never => { throw new Error('This isolated component does not consume this framework hook') }

/**
 * Global and Session standard props whose hooks fail loudly when a spec reaches one it did not provide.
 * @param sessionId - Session the rendered component belongs to.
 * @returns A complete standard kit for direct component rendering; access hooks allow every action.
 */
export function sessionStandardProps(sessionId: SessionId): GlobalStandardProps & SessionStandardProps {
  return {
    ...allowAllAccess,
    usePanelInfo: unused, useSessions: unused, useSessionStatus: unused, useSessionRetainInfo: unused,
    useResource: unused, useWorkspaces: unused, useContextMenu: unused,
    sessionId, useSession: unused, useProjection: unused, useConversation: unused,
    useInput: unused, useChat: unused, useTrajectory: unused,
    inputActions: { insertQuote: () => false, captureInsertion: unused, insertText: unused, setDraft: unused, persistDraft: unused,
      addAttachments: unused, removeAttachment: unused, pruneAttachments: unused, submit: unused },
  }
}

/**
 * Bind a fixed value to a selector hook.
 * @param value - State every selector reads.
 * @returns A hook applying its selector to the fixed state.
 */
export function selectorOf<T>(value: T): <S>(select: (state: T) => S) => S {
  return select => select(value)
}

/** Return-to-draft state for a composer that has no accepted question to return from. */
export const noCsvReturnTarget = selectorOf<CsvSentQuestion | undefined>(undefined)

/**
 * Comparison-draft phase state read by history cards.
 * @param phase - Phase the history card observes.
 * @returns A selector hook over that fixed phase.
 */
export function csvDraftPhase(phase: CsvComparisonDraftPhase): <S>(select: (state: CsvComparisonDraftPhase) => S) => S {
  return selectorOf(phase)
}

/**
 * Comparison-history callbacks that fail loudly unless a spec overrides the one it exercises.
 * @returns Every injected history-card callback.
 */
export function csvContextCallbacks(): Omit<CsvComparisonContextInjected, 'hooks'> {
  return {
    returnToCsvDraft: unused, visitCsvComparisonSource: unused, clearCsvComparisonSourceVisit: unused,
    returnFromCsvComparisonSource: unused, jumpInSourceTrail: unused, sourceQuestionLabel: unused,
    loadCsvHistorySourceChain: unused, visitCsvHistorySourceChain: unused, retryCsvSourceRecovery: unused,
    reviewSentCsvComparison: unused, selectCsvExplanationStep: unused, cancelCsvExplanation: unused,
    confirmCsvExplanation: unused, downloadSentCsvComparison: unused,
  }
}

/**
 * Composer-dock callbacks that fail loudly unless a spec overrides the one it exercises, over an empty plain draft.
 * @returns Every injected prompt-context callback and the owner input state.
 */
export function promptDockDefaults(): Omit<ArtifactPromptContextInjected, 'hooks'> & { readonly input: ComponentProps<typeof ArtifactPromptContextDock>['input'] } {
  return {
    input: { phase: 'plain', draft: '', draftRev: 0, attachmentIds: [], occurrences: [], queue: [] },
    restoreCsvComparisonDraft: unused, loadCsvComparisonImport: unused, retryCsvComparisonDraftCleanup: unused,
    dismissCsvComparisonDraftOutcome: unused, selectCsvSentQuestion: unused, visitCsvDraftSource: unused,
    visitCsvDraftReturn: unused, loadCsvSourceChain: unused, visitCsvDraftSourceChain: unused,
    sourceQuestionLabel: unused, restoreCsvSourceTrail: unused, retryCsvSourceRecovery: unused,
    retryFunctionPlotDraft: unused, clearArtifactPromptContext: unused,
  }
}

/**
 * Composer input actions with only the overridden members usable.
 * @param overrides - Actions the spec exercises.
 * @returns A complete action set whose other members fail loudly.
 */
export function inputActionsWith(overrides: Partial<SessionStandardProps['inputActions']>): SessionStandardProps['inputActions'] {
  return { ...sessionStandardProps('artifact-spec-session' as SessionId).inputActions, ...overrides }
}
