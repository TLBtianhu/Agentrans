// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@agentrans/client-test-runtime'
import { NetworkGraphView } from '../src/client/NetworkGraphView.tsx'
import { en } from '../src/client/locales.ts'
import type { NetworkGraphSpec } from '@agentrans/artifact/scene'
import type { ArtifactId, RecordArtifactAction } from '../src/client/protocol.ts'

const t = makeTranslate(en)

const spec: NetworkGraphSpec = {
  kind: 'network-graph',
  nodes: [
    { id: 'client', label: 'Client', x: 0, y: 0 },
    { id: 'edge', label: 'Edge', x: 1, y: 0 },
    { id: 'origin', label: 'Origin', x: 2, y: 0 },
  ],
  edges: [{ from: 'client', to: 'edge' }, { from: 'edge', to: 'origin' }],
  timeline: { duration: 6, fps: 30 },
}

describe('NetworkGraphView', () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks() })

  it('renders the selected node and neighbour count', () => {
    render(<NetworkGraphView spec={spec} artifactId={'a' as ArtifactId} revision={1} placement="inline" recordAction={vi.fn()} t={t} />)
    const readout = screen.getAllByRole('status')[0]!
    expect(readout.textContent).toContain('client')
    expect(readout.textContent).toContain('1')
    expect(readout.textContent).toContain('3')
    expect(readout.textContent).toContain('2')
  })

  it('confirms the selected node and its neighbours', async () => {
    const recordAction = vi.fn<RecordArtifactAction>().mockResolvedValue(undefined)
    render(<NetworkGraphView spec={spec} artifactId={'a' as ArtifactId} revision={1} placement="inline" recordAction={recordAction} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: 'Next step' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm analysis' }))
    await waitFor(() => {
      expect(recordAction).toHaveBeenCalledWith('a', 1, 'network.inspected', expect.objectContaining({ selected: 'edge', neighbours: ['client', 'origin'] }), true)
    })
  })
})
