/** DOM selection validation and visible-text projection, independent of business actions. */
import { isSessionInquiry, SESSION_INQUIRY_MAX_LENGTH, type SessionInquiry } from '@agentrans/session/types'

const PROJECTED_BLOCK_TAGS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DIV', 'DL', 'DT', 'FIGCAPTION',
  'FIGURE', 'FOOTER', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'LI', 'MAIN',
  'NAV', 'OL', 'P', 'PRE', 'SECTION', 'TABLE', 'TBODY', 'TFOOT', 'THEAD', 'TR', 'UL',
])
const PROJECTED_CELL_TAGS = new Set(['TD', 'TH'])

function excluded(element: Element): boolean {
  if (element.matches('.katex-mathml, [data-text-interaction-exclude], [hidden], .sr-only')) return true
  if (element.matches('[aria-hidden="true"]') && !element.matches('.katex-html')) return true
  return element.tagName === 'BUTTON' && element.parentElement?.tagName !== 'CODE'
}

function projectedBoundary(node: Node): '\n' | '\t' | '' {
  if (!(node instanceof Element)) return ''
  if (PROJECTED_CELL_TAGS.has(node.tagName)) return '\t'
  return PROJECTED_BLOCK_TAGS.has(node.tagName) ? '\n' : ''
}

function projectedSeparator(previous: Node, current: Node): '\n' | '\t' | '' {
  const left = projectedBoundary(previous)
  const right = projectedBoundary(current)
  if (left === '\n' || right === '\n') return '\n'
  return left === '\t' || right === '\t' ? '\t' : ''
}

interface ProjectedText {
  readonly text: string
  readonly offsets: readonly number[]
}

function projectedText(node: Text): ProjectedText {
  const source = node.data
  const parent = node.parentElement
  const view = node.ownerDocument.defaultView
  const whiteSpace = parent === null || view === null ? '' : view.getComputedStyle(parent).whiteSpace
  const preservesBreaks = whiteSpace === 'pre' || whiteSpace === 'pre-wrap'
    || whiteSpace === 'pre-line' || whiteSpace === 'break-spaces'
  const offsets = new Array<number>(source.length + 1).fill(0)
  const structuralWhitespace = !preservesBreaks
    && /^[\t\n\f\r ]*$/u.test(source)
    && [node.previousSibling, node.nextSibling].some(
      sibling => sibling !== null && projectedBoundary(sibling) !== '',
    )
  if (structuralWhitespace) return { text: '', offsets }
  let text = ''
  let cursor = 0
  if (!preservesBreaks && node.previousSibling instanceof HTMLElement
    && node.previousSibling.tagName === 'BR' && source.startsWith('\n')) {
    cursor = 1
  }
  while (cursor < source.length) {
    const softBreak = preservesBreaks ? null : /^[ \t]*[\r\n]+[ \t]*/u.exec(source.slice(cursor))
    if (softBreak !== null) {
      const end = cursor + softBreak[0].length
      for (let index = cursor; index < end; index++) offsets[index] = text.length
      text += ' '
      offsets[end] = text.length
      cursor = end
      continue
    }
    offsets[cursor] = text.length
    text += source.charAt(cursor)
    cursor += 1
    offsets[cursor] = text.length
  }
  return { text, offsets }
}

interface ProjectedTextSpan {
  readonly node: Text
  readonly start: number
  readonly offsets: readonly number[]
}

interface ProjectedFragment {
  readonly text: string
  readonly spans: readonly ProjectedTextSpan[]
  readonly boundaries: readonly (readonly [Node, readonly number[]])[]
}

function projectedFragment(node: Node): ProjectedFragment {
  if (node.nodeType === Node.TEXT_NODE) {
    const projected = projectedText(node as Text)
    return {
      text: projected.text,
      spans: projected.offsets.length <= 1
        ? []
        : [{ node: node as Text, start: 0, offsets: projected.offsets }],
      boundaries: [],
    }
  }
  if (!(node instanceof Element)) {
    return { text: '', spans: [], boundaries: [] }
  }
  if (excluded(node)) return { text: '', spans: [], boundaries: [] }
  if (node.tagName === 'BR') return { text: '\n', spans: [], boundaries: [] }
  let text = ''
  let previous: Node | null = null
  const spans: ProjectedTextSpan[] = []
  const boundaries: Array<readonly [Node, readonly number[]]> = []
  const offsets = new Array<number>(node.childNodes.length + 1).fill(0)
  for (const [index, child] of [...node.childNodes].entries()) {
    const fragment = projectedFragment(child)
    if (fragment.text !== '' && previous !== null) {
      const separator = projectedSeparator(previous, child)
      const needsSeparator = separator === '\n'
        ? !text.endsWith('\n') && !fragment.text.startsWith('\n')
        : separator === '\t' && !/[\t\n]$/u.test(text) && !/^[\t\n]/u.test(fragment.text)
      if (needsSeparator) text += separator
    }
    offsets[index] = text.length
    const base = text.length
    text += fragment.text
    for (const span of fragment.spans) {
      spans.push({ node: span.node, start: base + span.start, offsets: span.offsets })
    }
    for (const [owner, childOffsets] of fragment.boundaries) {
      boundaries.push([owner, childOffsets.map(offset => base + offset)])
    }
    if (fragment.text !== '') previous = child
    offsets[index + 1] = text.length
  }
  boundaries.push([node, offsets])
  return { text, spans, boundaries }
}

