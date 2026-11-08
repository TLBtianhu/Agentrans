/**
 * Inline TeX rendering for surfaces that are not Markdown documents.
 *
 * `MarkdownText` owns whole documents, so its block wrapper cannot be dropped
 * into a line of composer text. This primitive renders one formula as an
 * inline span through the same KaTeX path, keeping a formula written in the
 * composer identical to the same formula in a sent message.
 */
import 'katex/dist/katex.min.css'
import type { ReactNode } from 'react'
import { renderTexToReact } from './katex.tsx'

/** Props for one inline formula. */
export interface InlineTexProps {
  /** TeX source, without delimiters. */
  readonly tex: string
  /** Display (block) versus inline layout. */
  readonly display?: boolean
}

/**
 * Render one TeX formula as an inline element.
 * @param props - TeX source and layout mode.
 * @returns the KaTeX element tree wrapped in an inline span.
 */
export function InlineTex({ tex, display = false }: InlineTexProps): ReactNode {
  return (
    <span className="dsh-inline-tex" data-inline-tex="">
      {renderTexToReact(tex, display)}
    </span>
  )
}
