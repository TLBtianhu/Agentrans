// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@agentrans/client-test-runtime'
import { TimelineView } from '../src/client/TimelineView.tsx'
import { en } from '../src/client/locales.ts'
import type { TimelineSpec } from '@agentrans/artifact/scene'
import type { ArtifactId, RecordArtifactAction } from '../src/client/protocol.ts'

const t = makeTranslate(en)

const spec: TimelineSpec = {
  kind: 'timeline',
  events: [
    { id: 'start', label: 'Start', time: 0 },
    { id: 'middle', label: 'Middle', time: 5 },
    { id: 'end', label: 'End', time: 10 },
  ],
  playhead: 0,
  timeline: { duration: 6, fps: 30 },
}

describe('TimelineView', () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks() })

  it('renders the initial playhead and event count', () => {
    render(<TimelineView spec={spec} artifactId={'a' as ArtifactId} revision={1} placement="inline" recordAction={vi.fn()} t={t} />)
    const readout = screen.getAllByRole('status')[0]!
    expect(readout.textContent).toContain('0.00')
    expect(readout.textContent).toContain('3')
    expect(readout.textContent).toContain('Start')
  })

  it('advances the playhead and confirms the inspected state', async () => {
    const recordAction = vi.fn<RecordArtifactAction>().mockResolvedValue(undefined)
    render(<TimelineView spec={spec} artifactId={'a' as ArtifactId} revision={1} placement="inline" recordAction={recordAction} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: 'Next step' }))
    expect(screen.getAllByRole('status')[0]!.textContent).toContain('5.00')
    fireEvent.click(screen.getByRole('button', { name: 'Confirm analysis' }))
    await waitFor(() => {
      expect(recordAction).toHaveBeenCalledWith('a', 1, 'timeline.inspected', expect.objectContaining({ playhead: 5, event: 'middle' }), true)
    })
  })
})
