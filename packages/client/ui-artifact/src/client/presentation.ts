/** Session-scoped Artifact presentation: one detached surface per Artifact, one dock and one float per Session. */
import { defineStore } from '@deepseek-ai/dsh-client-store'
import type { ArtifactId } from '@deepseek-ai/dsh-artifact/types'

/** One Artifact docked beside the conversation. */
export interface ArtifactDockEntry {
  readonly artifactId: ArtifactId
  readonly revision: number
  readonly title: string
}

/** Detached Artifact surfaces owned by one Session. */
export interface ArtifactPresentationState {
  docks: ArtifactDockEntry[]
  activeDockId: ArtifactId | null
  floatId: ArtifactId | null
  focusId: ArtifactId | null
}

function dropDock(draft: ArtifactPresentationState, artifactId: ArtifactId): void {
  const index = draft.docks.findIndex(entry => entry.artifactId === artifactId)
  if (index < 0) return
  draft.docks.splice(index, 1)
  if (draft.activeDockId !== artifactId) return
  // Closing the active tab selects its neighbour rather than a random tab.
  draft.activeDockId = draft.docks[index]?.artifactId ?? draft.docks[index - 1]?.artifactId ?? null
}

/**
 * Presentation write set. Rules live here rather than in toolbar handlers:
 * one detached surface per Artifact, one dock list with a single active tab,
 * one float, and one focus per Session.
 */
export const artifactPresentationStore = defineStore({
  init: (): ArtifactPresentationState => ({ docks: [], activeDockId: null, floatId: null, focusId: null }),
  actions: {
    /** Dock an Artifact beside the conversation and make it the active tab. */
    dock(draft, entry: ArtifactDockEntry) {
      if (draft.floatId === entry.artifactId) draft.floatId = null
      if (draft.focusId === entry.artifactId) draft.focusId = null
      const index = draft.docks.findIndex(candidate => candidate.artifactId === entry.artifactId)
      if (index < 0) draft.docks.push(entry)
      else draft.docks[index] = entry
      draft.activeDockId = entry.artifactId
    },
    /** Remove one docked Artifact; the active tab moves to its neighbour. */
    undock(draft, artifactId: ArtifactId) { dropDock(draft, artifactId) },
    /** Bring an already docked Artifact to the front without duplicating its tab. */
    activateDock(draft, artifactId: ArtifactId) {
      if (draft.docks.some(entry => entry.artifactId === artifactId)) draft.activeDockId = artifactId
    },
    /** Float an Artifact; only one floating pane exists per Session. */
    float(draft, artifactId: ArtifactId) {
      dropDock(draft, artifactId)
      if (draft.focusId === artifactId) draft.focusId = null
      draft.floatId = artifactId
    },
    /** Expand an Artifact over the window; only one expanded view exists per Session. */
    focus(draft, artifactId: ArtifactId) {
      dropDock(draft, artifactId)
      if (draft.floatId === artifactId) draft.floatId = null
      draft.focusId = artifactId
    },
    /** Return an Artifact to the conversation flow and release every surface it owned. */
    inline(draft, artifactId: ArtifactId) {
      dropDock(draft, artifactId)
      if (draft.floatId === artifactId) draft.floatId = null
      if (draft.focusId === artifactId) draft.focusId = null
    },
    /** Refresh a docked tab's checkpoint metadata without changing which tab is active. */
    syncDock(draft, entry: ArtifactDockEntry) {
      const index = draft.docks.findIndex(candidate => candidate.artifactId === entry.artifactId)
      if (index >= 0) draft.docks[index] = entry
    },
  },
})