function projectedOffset(
  projection: ProjectedFragment,
  container: Node,
  offset: number,
): number | null {
  if (container.nodeType === Node.TEXT_NODE) {
    const span = projection.spans.find(candidate => candidate.node === container)
    const projected = span?.offsets[offset]
    return span === undefined || projected === undefined ? null : span.start + projected
  }
  const boundaries = projection.boundaries.find(([owner]) => owner === container)?.[1]
  return boundaries?.[offset] ?? null
}

/** One browser range contained by an enabled text source. */
export interface TextSelection {
  readonly source: HTMLElement
  readonly range: Range
}

/**
 * Find a single noncollapsed selection inside one enabled source.
 * @param root - mounted interaction area.
 * @param selection - browser selection in that area's document.
 * @returns the selected source and range, or null across sources and excluded content.
 */
export function readTextSelection(root: HTMLElement, selection: Selection | null): TextSelection | null {
  if (selection === null || selection.rangeCount !== 1 || selection.isCollapsed) return null
  const range = selection.getRangeAt(0)
  const sourceOf = (node: Node): HTMLElement | null =>
    (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>('[data-text-interaction-source]') ?? null
  const source = sourceOf(range.startContainer)
  if (source === null || source !== sourceOf(range.endContainer) || !root.contains(source)
    || source.closest('[hidden], [inert], [data-text-interaction-exclude]') !== null) return null
  return { source, range }
}

/**
 * Project selected DOM text with visible block boundaries and without renderer chrome.
 * @param selection - range and its source, obtained through readTextSelection.
 * @returns trimmed visible text; empty or excluded selections return null.
 */
export function selectedText(selection: TextSelection): string | null {
  const { source, range } = selection
  const projection = projectedFragment(source)
  const start = projectedOffset(projection, range.startContainer, range.startOffset)
  const end = projectedOffset(projection, range.endContainer, range.endOffset)
  if (start === null || end === null) return null
  const text = projection.text.slice(start, end).trim()
  return text === '' ? null : text
}

/** Exact settled answer and completed Turn boundary selected by a native DOM gesture. */
export interface AssistantInquirySelection {
  readonly atSeq: number
  readonly inquiry: SessionInquiry
}

/** Resolve only literal, contiguous text with known canonical Markdown offsets. */
export function selectedAssistantInquiry(selection: TextSelection): AssistantInquirySelection | null {
  const { source, range } = selection
  const answer = source.closest<HTMLElement>('[data-chat-inquiry-cut]')
  const row = source.closest<HTMLElement>('[data-chat-flow-kind="assistant-step"][data-chat-message-seq][data-chat-message-id]')
  if (answer === null || row === null || !row.contains(answer)) return null
  const atSeq = Number(answer.dataset.chatInquiryCut)
  const messageSeq = Number(row.dataset.chatMessageSeq)
  if (!Number.isSafeInteger(atSeq) || atSeq <= messageSeq) return null
  const projection = projectedFragment(source)
  const first = projectedOffset(projection, range.startContainer, range.startOffset)
  const last = projectedOffset(projection, range.endContainer, range.endOffset)
  if (first === null || last === null) return null
  const visible = projection.text.slice(first, last)
  const excerpt = visible.trim()
  if (excerpt === '' || excerpt.length > SESSION_INQUIRY_MAX_LENGTH) return null
  const begin = first + visible.length - visible.trimStart().length
  const finish = begin + excerpt.length
  let canonicalStart: number | undefined
  let canonicalEnd: number | undefined
  let visited = begin
  for (const span of projection.spans) {
    const start = Math.max(begin, span.start)
    const end = Math.min(finish, span.start + (span.offsets.at(-1) ?? 0))
    if (end <= start) continue
    const mapped = span.node.parentElement
    if (mapped === null || !mapped.hasAttribute('data-markdown-source-start') || !mapped.hasAttribute('data-markdown-source-end')) return null
    const sourceStart = Number(mapped.dataset.markdownSourceStart)
    const sourceEnd = Number(mapped.dataset.markdownSourceEnd)
    const rawStart = span.offsets.indexOf(start - span.start)
    const rawEnd = span.offsets.indexOf(end - span.start)
    if (!Number.isSafeInteger(sourceStart) || sourceStart < 0 || sourceEnd !== sourceStart + span.node.length
      || start !== visited || rawStart < 0 || rawEnd < 0
      || span.node.data.slice(rawStart, rawEnd) !== projection.text.slice(start, end)
      || (canonicalEnd !== undefined && canonicalEnd !== sourceStart + rawStart)) return null
    canonicalStart ??= sourceStart + rawStart
    canonicalEnd = sourceStart + rawEnd
    visited = end
  }
  const inquiry = { messageSeq, messageId: row.dataset.chatMessageId, start: canonicalStart, end: canonicalEnd, excerpt }
  return visited === finish && isSessionInquiry(inquiry) ? { atSeq, inquiry } : null
}
