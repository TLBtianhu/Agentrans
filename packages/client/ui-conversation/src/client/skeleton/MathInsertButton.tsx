/**
 * The composer's formula entry: one control that inserts an empty formula
 * island at the caret.
 *
 * The island itself lives in the editor, so this control only owns the
 * gesture and its accessible name. Discoverability matters more than
 * cleverness here: a keyboard shortcut alone leaves touch and first-time users
 * with no way in.
 */
import type { JSX } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'

/** Data the slot injects: the insertion verb bound to this session's composer. */
export interface MathInsertInjected {
  /** Insert one empty island at the caret. */
  readonly insert: () => void
}

/** Full props of the control. */
export type MathInsertButtonProps = MathInsertInjected & PropsLocale<'conversation'>

/**
 * Render the formula entry.
 * @param props - insertion verb and locale seat.
 * @returns one icon button.
 */
export function MathInsertButton({ insert, t }: MathInsertButtonProps): JSX.Element {
  return (
    <Button
      variant="ghost"
      size="sm"
      aria-label={t('input.formula')}
      title={t('input.formula')}
      onClick={() => { insert() }}
    >
      <span aria-hidden>∑</span>
    </Button>
  )
}
