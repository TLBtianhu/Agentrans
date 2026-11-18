/** Resolve one-shot Conversation focus requests against Chat's committed history. */
import { useLayoutEffect, useMemo, useRef, type RefObject } from 'react'
import { SessionSeq } from '@agentrans/session/types'
import type { ChatViewSlotProps } from '../contract/slots.ts'

interface MessageAddress {
  readonly eventSeq: SessionSeq
  readonly messageId: string
}

interface ControlFocus extends MessageAddress {
  readonly control: string
  readonly expandControl?: string
}

interface InquiryFocus extends MessageAddress {
  readonly start: number
  readonly end: number
  readonly excerpt: string
}

type MessageFocus = ControlFocus | InquiryFocus

function isControlName(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z][a-z0-9-]*$/u.test(value)
}

function isOffset(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function parseMessageFocus(focus: string): MessageFocus | undefined {
  let value: unknown
  try { value = JSON.parse(focus) } catch { return undefined }
  if (typeof value !== 'object' || value === null || !('kind' in value)
    || !('eventSeq' in value) || !isOffset(value.eventSeq)
    || !('messageId' in value) || typeof value.messageId !== 'string' || value.messageId.length === 0) return undefined
  const address = { eventSeq: SessionSeq(value.eventSeq), messageId: value.messageId }
  if (value.kind === 'inquiry') {
    if (!('start' in value) || !isOffset(value.start) || !('end' in value) || !isOffset(value.end) || value.end <= value.start
      || !('excerpt' in value) || typeof value.excerpt !== 'string' || value.excerpt.length !== value.end - value.start) return undefined
    return { ...address, start: value.start, end: value.end, excerpt: value.excerpt }
  }
  if (value.kind !== 'message' || !('control' in value) || !isControlName(value.control)) return undefined
  const expandControl = 'expandControl' in value ? value.expandControl : undefined
  if (expandControl !== undefined && (!isControlName(expandControl) || expandControl === value.control)) return undefined
  return { ...address, control: value.control, ...(expandControl === undefined ? {} : { expandControl }) }
}

function messageControl(row: HTMLElement, name: string): HTMLButtonElement | undefined {
  const button = row.querySelector<HTMLButtonElement>(`button[data-chat-message-control="${name}"]`)
  return button !== null && !button.disabled && button.closest('[hidden]') === null ? button : undefined
}

function inquiryRange(row: HTMLElement, request: InquiryFocus): { range: Range; focus: HTMLElement } | undefined {
  let startElement: HTMLElement | undefined
  let endElement: HTMLElement | undefined
  for (const span of row.querySelectorAll<HTMLElement>('[data-markdown-source-start][data-markdown-source-end]')) {
    const start = Number(span.dataset.markdownSourceStart)
    const end = Number(span.dataset.markdownSourceEnd)
    if (start <= request.start && request.start < end) startElement = span
    if (start < request.end && request.end <= end) endElement = span
  }
  const startText = startElement?.firstChild
  const endText = endElement?.firstChild
  if (startElement === undefined || endElement === undefined || !(startText instanceof Text) || !(endText instanceof Text)) return undefined
  const startOffset = request.start - Number(startElement.dataset.markdownSourceStart)
  const endOffset = request.end - Number(endElement.dataset.markdownSourceStart)
  if (startOffset > startText.length || endOffset > endText.length) return undefined
  const range = row.ownerDocument.createRange()
  range.setStart(startText, startOffset)
  range.setEnd(endText, endOffset)
  return range.toString() === request.excerpt ? { range, focus: startElement } : undefined
}

const inquiryHighlight = 'agentrans-inquiry'

function showInquiryRange(range: Range, focus: HTMLElement): () => void {
  const highlight = typeof Highlight === 'function' ? new Highlight(range) : undefined
  if (highlight !== undefined) CSS.highlights.set(inquiryHighlight, highlight)
  const originalTabIndex = focus.getAttribute('tabindex')
  focus.tabIndex = -1
  focus.setAttribute('data-inquiry-anchor', '')
  focus.focus({ preventScroll: true })
  return () => {
    if (highlight !== undefined && CSS.highlights.get(inquiryHighlight) === highlight) CSS.highlights.delete(inquiryHighlight)
    focus.removeAttribute('data-inquiry-anchor')
    if (originalTabIndex === null) focus.removeAttribute('tabindex')
    else focus.setAttribute('tabindex', originalTabIndex)
  }
}

interface MessageFocusInput extends Pick<ChatViewSlotProps, 'viewRequest' | 'completeViewRequest' | 'loadThrough'> {
  readonly ready: boolean
  readonly order: readonly string[]
  readonly firstSeq: number | null
  readonly lastSeq: number | null
  readonly hasMore: boolean
  readonly loadingOlder: boolean
  readonly columnRef: RefObject<HTMLDivElement>
  readonly reveal: (row: HTMLElement, target: HTMLElement | Range) => boolean
}

/** Reveal a control or source passage when its addressed message becomes available. */
export function useMessageFocusRequest({
  viewRequest, completeViewRequest, loadThrough, ready, order, firstSeq, lastSeq, hasMore, loadingOlder, columnRef, reveal,
}: MessageFocusInput): void {
  const request = useMemo(() => viewRequest?.view === 'chat' ? parseMessageFocus(viewRequest.focus) : undefined, [viewRequest])
  const requestedPage = useRef<{ request: MessageFocus; firstSeq: number | null }>()
  const clearInquiry = useRef<() => void>()
  useLayoutEffect(() => () => { clearInquiry.current?.() }, [])
  useLayoutEffect(() => {
    if (!ready || viewRequest?.view !== 'chat') return
    if (request === undefined) { completeViewRequest(); return }
    const column = columnRef.current
    if (column === null) return
    const row = [...column.querySelectorAll<HTMLElement>(`[data-chat-message-seq="${request.eventSeq}"]`)]
      .find(candidate => candidate.dataset.chatMessageId === request.messageId)
    if (row === undefined) {
      const needsHistory = firstSeq === null || firstSeq > request.eventSeq
      if (needsHistory && hasMore && !loadingOlder
        && (requestedPage.current?.request !== request || requestedPage.current.firstSeq !== firstSeq)) {
        requestedPage.current = { request, firstSeq }
        void loadThrough(request.eventSeq).catch(() => {})
      }
      if (!(needsHistory && hasMore) && lastSeq !== null && lastSeq >= request.eventSeq) completeViewRequest()
      return
    }
    clearInquiry.current?.()
    clearInquiry.current = undefined
    const flowRow = row.closest<HTMLElement>('[data-chat-flow-key]') ?? row
    if ('excerpt' in request) {
      const source = inquiryRange(row, request)
      if (source !== undefined && reveal(flowRow, source.range)) clearInquiry.current = showInquiryRange(source.range, source.focus)
      completeViewRequest()
      return
    }
    const focus = (control: HTMLButtonElement): void => {
      if (!reveal(flowRow, control)) return
      if (control.getAttribute('aria-expanded') === 'false') control.click()
      control.focus({ preventScroll: true })
    }
    const control = messageControl(row, request.control)
    if (control !== undefined) focus(control)
    else if (request.expandControl !== undefined) {
      const disclosure = messageControl(row, request.expandControl)
      if (disclosure?.getAttribute('aria-expanded') === 'false') {
        disclosure.click()
        // The disclosure's React commit mounts the requested button before the next paint.
        const frame = requestAnimationFrame(() => {
          if (columnRef.current !== column || !column.contains(row)) return
          const opened = messageControl(row, request.control)
          if (opened !== undefined) focus(opened)
          completeViewRequest()
        })
        return () => { cancelAnimationFrame(frame) }
      }
    }
    completeViewRequest()
  }, [viewRequest, request, ready, order, firstSeq, lastSeq, hasMore, loadingOlder, columnRef, reveal, completeViewRequest, loadThrough])
}
