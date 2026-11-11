// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@agentrans/client-test-runtime'
import { FlowchartView } from '../src/client/FlowchartView.tsx'
import { en } from '../src/client/locales.ts'
import type { FlowchartSpec } from '@agentrans/artifact/scene'
import type { ArtifactId, RecordArtifactAction } from '../src/client/protocol.ts'

const t = makeTranslate(en)

const spec: FlowchartSpec = {
  kind: 'flowchart',
  nodes: [
    { id: 'a', label: 'Collect', x: 0, y: 0 },
    { id: 'b', label: 'Analyze', x: 1, y: 0 },
    { id: 'c', label: 'Decide', x: 2, y: 0 },
  ],
  edges: [
    { from: 'a', to: 'b', label: 'data' },
    { from: 'b', to: 'c', label: 'insight' },
  ],
  path: ['a', 'b', 'c'],
  timeline: { duration: 6, fps: 30 },
}

describe('FlowchartView', () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks() })

  it('renders nodes, edges, and the initial path position', () => {
    render(<FlowchartView spec={spec} artifactId={'a' as ArtifactId} revision={1} placement="inline" recordAction={vi.fn()} t={t} />)
    const readout = screen.getAllByRole('status')[0]!
    expect(readout.textContent).toContain('Collect')
    expect(readout.textContent).toContain('1/3')
    expect(readout.textContent).toContain('3')
    expect(readout.textContent).toContain('2')
  })

  it('advances the path and confirms the inspected state', async () => {
    const recordAction = vi.fn<RecordArtifactAction>().mockResolvedValue(undefined)
    render(<FlowchartView spec={spec} artifactId={'a' as ArtifactId} revision={1} placement="inline" recordAction={recordAction} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: 'Next step' }))
    expect(screen.getAllByRole('status')[0]!.textContent).toContain('2/3')
    fireEvent.click(screen.getByRole('button', { name: 'Confirm analysis' }))
    await waitFor(() => {
      expect(recordAction).toHaveBeenCalledWith('a', 1, 'flow.inspected', expect.objectContaining({
        selected: 'b', pathIndex: 1, node: 'b', path: ['a', 'b', 'c'],
      }), true)
    })
  })
})
