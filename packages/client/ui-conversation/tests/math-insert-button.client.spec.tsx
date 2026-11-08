// @vitest-environment jsdom
/** The composer's formula entry: one button that inserts an island. */
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { MathInsertButton } from '../src/client/skeleton/MathInsertButton.tsx'

afterEach(cleanup)

it('names itself from the locale seat and inserts on click', () => {
  const insert = vi.fn()
  const seen: string[] = []
  const { getByRole } = render(
    <MathInsertButton
      insert={insert}
      t={(key) => { seen.push(key); return key === 'input.formula' ? 'Insert formula' : key }}
    />,
  )
  const button = getByRole('button', { name: 'Insert formula' })
  expect(seen).toContain('input.formula')
  fireEvent.click(button)
  expect(insert).toHaveBeenCalledTimes(1)
})
