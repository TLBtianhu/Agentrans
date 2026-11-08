// @vitest-environment jsdom
/** The formula island's edit session: activate, type, commit, leave. */
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, onTestFinished } from 'vitest'
import { $getNodeByKey, $getRoot, $createParagraphNode, createEditor } from 'lexical'
import { MathNode, $createMathNode } from '../src/client/input/editor/math-node.tsx'
import { MathIsland } from '../src/client/input/editor/MathIsland.tsx'

afterEach(cleanup)

const LABELS = { edit: 'Edit formula', placeholder: 'Type a TeX formula' }

/**
 * Build an editor holding one island.
 * @param latex - initial source.
 * @returns the editor and the island's node key.
 */
function fixture(latex: string) {
  const editor = createEditor({ namespace: 'math-island-spec', nodes: [MathNode], onError: (error) => { throw error } })
  onTestFinished(() => { editor.setRootElement(null) })
  let key = ''
  editor.update(() => {
    const paragraph = $createParagraphNode()
    const node = $createMathNode(latex)
    key = node.getKey()
    paragraph.append(node)
    $getRoot().append(paragraph)
  }, { discrete: true })
  return { editor, key }
}

/**
 * Read the island's current source.
 * @param editor - owning editor.
 * @param key - node key.
 * @returns the TeX source.
 */
function latexOf(editor: ReturnType<typeof createEditor>, key: string): string {
  return editor.getEditorState().read(() => {
    const node = $getNodeByKey(key)
    if (!(node instanceof MathNode)) throw new Error('expected an island')
    return node.getLatex()
  })
}

it('shows typeset math until activated', () => {
  const { editor, key } = fixture('x^2')
  const { container } = render(<MathIsland editor={editor} nodeKey={key} latex="x^2" labels={LABELS} />)
  expect(container.querySelector('.katex')).not.toBeNull()
  expect(container.querySelector('[data-math-island-input]')).toBeNull()
})

it('shows the placeholder while the source is empty', () => {
  const { editor, key } = fixture('')
  const { getByText } = render(<MathIsland editor={editor} nodeKey={key} latex="" labels={LABELS} />)
  expect(getByText(LABELS.placeholder)).toBeTruthy()
})

it('commits the typed source on blur', async () => {
  const { editor, key } = fixture('a')
  const { container } = render(<MathIsland editor={editor} nodeKey={key} latex="a" labels={LABELS} />)
  fireEvent.click(container.querySelector('[data-math-island]')!)
  const input = container.querySelector('[data-math-island-input]') as HTMLInputElement
  expect(input.value).toBe('a')
  fireEvent.change(input, { target: { value: 'a+b' } })
  fireEvent.blur(input)
  await new Promise((resolve) => { setTimeout(resolve, 0) })
  expect(latexOf(editor, key)).toBe('a+b')
})

it('commits on Escape and on Enter without letting Enter reach the submit gesture', async () => {
  const { editor, key } = fixture('a')
  const { container } = render(<MathIsland editor={editor} nodeKey={key} latex="a" labels={LABELS} />)
  fireEvent.click(container.querySelector('[data-math-island]')!)
  const input = container.querySelector('[data-math-island-input]') as HTMLInputElement
  fireEvent.change(input, { target: { value: 'b' } })
  expect(fireEvent.keyDown(input, { key: 'Escape' })).toBe(false)
  await new Promise((resolve) => { setTimeout(resolve, 0) })
  expect(latexOf(editor, key)).toBe('b')

  fireEvent.click(container.querySelector('[data-math-island]')!)
  const again = container.querySelector('[data-math-island-input]') as HTMLInputElement
  fireEvent.change(again, { target: { value: 'c' } })
  expect(fireEvent.keyDown(again, { key: 'Enter' })).toBe(false)
  await new Promise((resolve) => { setTimeout(resolve, 0) })
  expect(latexOf(editor, key)).toBe('c')
})
