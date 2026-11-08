// @vitest-environment jsdom
/** One formula island: node contract and composer projections. */
import { describe, expect, it } from 'vitest'
import { $getRoot, $createParagraphNode, $createTextNode, createEditor } from 'lexical'
import { $composerLayout } from '../src/client/input/editor/projection.ts'
import {
  $createMathNode, $isMathNode, MathNode,
} from '../src/client/input/editor/math-node.tsx'

/**
 * Run one editor update against a fresh editor.
 * @param run - update body, run inside the editor's update.
 * @returns the update body's answer.
 */
function inEditor<T>(run: () => T): T {
  let answer!: T
  const editor = createEditor({ namespace: 'math-node-spec', nodes: [MathNode], onError: (error) => { throw error } })
  editor.update(() => { answer = run() }, { discrete: true })
  return answer
}

describe('MathNode', () => {
  it('keeps the TeX source and projects it as inline delimiters', () => {
    const text = inEditor(() => $createMathNode('x^2').getTextContent())
    expect(text).toBe('$x^2$')
  })

  it('projects an empty island as nothing, so no display fence enters the message', () => {
    const text = inEditor(() => $createMathNode('').getTextContent())
    expect(text).toBe('')
  })

  it('round-trips through the serialized form, keeping the reserved identity', () => {
    const restored = inEditor(() => {
      const json = $createMathNode('a+b', 'm1').exportJSON()
      const node = MathNode.importJSON(json)
      return { json, latex: node.getLatex(), id: node.getId() }
    })
    expect(restored.json).toMatchObject({ type: 'math', version: 1, latex: 'a+b', id: 'm1' })
    expect(restored.latex).toBe('a+b')
    expect(restored.id).toBe('m1')
  })

  it('omits an absent identity rather than persisting an empty one', () => {
    const json = inEditor(() => $createMathNode('a').exportJSON())
    expect(json).not.toHaveProperty('id')
  })

  it('replaces the source without replacing the node identity', () => {
    const identity = inEditor(() => {
      const node = $createMathNode('a')
      const key = node.getKey()
      node.setLatex('b')
      return { key, same: node.getKey() === key, latex: node.getLatex() }
    })
    expect(identity.same).toBe(true)
    expect(identity.latex).toBe('b')
  })

  it('clones with identity and narrows by type', () => {
    const answer = inEditor(() => {
      const node = $createMathNode('a')
      const clone = MathNode.clone(node)
      return { sameKey: clone.getKey() === node.getKey(), isMath: $isMathNode(node), textIsMath: $isMathNode($createTextNode('t')) }
    })
    expect(answer.sameKey).toBe(true)
    expect(answer.isMath).toBe(true)
    expect(answer.textIsMath).toBe(false)
  })
})

describe('composer projections with a formula island', () => {
  it('counts one atomic character in the detect projection and the TeX in the clipboard projection', () => {
    const layout = inEditor(() => {
      const root = $getRoot()
      const paragraph = $createParagraphNode()
      paragraph.append($createTextNode('设 '), $createMathNode('x^2'), $createTextNode(' 为平方'))
      root.append(paragraph)
      return $composerLayout()
    })
    expect(layout.clipboardText).toBe('设 $x^2$ 为平方')
    expect(layout.detectText).toBe('设 \uFFFC 为平方')
  })
})
