// @vitest-environment jsdom
import type { ComponentProps } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { makeTranslate } from '@agentrans/client-test-runtime'
import type { ArtifactId, SceneArtifactSnapshot } from '@agentrans/artifact/types'
import type { ArtifactExportId, ArtifactHtmlExportRecord, ArtifactHtmlExportRequest } from '@agentrans/artifact-export/types'
import { ArtifactCard } from './runtime-harness.tsx'
import { ArtifactExportRequestError, type ArtifactExportCommands } from '../src/client/protocol.ts'
import { en } from '../src/client/locales.ts'

const t = makeTranslate(en)
const source: SceneArtifactSnapshot = {
  artifactId: 'export-particles' as ArtifactId, revision: 1, format: 'scene', presentation: 'inline', title: 'Original A',
  spec: { kind: 'particle-system', particles: [{ id: 'p', x: 1, y: 0, vx: 2, vy: 0, mass: 1 }],
    gravity: { x: 0, y: 0 }, timeStep: 0.1, trails: false },
}
const request: ArtifactHtmlExportRequest = {
  exportId: 'export-A' as ArtifactExportId, source: { kind: 'current', artifactId: source.artifactId, revision: 1,
    checkpoint: { runtimeVersion: 1, stepCount: 6 } }, format: 'html',
}
function ready(input = request): ArtifactHtmlExportRecord & { readonly status: 'ready' } {
  return { request: input, frozen: { sessionId: 'export-session' as never, artifact: source, checkpoint: { runtimeVersion: 1, stepCount: 6 },
    exporterVersion: 1, parameters: 'particle-checkpoint' }, status: 'ready',
  file: { attachmentId: `sha256:${'ab'.repeat(32)}` as never, name: 'original-A.html', bytes: 144 },
  }
}
type CardProps = ComponentProps<typeof ArtifactCard>
function props(overrides: Partial<CardProps> = {}): CardProps {
  return { snapshot: source, origin: { kind: 'current' }, placement: 'inline', recordAction: vi.fn(), t,
    exportControls: { ready: true, records: [], create: vi.fn<ArtifactExportCommands['create']>().mockResolvedValue(ready()),
      download: vi.fn<ArtifactExportCommands['download']>().mockResolvedValue({ status: 'requested' }) }, ...overrides }
}
afterEach(() => { cleanup(); vi.restoreAllMocks() })

