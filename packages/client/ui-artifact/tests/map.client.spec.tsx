// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@agentrans/client-test-runtime'
import { MapView } from '../src/client/MapView.tsx'
import { en } from '../src/client/locales.ts'
import type { MapSpec } from '@agentrans/artifact/scene'
import type { ArtifactId, RecordArtifactAction } from '../src/client/protocol.ts'

const t = makeTranslate(en)

const spec: MapSpec = {
  kind: 'map',
  markers: [
    { id: 'client', label: 'Client', x: 0, y: 0 },
    { id: 'edge', label: 'Edge', x: 1, y: 0 },
    { id: 'origin', label: 'Origin', x: 2, y: 0 },
  ],
  path: ['client', 'edge', 'origin'],
  timeline: { duration: 6, fps: 30 },
}

describe('MapView', () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks() })

  it('renders the selected marker and marker count', () => {
    render(<MapView spec={spec} artifactId={'a' as ArtifactId} revision={1} placement="inline" recordAction={vi.fn()} t={t} />)
    const readout = screen.getAllByRole('status')[0]!
    expect(readout.textContent).toContain('client')
    expect(readout.textContent).toContain('3')
  })

  it('confirms the selected marker', async () => {
    const recordAction = vi.fn<RecordArtifactAction>().mockResolvedValue(undefined)
    render(<MapView spec={spec} artifactId={'a' as ArtifactId} revision={1} placement="inline" recordAction={recordAction} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: 'Next step' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm analysis' }))
    await waitFor(() => {
      expect(recordAction).toHaveBeenCalledWith('a', 1, 'map.inspected', expect.objectContaining({ selected: 'edge' }), true)
    })
  })
})
