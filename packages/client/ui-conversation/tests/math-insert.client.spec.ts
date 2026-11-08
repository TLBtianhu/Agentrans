// @vitest-environment jsdom
/** Inserting a formula island from the composer's entry point. */
import { expect, it, onTestFinished } from 'vitest'
import { $getNodeByKey, $getRoot, $isElementNode } from 'lexical'
import { DraftEditorRuntime } from '../src/client/input/editor/runtime.ts'
import { $isMathNode } from '../src/client/input/editor/math-node.tsx'

/**
 * Build one runtime bound to a detached contenteditable host.
 * @returns the runtime and its editor.
 */
function fixture() {
  const root = document.createElement('div')
  root.setAttribute('contenteditable', 'true')
  document.body.append(root)
  onTestFinished(() => { root.remove() })
  const runtime: DraftEditorRuntime = new DraftEditorRuntime({
    onUpdate: () => { runtime.refreshProjection() },
    quoteLabels: () => ({ remove: 'Remove quote' }),
    mathLabels: () => ({ edit: 'Edit formula', placeholder: 'Type a TeX formula' }),
    openReference: () => false,
    lexicon: () => new Map(), resolveLexicon: () => undefined,
  })
  const dispose = runtime.register()
  const { editor } = runtime
  onTestFinished(() => { dispose(); editor.setRootElement(null) })
  editor.setRootElement(root)
  return { runtime, editor }
}

it('inserts one empty island and projects it as an atomic detect character', () => {
  const { runtime, editor } = fixture()
  expect(runtime.insertMath({ edit: 'Edit formula', placeholder: 'Type a TeX formula' })).toBe(true)
  const projection = runtime.projection
  // The island carries no text until it has a source, so the clipboard
  // projection holds only the trailing space the insertion adds for the caret.
  expect(projection.clipboardText).toBe(' ')
  expect(projection.detectText).toBe('\uFFFC ')
  const found = editor.getEditorState().read(() => {
    const block = $getRoot().getFirstChild()
    if (block === null || !$isElementNode(block)) return false
    return block.getChildren().some(child => $isMathNode(child))
  })
  expect(found).toBe(true)
})

it('writes the source back in place and projects it as TeX', () => {
  const { runtime, editor } = fixture()
  runtime.insertMath({ edit: '', placeholder: '' })
  const key = editor.getEditorState().read(() => {
    const block = $getRoot().getFirstChild()
    if (block === null || !$isElementNode(block)) throw new Error('expected a block')
    const child = block.getFirstChild()
    if (child === null) throw new Error('expected an island')
    return child.getKey()
  })
  editor.update(() => {
    const node = $getNodeByKey(key)
    if (!$isMathNode(node)) throw new Error('expected an island')
    node.setLatex('x^2')
  }, { discrete: true })
  runtime.refreshProjection()
  const projection = runtime.projection
  expect(projection.clipboardText).toBe('$x^2$ ')
  expect(projection.detectText).toBe('\uFFFC ')
})