it('waits for the export projection before admitting a request', () => {
  const p = props()
  const view = render(<ArtifactCard {...p} exportControls={{ ...p.exportControls!, ready: false }} />)
  expect(screen.getByText('Loading exports…')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Export animation' }).hasAttribute('disabled')).toBe(true)
  expect(p.exportControls!.create).not.toHaveBeenCalled()
  view.rerender(<ArtifactCard {...p} />)
  expect(screen.getByRole('button', { name: 'Export animation' }).hasAttribute('disabled')).toBe(false)
})

it('freezes one request above source revisions and retries it before downloading the original result', async () => {
  const first = Promise.withResolvers<ArtifactHtmlExportRecord>()
  const create = vi.fn<ArtifactExportCommands['create']>().mockReturnValueOnce(first.promise).mockImplementationOnce(async input => ready(input))
  const p = props()
  const controls = { ...p.exportControls!, create }
  const view = render(<ArtifactCard {...p} exportControls={controls} />)
  for (let step = 0; step < 6; step++) fireEvent.click(screen.getByRole('button', { name: 'Step' }))
  const button = screen.getByRole('button', { name: 'Export animation' })
  fireEvent.click(button); fireEvent.click(button)
  expect(create).toHaveBeenCalledOnce()
  const captured = create.mock.calls[0]![0]
  expect(captured.source).toEqual(request.source)
  view.rerender(<ArtifactCard {...p} snapshot={{ ...source, revision: 2, title: 'Changed B' }} exportControls={controls} />)
  await act(async () => { first.reject(new Error('response lost')); await expect(first.promise).rejects.toThrow('response lost') })
  expect(document.querySelector('[data-export-request]')?.textContent).toContain('Original A')
  expect(document.querySelector('[data-export-request]')?.textContent).toContain('Revision 1 · step 6 · runtime 1')
  fireEvent.click(screen.getByRole('button', { name: 'Step' }))
  fireEvent.click(screen.getByRole('button', { name: 'Retry export' }))
  await screen.findByText(en['export.requested'])
  expect(create.mock.calls[1]![0]).toBe(captured)
  expect(controls.download).toHaveBeenCalledWith(ready(captured))
  expect(document.querySelector('[data-export-id]')).toBeNull()
  view.rerender(<ArtifactCard {...p} snapshot={{ ...source, revision: 2, title: 'Changed B' }}
    exportControls={{ ...controls, records: [ready(captured)] }} />)
  expect(document.querySelector('[data-export-status="ready"]')?.textContent).toContain('Revision 1 · step 6 · runtime 1')
  expect(p.recordAction).not.toHaveBeenCalled()
})

it('offers the same export operation in comparison cells without placement controls', async () => {
  const p = props({ placementControls: false })
  render(<ArtifactCard {...p} />)
  expect(screen.queryByRole('button', { name: 'Focus' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Export animation' }))
  await screen.findByText(en['export.requested'])
  expect(p.exportControls!.create).toHaveBeenCalledOnce()
  expect(p.exportControls!.download).toHaveBeenCalledOnce()
})

it('shows fixed source defaults without claiming transient non-particle controls were captured', async () => {
  const p = props({ snapshot: { ...source, spec: { kind: 'flowchart', nodes: [{ id: 'a', label: 'A', x: 0, y: 0 }], edges: [] } } })
  render(<ArtifactCard {...p} />)
  expect(screen.getByText('Revision 1 · source defaults')).toBeTruthy()
  expect(screen.getByText(en['export.defaultHint'])).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Export animation' }))
  await waitFor(() => { expect(p.exportControls!.create).toHaveBeenCalledOnce() })
  expect(vi.mocked(p.exportControls!.create).mock.calls[0]![0].source).toEqual({ kind: 'current', artifactId: source.artifactId, revision: 1 })
  await screen.findByText(en['export.requested'])
})

it('does not resume a projected pending export until explicitly requested, and never recreates a ready file', async () => {
  const pending: ArtifactHtmlExportRecord = { request, frozen: ready().frozen, status: 'pending' }
  const p = props()
  const controls = { ...p.exportControls!, records: [pending] }
  const view = render(<ArtifactCard {...p} exportControls={controls} />)
  expect(screen.getByText(en['export.pending'])).toBeTruthy()
  expect(controls.create).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Continue export' }))
  await screen.findByText(en['export.requested'])
  expect(controls.create).toHaveBeenCalledExactlyOnceWith(request)
  view.unmount()
  const afterRestart = props({ snapshot: { ...source, revision: 2, title: 'Changed B' } })
  render(<ArtifactCard {...afterRestart} exportControls={{ ...afterRestart.exportControls!, records: [ready()] }} />)
  fireEvent.click(screen.getByRole('button', { name: 'Download HTML' }))
  await screen.findByText(en['export.requested'])
  expect(afterRestart.exportControls!.create).not.toHaveBeenCalled()
  expect(afterRestart.exportControls!.download).toHaveBeenCalledExactlyOnceWith(ready())
})

it.each(['limit', 'source-unavailable', 'conflict', 'service-unavailable', 'denied', 'invalid', 'input-too-large'] as const)('ends a known %s refusal and allows a new current request', async (failure) => {
  const p = props()
  const create = vi.fn<ArtifactExportCommands['create']>().mockRejectedValue(new ArtifactExportRequestError(failure, new Error('irrelevant')))
  render(<ArtifactCard {...p} exportControls={{ ...p.exportControls!, create }} />)
  fireEvent.click(screen.getByRole('button', { name: 'Export animation' }))
  await screen.findByRole('alert')
  expect(screen.queryByRole('button', { name: 'Retry export' })).toBeNull()
  expect(screen.getByRole('button', { name: 'Export animation' }).hasAttribute('disabled')).toBe(false)
  expect(p.exportControls!.download).not.toHaveBeenCalled()
})

it('retains an earlier unknown request when a later retry is refused before invocation', async () => {
  const p = props()
  const create = vi.fn<ArtifactExportCommands['create']>()
    .mockRejectedValueOnce(new Error('response lost'))
    .mockRejectedValueOnce(new ArtifactExportRequestError('service-unavailable', new Error('service stopped')))
    .mockImplementationOnce(async input => ready(input))
  render(<ArtifactCard {...p} exportControls={{ ...p.exportControls!, create }} />)
  fireEvent.click(screen.getByRole('button', { name: 'Export animation' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Retry export' }))
  await screen.findByText(en['export.retained'])
  expect(screen.getByRole('button', { name: 'Export animation' }).hasAttribute('disabled')).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Retry export' }))
  await screen.findByText(en['export.requested'])
  expect(create.mock.calls.map(call => call[0])).toEqual([create.mock.calls[0]![0], create.mock.calls[0]![0], create.mock.calls[0]![0]])
})

it('can generate without read permission and leaves the ready output in the projection', async () => {
  const p = props()
  render(<ArtifactCard {...p} exportControls={{ ...p.exportControls!, canRead: false, records: [ready()] }} />)
  fireEvent.click(screen.getByRole('button', { name: 'Export animation' }))
  await waitFor(() => { expect(p.exportControls!.create).toHaveBeenCalledOnce(); expect(screen.queryByText(en['export.creating'])).toBeNull() })
  expect(screen.queryByRole('button', { name: 'Download HTML' })).toBeNull()
  expect(p.exportControls!.download).not.toHaveBeenCalled()
})

it.each(['RENDER_FAILED', 'OUTPUT_TOO_LARGE', 'STORAGE_FAILED'] as const)('keeps a %s record visible without automatically recreating it', (failure) => {
  const p = props()
  render(<ArtifactCard {...p} exportControls={{ ...p.exportControls!, records: [{ request, frozen: ready().frozen, status: 'failed', failure }] }} />)
  expect(document.querySelector('[data-export-status="failed"]')?.textContent).toContain('Original A')
  expect(screen.queryByRole('button', { name: 'Continue export' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Download HTML' })).toBeNull()
  expect(p.exportControls!.create).not.toHaveBeenCalled()
})

it('retains a file-ready record when downloading fails and retries only file transfer', async () => {
  const p = props()
  const download = vi.fn<ArtifactExportCommands['download']>().mockRejectedValueOnce(new Error('corrupt file')).mockResolvedValueOnce({ status: 'saved', path: 'C:\\exports\\A.html' })
  render(<ArtifactCard {...p} exportControls={{ ...p.exportControls!, records: [ready()], download }} />)
  const record = within(document.querySelector('[data-export-id]') as HTMLElement)
  fireEvent.click(record.getByRole('button', { name: 'Download HTML' }))
  expect((await screen.findByRole('alert')).textContent).toBe(en['export.downloadFailed'])
  fireEvent.click(record.getByRole('button', { name: 'Download HTML' }))
  await screen.findByText(en['export.saved'])
  expect(p.exportControls!.create).not.toHaveBeenCalled()
  expect(download).toHaveBeenCalledTimes(2)
})

it('does not download a late completed generation after its card is unmounted', async () => {
  const result = Promise.withResolvers<ArtifactHtmlExportRecord>()
  const p = props()
  const create = vi.fn<ArtifactExportCommands['create']>().mockReturnValue(result.promise)
  const view = render(<ArtifactCard {...p} exportControls={{ ...p.exportControls!, create }} />)
  fireEvent.click(screen.getByRole('button', { name: 'Export animation' }))
  view.unmount()
  await act(async () => { result.resolve(ready()); await result.promise })
  expect(p.exportControls!.download).not.toHaveBeenCalled()
})

it('keeps recorded export metadata visible without unavailable Host creation or download controls', () => {
  const p = props({ hostOperationsAvailable: false })
  const pending: ArtifactHtmlExportRecord = { request, frozen: ready().frozen, status: 'pending' }
  render(<ArtifactCard {...p} exportControls={{ ...p.exportControls!, records: [ready(),
    { ...pending, request: { ...request, exportId: 'export-pending' as ArtifactExportId } }] }} />)
  expect(screen.queryByRole('button', { name: en['action.exportAnimation'] })).toBeNull()
  expect(screen.queryByRole('button', { name: en['export.download'] })).toBeNull()
  expect(screen.queryByRole('button', { name: en['export.continue'] })).toBeNull()
  expect(document.querySelector('[data-export-status="ready"]')?.textContent).toContain('Original A')
  expect(document.querySelector('[data-export-status="pending"]')?.textContent).toContain('Revision 1')
  expect(screen.queryByText(en['export.denied'])).toBeNull()
  fireEvent.click(screen.getAllByText(en['export.source'])[0]!)
  expect(screen.getAllByText(/"particle-system"/).length).toBeGreaterThan(0)
  expect(p.exportControls!.create).not.toHaveBeenCalled()
  expect(p.exportControls!.download).not.toHaveBeenCalled()
})
