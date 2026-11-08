/**
 * MathNode: one inline formula island as an atomic Lexical decorator.
 *
 * The node owns the TeX source; `getTextContent()` answers the clipboard and
 * persistence projection (`$tex$`), which is also exactly what the model reads
 * because a formula carries no owner codec. The rendered formula is a
 * projection of the source, never a stored image: a formula that cannot be
 * selected, searched, or edited out is the failure this node exists to avoid.
 */
import type { JSX } from 'react'
import type {
  EditorConfig, LexicalEditor, LexicalNode, NodeKey, SerializedLexicalNode, Spread,
} from 'lexical'
import { DecoratorNode } from 'lexical'
import { MathIsland } from './MathIsland.tsx'
import type { MathNodeLabels } from './MathIsland.tsx'

/** Localized chrome applied by the owning input shell (never persisted). */
export type { MathNodeLabels }

/** Labels used before the shell's transaction runs (imported states, tests). */
const EMPTY_LABELS: MathNodeLabels = { edit: '', placeholder: '' }

/** JSON form of one formula island (Lexical node serialization contract). */
export type SerializedMathNode = Spread<{
  /** TeX source; the document projection is `$tex$`. */
  latex: string
  /**
   * Reserved identity for a later "select this formula and ask about it"
   * workflow. Absent means the island is a plain run of text today, and a
   * draft written now stays readable when identities arrive.
   */
  id?: string
}, SerializedLexicalNode>

/** One inline formula occurrence as an atomic decorator node. */
export class MathNode extends DecoratorNode<JSX.Element> {
  /** TeX source. */
  __latex: string
  /** Reserved stable identity; undefined until formulas become addressable. */
  __id: string | undefined
  /** Localized chrome; replaced by the shell's node transform. */
  __labels: MathNodeLabels = EMPTY_LABELS

  /** @param latex - initial TeX source. @param id - reserved identity. @param key - Lexical node key. */
  constructor(latex = '', id?: string, key?: NodeKey) {
    super(key)
    this.__latex = latex
    this.__id = id
  }

  /** Lexical node registry type tag. */
  static override getType(): string {
    return 'math'
  }

  /**
   * Clone with identity (Lexical writable-copy contract).
   * @param node - node to clone.
   * @returns a copy carrying the same NodeKey.
   */
  static override clone(node: MathNode): MathNode {
    return new MathNode(node.__latex, node.__id, node.__key)
  }

  /**
   * Rebuild a node from its serialized form.
   * @param json - stored node JSON.
   * @returns the node.
   */
  static override importJSON(json: SerializedMathNode): MathNode {
    return new MathNode(json.latex, json.id)
  }

  /** Serialize to the JSON node form. */
  override exportJSON(): SerializedMathNode {
    return {
      ...super.exportJSON(),
      type: 'math',
      version: 1,
      latex: this.__latex,
      ...(this.__id === undefined ? {} : { id: this.__id }),
    }
  }

  /**
   * Mount the island's host element; the decorator portal renders into it.
   * @returns an inline, non-editable span carrying the test anchor.
   */
  override createDOM(_config: EditorConfig): HTMLElement {
    const el = document.createElement('span')
    el.setAttribute('data-composer-math', '')
    el.setAttribute('contenteditable', 'false')
    return el
  }

  /** Host element never changes shape. */
  override updateDOM(): boolean {
    return false
  }

  /** Islands sit in the text line. */
  override isInline(): boolean {
    return true
  }

  /**
   * Arrows step across the island in one move and Backspace removes it whole.
   * A keyboard-selected node state would sit between the keystroke and the
   * caret, which the plain-text binding's handlers do not own.
   */
  override isKeyboardSelectable(): boolean {
    return false
  }

  /**
   * Clipboard, draft, and model projection.
   *
   * An empty island projects to nothing: `$$` would read as a display-math
   * fence in the message Markdown and change how the rest of the line parses.
   */
  override getTextContent(): string {
    return this.__latex === '' ? '' : `$${this.__latex}$`
  }

  /** Current TeX source. */
  getLatex(): string {
    return this.getLatest().__latex
  }

  /**
   * Replace the TeX source in place; the node key survives so the caret and
   * the undo stack keep working.
   * @param latex - next TeX source.
   */
  setLatex(latex: string): void {
    this.getWritable().__latex = latex
  }

  /** Reserved identity, once set. */
  getId(): string | undefined {
    return this.getLatest().__id
  }

  /**
   * Replace the localized chrome; the shell's transform applies it. The write
   * happens only when a label actually changed, because `getWritable()` dirties
   * the node and would re-trigger the transform that called this.
   * @param labels - current labels.
   */
  setLabels(labels: MathNodeLabels): void {
    const latest = this.getLatest().__labels
    if (latest.edit !== labels.edit || latest.placeholder !== labels.placeholder) {
      this.getWritable().__labels = labels
    }
  }

  /** React face rendered into the host element by the decorator portal. */
  override decorate(editor: LexicalEditor): JSX.Element {
    return (
      <MathIsland
        editor={editor}
        nodeKey={this.__key}
        latex={this.__latex}
        labels={this.__labels}
      />
    )
  }
}

/**
 * Create one formula island.
 * @param latex - initial TeX source.
 * @param id - reserved identity for a later addressable-formula workflow.
 * @returns the node.
 */
export function $createMathNode(latex = '', id?: string): MathNode {
  return new MathNode(latex, id)
}

/**
 * Narrow a node to a formula island.
 * @param node - candidate node.
 * @returns whether the node is a MathNode.
 */
export function $isMathNode(node: LexicalNode | null | undefined): node is MathNode {
  return node instanceof MathNode
}
