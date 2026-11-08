/**
 * The visible face of one formula island.
 *
 * An island renders as typeset math until the user activates it, then as a
 * plain TeX field. Rendering the formula is a projection of the stored source,
 * so copy, undo, and the sent message all read the same TeX.
 */
import type { LexicalEditor, NodeKey } from 'lexical'
import type { JSX } from 'react'
import { useState } from 'react'
import { InlineTex } from '@deepseek-ai/dsh-client-ui-primitives'
import { $getNodeByKey } from 'lexical'
import { $isMathNode } from './math-node.tsx'

/**
 * Localized chrome for the island.
 */
export interface MathNodeLabels {
  /** Accessible name of the editable island. */
  readonly edit: string
  /** Shown while the source is empty. */
  readonly placeholder: string
}

/**
 * Render one formula island and own its edit session.
 * @param props - owning editor, node key, TeX source, and localized labels.
 * @returns typeset math, or a TeX field while editing.
 */
export function MathIsland({ editor, nodeKey, latex, labels }: {
  readonly editor: LexicalEditor
  readonly nodeKey: NodeKey
  readonly latex: string
  readonly labels: MathNodeLabels
}): JSX.Element {
  const [draft, setDraft] = useState<string | null>(null)

  const commit = (next: string): void => {
    editor.update(() => {
      const node = $getNodeByKey(nodeKey)
      if ($isMathNode(node)) node.setLatex(next)
    })
    setDraft(null)
  }

  if (draft !== null) {
    return (
      <input
        className="dsh-math-island-input"
        data-math-island-input=""
        aria-label={labels.edit}
        value={draft}
        autoFocus
        onChange={(event) => { setDraft(event.target.value) }}
        onBlur={() => { commit(draft) }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            commit(draft)
          }
          // Enter belongs to the field, never to the message submit gesture.
          if (event.key === 'Enter') {
            event.preventDefault()
            commit(draft)
          }
        }}
      />
    )
  }

  return (
    <button
      type="button"
      className="dsh-math-island"
      data-math-island=""
      aria-label={labels.edit}
      onClick={() => { setDraft(latex) }}
    >
      {latex === ''
        ? <span className="dsh-math-island-placeholder">{labels.placeholder}</span>
        : <InlineTex tex={latex} />}
    </button>
  )
}
