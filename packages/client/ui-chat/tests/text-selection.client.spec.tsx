// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { MarkdownText } from '@agentrans/client-ui-primitives'
import { readTextSelection, selectedAssistantInquiry, selectedText } from '../src/client/chat/text-selection.ts'

function readSelection(root: HTMLElement, selection: Selection | null) {
  const result = readTextSelection(root, selection)
  return result === null ? null : { text: selectedText(result) }
}

const markdownLabels = {
  code: { copyLabel: 'Copy', copiedLabel: 'Copied' },
  footnotes: 'Footnotes',
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('inquiry selection', () => {
  const messageId = 'a0bacfb1-9411-4230-9791-6bba928892fd'

  function answer(markdown: string, sourceTextOffset = 0) {
    const view = render(<article data-chat-flow-kind="assistant-step" data-chat-message-seq="10" data-chat-message-id={messageId}>
      <div data-chat-inquiry-cut="12">
        <MarkdownText text={markdown} textInteractionSource sourceTextOffset={sourceTextOffset} labels={markdownLabels} />
      </div>
    </article>)
    const source = view.container.querySelector<HTMLElement>('[data-text-interaction-source]')!
    return { source, range: document.createRange() }
  }

  it('identifies the selected repeated occurrence inside rendered emphasis in canonical UTF-16 units', () => {
    const markdown = '🧪 相位差相位差以及 **相位差**。'
    const base = 27
    const selection = answer(markdown, base)
    const target = selection.source.querySelector('strong span')!
    selection.range.selectNodeContents(target)
    const start = base + markdown.lastIndexOf('相位差')
    expect(selectedAssistantInquiry(selection)).toEqual({
      atSeq: 12, inquiry: { messageSeq: 10, messageId, start, end: start + 3, excerpt: '相位差' },
    })
  })

  it('trims selection whitespace without losing the canonical offsets and handles inline code text', () => {
    const markdown = '🧪  precise range   inside a fixture. `offset_2`'
    const selection = answer(markdown)
    const text = selection.source.querySelector('p > span')!.firstChild!
    selection.range.setStart(text, 2)
    selection.range.setEnd(text, markdown.indexOf('inside'))
    expect(selectedAssistantInquiry(selection)?.inquiry).toMatchObject({
      start: markdown.indexOf('precise'), end: markdown.indexOf('range') + 'range'.length, excerpt: 'precise range',
    })
    const code = selection.source.querySelector('code span')!
    selection.range.selectNodeContents(code)
    expect(selectedAssistantInquiry(selection)?.inquiry).toMatchObject({
      start: markdown.indexOf('offset_2'), end: markdown.indexOf('offset_2') + 'offset_2'.length, excerpt: 'offset_2',
    })
  })

  it('does not invent exact anchors for transformed Markdown, renderer chrome or excessive selections', () => {
    const formatted = answer('Read **this** and &amp; carefully.')
    formatted.range.selectNodeContents(formatted.source)
    expect(selectedText(formatted)).toBe('Read this and & carefully.')
    expect(selectedAssistantInquiry(formatted)).toBeNull()
    const oversized = answer('字'.repeat(513))
    oversized.range.selectNodeContents(oversized.source)
    expect(selectedAssistantInquiry(oversized)).toBeNull()
  })
})

describe('quote selection', () => {
  it('extracts one source block and omits Markdown control copy', () => {
    const view = render(
      <div data-chat-flow="">
        <div data-text-interaction-source="">
          <span>Hello </span>
          <button type="button">Copy</button>
          <span>world</span>
        </div>
      </div>,
    )
    const root = view.container.querySelector<HTMLElement>('[data-chat-flow]')!
    const sourceRoot = view.container.querySelector<HTMLElement>('[data-text-interaction-source]')!
    const range = document.createRange()
    range.selectNodeContents(sourceRoot)
    range.getBoundingClientRect = () => ({ left: 10, top: 20, width: 30, height: 10 }) as DOMRect
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    expect(readSelection(root, selection)).toMatchObject({
      text: 'Hello world',
    })
  })

  it('rejects cross-block and pending text selections', () => {
    const view = render(
      <div data-chat-flow="">
        <div data-text-interaction-source="">one</div>
        <span>pending</span>
        <div data-text-interaction-source="">two</div>
      </div>,
    )
    const root = view.container.querySelector<HTMLElement>('[data-chat-flow]')!
    const sources = view.container.querySelectorAll('[data-text-interaction-source]')
    const range = document.createRange()
    range.setStart(sources[0]!.firstChild!, 0)
    range.setEnd(sources[1]!.firstChild!, 3)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    expect(readSelection(root, selection)).toBeNull()
  })

  it('keeps one visible newline for the Markdown hard-break DOM pair', () => {
    const view = render(
      <div data-chat-flow="">
        <div data-text-interaction-source="">
          <span>first</span><br />{'\n'}<span>second</span>
        </div>
      </div>,
    )
    const root = view.container.querySelector<HTMLElement>('[data-chat-flow]')!
    const sourceRoot = view.container.querySelector<HTMLElement>('[data-text-interaction-source]')!
    const range = document.createRange()
    range.selectNodeContents(sourceRoot)
    range.getBoundingClientRect = () => ({ left: 50, top: 60, width: 20, height: 10 }) as DOMRect
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    const candidate = readSelection(root, selection)
    expect(candidate).toMatchObject({
      text: 'first\nsecond',
    })
  })

  it('projects Markdown soft line breaks as visible spaces', () => {
    const view = render(
      <div data-chat-flow="">
        <div data-text-interaction-source=""><p>{'hello\nworld'}</p></div>
      </div>,
    )
    const root = view.container.querySelector<HTMLElement>('[data-chat-flow]')!
    const sourceRoot = view.container.querySelector<HTMLElement>('[data-text-interaction-source]')!
    const range = document.createRange()
    range.selectNodeContents(sourceRoot)
    range.getBoundingClientRect = () => ({ left: 50, top: 60, width: 20, height: 10 }) as DOMRect
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    expect(readSelection(root, selection)).toMatchObject({ text: 'hello world' })

    const text = sourceRoot.querySelector('p')!.firstChild!
    range.setStart(text, 6)
    range.setEnd(text, 11)
    expect(readSelection(root, selection)).toMatchObject({ text: 'world' })
  })

  it('omits code banners while preserving preformatted line breaks', () => {
    const view = render(
      <div data-chat-flow="">
        <div data-text-interaction-source="">
          <div data-text-interaction-exclude="">typescript</div>
          <pre style={{ whiteSpace: 'pre-wrap' }}>{'const x = 1\nreturn x'}</pre>
        </div>
      </div>,
    )
    const root = view.container.querySelector<HTMLElement>('[data-chat-flow]')!
    const sourceRoot = view.container.querySelector<HTMLElement>('[data-text-interaction-source]')!
    const range = document.createRange()
    range.selectNodeContents(sourceRoot)
    range.getBoundingClientRect = () => ({ left: 50, top: 60, width: 20, height: 10 }) as DOMRect
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    expect(readSelection(root, selection)).toMatchObject({ text: 'const x = 1\nreturn x' })
  })

  it('uses one synthetic newline when a hard break has no text-node newline', () => {
    const view = render(
      <div data-chat-flow="">
        <div data-text-interaction-source="">
          <span>first</span><br /><span>second</span>
        </div>
      </div>,
    )
    const root = view.container.querySelector<HTMLElement>('[data-chat-flow]')!
    const sourceRoot = view.container.querySelector<HTMLElement>('[data-text-interaction-source]')!
    const range = document.createRange()
    range.selectNodeContents(sourceRoot)
    range.getBoundingClientRect = () => ({ left: 50, top: 60, width: 20, height: 10 }) as DOMRect
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    const candidate = readSelection(root, selection)
    expect(candidate).toMatchObject({
      text: 'first\nsecond',
    })
  })

  it('preserves visible boundaries between adjacent Markdown blocks', () => {
    const view = render(
      <div data-chat-flow="">
        <div data-text-interaction-source="">
          <p>first</p><p>second</p>
        </div>
      </div>,
    )
    const root = view.container.querySelector<HTMLElement>('[data-chat-flow]')!
    const sourceRoot = view.container.querySelector<HTMLElement>('[data-text-interaction-source]')!
    const range = document.createRange()
    range.selectNodeContents(sourceRoot)
    range.getBoundingClientRect = () => ({ left: 50, top: 60, width: 20, height: 10 }) as DOMRect
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    const candidate = readSelection(root, selection)
    expect(candidate).toMatchObject({
      text: 'first\nsecond',
    })
  })

  it('omits Markdown renderer whitespace between adjacent blocks', () => {
    const view = render(
      <div data-chat-flow="">
        <div data-text-interaction-source="">
          <MarkdownText text={'first\n\nsecond'} labels={markdownLabels} />
        </div>
      </div>,
    )
    const root = view.container.querySelector<HTMLElement>('[data-chat-flow]')!
    const sourceRoot = view.container.querySelector<HTMLElement>('[data-text-interaction-source]')!
    const paragraphs = sourceRoot.querySelectorAll('p')
    expect(paragraphs[0]!.nextSibling?.textContent).toBe('\n')
    const range = document.createRange()
    range.setStart(paragraphs[0]!.firstChild!, 0)
    range.setEnd(paragraphs[1]!.firstChild!, 'second'.length)
    range.getBoundingClientRect = () => (
      { left: 50, top: 60, width: 20, height: 10 } as DOMRect
    )
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    expect(readSelection(root, selection)).toMatchObject({ text: 'first\nsecond' })
  })

  it('maps visible KaTeX text while omitting its duplicate MathML branch', () => {
    const view = render(
      <div data-chat-flow="">
        <div data-text-interaction-source="">
          <span className="katex">
            <span className="katex-mathml">hidden TeX source</span>
            <span className="katex-html" aria-hidden="true">x + 1</span>
          </span>
        </div>
      </div>,
    )
    const root = view.container.querySelector<HTMLElement>('[data-chat-flow]')!
    const visible = view.container.querySelector<HTMLElement>('.katex-html')!
    const range = document.createRange()
    range.selectNodeContents(visible)
    range.getBoundingClientRect = () => ({ left: 50, top: 60, width: 20, height: 10 }) as DOMRect
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    expect(readSelection(root, selection)).toMatchObject({ text: 'x + 1' })
  })

})

describe('text source boundaries', () => {
  function source(html: string) {
    const root = document.createElement('div')
    const source = document.createElement('div')
    source.setAttribute('data-text-interaction-source', '')
    source.innerHTML = html
    root.append(source)
    const range = document.createRange()
    range.selectNodeContents(source)
    return { root, source, range }
  }

  it('preserves table cells, existing tabs, and inline code reference buttons', () => {
    const fixture = source('<table><tbody><tr><td>one</td><td>two</td></tr><tr><td style="white-space:pre">three\t</td><td>four</td></tr><tr><td>five</td><td style="white-space:pre">\tsix</td></tr></tbody></table><code><button>reference</button></code>')
    expect(selectedText(fixture)).toBe('one\ttwo\nthree\tfour\nfive\tsix\nreference')
  })

  it('omits hidden content, comments, and empty text nodes', () => {
    const fixture = source('<!-- renderer --><span aria-hidden="true">decoration</span><span hidden>hidden</span><span class="sr-only">spoken</span><span>visible</span>')
    fixture.source.append(document.createTextNode(''))
    fixture.range.selectNodeContents(fixture.source)
    expect(selectedText(fixture)).toBe('visible')
    const hidden = fixture.source.querySelector('span')!
    fixture.range.selectNodeContents(hidden)
    expect(selectedText(fixture)).toBeNull()
    fixture.range.setStart(hidden.firstChild!, 0)
    fixture.range.setEnd(hidden.firstChild!, 4)
    expect(selectedText(fixture)).toBeNull()
  })

  it('rejects whitespace-only and detached sources outside the area', () => {
    const fixture = source('   ')
    expect(selectedText(fixture)).toBeNull()
    const selection = window.getSelection()!
    selection.removeAllRanges()
    expect(readTextSelection(fixture.root, null)).toBeNull()
    expect(readTextSelection(fixture.root, selection)).toBeNull()
    document.body.append(fixture.root)
    try {
      selection.addRange(fixture.range)
      expect(readTextSelection(document.createElement('div'), selection)).toBeNull()
      fixture.source.hidden = true
      expect(readTextSelection(fixture.root, selection)).toBeNull()
    } finally { fixture.root.remove(); selection.removeAllRanges() }
  })

  it('projects text in a document without a browsing context', () => {
    const doc = document.implementation.createHTMLDocument()
    const source = doc.createElement('div')
    source.textContent = 'hello\nworld'
    const range = doc.createRange()
    range.selectNodeContents(source)
    expect(selectedText({ source, range })).toBe('hello world')
  })
})
