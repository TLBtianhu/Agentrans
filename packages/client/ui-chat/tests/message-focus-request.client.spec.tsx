// @vitest-environment jsdom

import { useRef, useState } from 'react'
import { render, waitFor } from '@testing-library/react'
import { expect, it, onTestFinished, vi } from 'vitest'
import { useMessageFocusRequest } from '../src/client/chat/use-message-focus-request.ts'

function Disclosure({ id, seq }: { id: string; seq: number }) {
  const [open, setOpen] = useState(false)
  return <div data-chat-message-id={id} data-chat-message-seq={seq}>
    <button type="button" data-chat-message-control="comparison" aria-expanded={open}
      onClick={() => { setOpen(value => !value) }}>Review {id}</button>
  </div>
}

it('loads an older message and opens its exact disclosure using the containing Chat flow row', () => {
  const viewRequest = { view: 'chat', focus: JSON.stringify({ kind: 'message', eventSeq: 12, messageId: 'original', control: 'comparison' }) }
  const completeViewRequest = vi.fn()
  const loadThrough = vi.fn(async () => {})
  const reveal = vi.fn(() => true)

  function History({ loaded }: { loaded: boolean }) {
    const columnRef = useRef<HTMLDivElement>(null)
    useMessageFocusRequest({ viewRequest, completeViewRequest, loadThrough, ready: true, order: loaded ? ['original', 'copy'] : ['copy'],
      firstSeq: loaded ? 12 : 25, lastSeq: 25, hasMore: !loaded, loadingOlder: false, columnRef, reveal })
    return <div ref={columnRef}>
      {loaded && <div data-chat-flow-key="original-row"><Disclosure id="original" seq={12} /></div>}
      <Disclosure id="copy" seq={25} />
    </div>
  }

  const view = render(<History loaded={false} />)
  expect(loadThrough).toHaveBeenCalledExactlyOnceWith(12)
  expect(completeViewRequest).not.toHaveBeenCalled()
  expect(view.getByRole('button', { name: 'Review copy' }).getAttribute('aria-expanded')).toBe('false')

  view.rerender(<History loaded />)
  const original = view.getByRole('button', { name: 'Review original' })
  expect(original.getAttribute('aria-expanded')).toBe('true')
  expect(document.activeElement).toBe(original)
  expect(reveal).toHaveBeenCalledExactlyOnceWith(original.closest('[data-chat-flow-key="original-row"]'), original)
  expect(view.getByRole('button', { name: 'Review copy' }).getAttribute('aria-expanded')).toBe('false')
  expect(completeViewRequest).toHaveBeenCalledOnce()
})

it('opens a closed disclosure and focuses only the addressed button inside it', async () => {
  const viewRequest = { view: 'chat', focus: JSON.stringify({ kind: 'message', eventSeq: 12, messageId: 'paired',
    control: 'filtering', expandControl: 'comparison' }) }
  const completeViewRequest = vi.fn()
  const reveal = vi.fn(() => true)

  function History() {
    const columnRef = useRef<HTMLDivElement>(null)
    const [open, setOpen] = useState(false)
    useMessageFocusRequest({ viewRequest, completeViewRequest, loadThrough: async () => {}, ready: true, order: ['paired'],
      firstSeq: 12, lastSeq: 12, hasMore: false, loadingOlder: false, columnRef, reveal })
    return <div ref={columnRef}><div data-chat-message-id="paired" data-chat-message-seq={12}>
      <button type="button" data-chat-message-control="comparison" aria-expanded={open}
        onClick={() => { setOpen(value => !value) }}>Review</button>
      {open && <>
        <button type="button" data-chat-message-control="aggregation">Aggregation source</button>
        <button type="button" data-chat-message-control="filtering">Filtering source</button>
      </>}
    </div></div>
  }

  const view = render(<History />)
  const filtering = view.getByRole('button', { name: 'Filtering source' })
  await waitFor(() => { expect(document.activeElement).toBe(filtering) })
  expect(reveal).toHaveBeenCalledExactlyOnceWith(filtering.parentElement, filtering)
  expect(completeViewRequest).toHaveBeenCalledOnce()
})

it('styles the inquiry highlight only while the addressed passage is shown', () => {
  const highlights = new Map<string, unknown>()
  vi.stubGlobal('Highlight', class { constructor(readonly range: Range) {} })
  vi.stubGlobal('CSS', { highlights })
  onTestFinished(() => { vi.unstubAllGlobals() })
  const viewRequest = { view: 'chat', focus: JSON.stringify({ kind: 'inquiry', eventSeq: 7, messageId: 'answer', start: 6, end: 11, excerpt: 'world' }) }
  const completeViewRequest = vi.fn()
  const highlightRules = () => [...document.head.querySelectorAll('style')].filter(style => style.textContent?.includes('::highlight(agentrans-inquiry)'))

  function Answer() {
    const columnRef = useRef<HTMLDivElement>(null)
    useMessageFocusRequest({ viewRequest, completeViewRequest, loadThrough: async () => {}, ready: true, order: ['answer'],
      firstSeq: 7, lastSeq: 7, hasMore: false, loadingOlder: false, columnRef, reveal: () => true })
    return <div ref={columnRef}><div data-chat-message-id="answer" data-chat-message-seq={7}>
      <span data-markdown-source-start={0} data-markdown-source-end={11}>hello world</span>
    </div></div>
  }

  expect(highlightRules()).toEqual([])
  const view = render(<Answer />)
  expect(completeViewRequest).toHaveBeenCalledOnce()
  expect(highlights.has('agentrans-inquiry')).toBe(true)
  expect(highlightRules()).toHaveLength(1)
  view.unmount()
  expect(highlights.has('agentrans-inquiry')).toBe(false)
  expect(highlightRules()).toEqual([])
})
