// @vitest-environment jsdom
/** Inline TeX primitive: one formula rendered outside a Markdown document. */
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { InlineTex } from '@deepseek-ai/dsh-client-ui-primitives'

afterEach(cleanup)

describe('InlineTex', () => {
  it('renders one formula as an inline span', () => {
    const { container } = render(<InlineTex tex="x^2" />)
    const host = container.querySelector('[data-inline-tex]')
    expect(host).not.toBeNull()
    expect(host?.querySelector('.katex')).not.toBeNull()
    expect(container.querySelector('.katex-display')).toBeNull()
  })

  it('renders display mode when asked', () => {
    const { container } = render(<InlineTex tex="a+b" display />)
    expect(container.querySelector('.katex-display')).not.toBeNull()
  })

  it('shows the error treatment for unparseable source instead of throwing', () => {
    const { container } = render(<InlineTex tex="\\frac{1" />)
    expect(container.querySelector('.katex-error')).not.toBeNull()
  })
})
