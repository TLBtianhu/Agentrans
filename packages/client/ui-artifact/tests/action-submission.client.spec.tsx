// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { makeTranslate } from '@agentrans/client-test-runtime'
import type { ArtifactId, SceneArtifactSnapshot } from '@agentrans/artifact/types'
import { useArtifactActionSubmission } from '../src/client/action-submission.ts'
import { ArtifactActionRequestError, type ArtifactActionFailure, type RecordArtifactAction } from '../src/client/protocol.ts'
import { ArtifactCard } from './runtime-harness.tsx'
import { en } from '../src/client/locales.ts'

const t = makeTranslate(en)
const id = 'stable' as ArtifactId
const source: SceneArtifactSnapshot = { artifactId: id, revision: 1, format: 'scene', presentation: 'inline', title: 'Stable experiment',
  spec: { kind: 'particle-system', particles: [{ id: 'p', x: 1, y: 0, vx: 1, vy: 0, mass: 1 }],
    gravity: { x: 0, y: 0 }, timeStep: 0.1, trails: false } }
afterEach(() => { cleanup(); vi.restoreAllMocks() })

it('reserves one frozen request synchronously and retries exactly that identity instead of later data', async () => {
  const first = Promise.withResolvers<undefined>()
  const submit = vi.fn<RecordArtifactAction>().mockReturnValueOnce(first.promise).mockResolvedValue(undefined)
  const h = renderHook(() => useArtifactActionSubmission(submit))
  const payload = { selected: { value: 'A' } }
  let sending: ReturnType<typeof h.result.current.begin>
  const originalBegin = h.result.current.begin
  act(() => { sending = originalBegin(id, 1, 'inspect', payload, true); void originalBegin(id, 1, 'inspect', { value: 'B' }, true) })
  expect(submit).toHaveBeenCalledOnce()
  payload.selected.value = 'B'
  expect(submit.mock.calls[0]?.[3]).toEqual({ selected: { value: 'A' } })
  expect(Object.isFrozen(submit.mock.calls[0]?.[3])).toBe(true)
  await act(async () => { first.reject(new Error('lost response')); await sending })
  expect(h.result.current.state.phase).toBe('unknown')
  await act(async () => { await originalBegin(id, 2, 'inspect', { value: 'B' }, true) })
  expect(submit).toHaveBeenCalledOnce()
  await act(async () => { await h.result.current.retry() })
  expect(submit.mock.calls[1]).toEqual(submit.mock.calls[0])
  expect(h.result.current.state.phase).toBe('sent')
})

it.each(['unavailable', 'denied', 'stale', 'invalid'] as const)('retains an unknown original request after a later %s refusal', async (failure) => {
  const submit = vi.fn<RecordArtifactAction>().mockRejectedValueOnce(new Error('lost response'))
    .mockRejectedValueOnce(new ArtifactActionRequestError(failure, new Error('later refusal'))).mockResolvedValue(undefined)
  const h = renderHook(() => useArtifactActionSubmission(submit))
  await act(async () => { await h.result.current.record(id, 1, 'inspect', null, false) })
  const original = h.result.current.state
  await act(async () => { await h.result.current.retry() })
  expect(h.result.current.state).toMatchObject({ phase: 'unknown', failure })
  if (original.phase !== 'unknown' || h.result.current.state.phase !== 'unknown') throw new Error('Missing retained request')
  expect(h.result.current.state.request).toBe(original.request)
  await act(async () => { await h.result.current.retry() })
  expect(submit.mock.calls[2]).toEqual(submit.mock.calls[0])
})

it.each(['invalid', 'denied', 'stale', 'source-unavailable', 'too-large', 'conflict', 'unavailable'] as const)(
  'ends a first known %s refusal and allows a new explicit action identity', async (failure: ArtifactActionFailure) => {
    const submit = vi.fn<RecordArtifactAction>().mockRejectedValueOnce(new ArtifactActionRequestError(failure, new Error('refused')))
      .mockResolvedValue(undefined)
    const h = renderHook(() => useArtifactActionSubmission(submit))
    await act(async () => { await h.result.current.record(id, 1, 'inspect', null, true) })
    expect(h.result.current.state).toMatchObject({ phase: 'rejected', failure })
    expect(h.result.current.pending).toBe(false)
    await act(async () => { await h.result.current.record(id, 2, 'inspect', { selected: 'B' }, true) })
    expect(submit.mock.calls[1]?.[5]).not.toBe(submit.mock.calls[0]?.[5])
    expect(h.result.current.state.phase).toBe('sent')
  },
)

it('discards only local retry state and makes the next explicit action a new identity', async () => {
  const submit = vi.fn<RecordArtifactAction>().mockRejectedValueOnce(new Error('lost response')).mockResolvedValue(undefined)
  const h = renderHook(() => useArtifactActionSubmission(submit))
  await act(async () => { await h.result.current.record(id, 1, 'inspect', { selected: 'A' }, true) })
  act(() => { h.result.current.dismiss() })
  expect(submit).toHaveBeenCalledOnce()
  expect(h.result.current.state.phase).toBe('idle')
  await act(async () => { await h.result.current.record(id, 1, 'inspect', { selected: 'B' }, true) })
  expect(submit.mock.calls[1]?.[5]).not.toBe(submit.mock.calls[0]?.[5])
})

it('keeps native confirmation pending and its original request above source revision changes', async () => {
  const first = Promise.withResolvers<undefined>()
  const submit = vi.fn<RecordArtifactAction>().mockReturnValueOnce(first.promise).mockResolvedValue(undefined)
  const p = { snapshot: source, origin: { kind: 'current' as const }, placement: 'inline' as const, recordAction: submit, t }
  const h = render(<ArtifactCard {...p} />)
  fireEvent.click(screen.getByRole('button', { name: en['scene.confirm'] }))
  expect(screen.getByRole('button', { name: en['scene.confirm'] }).hasAttribute('disabled')).toBe(true)
  const original = submit.mock.calls[0]
  if (source.spec.kind !== 'particle-system') throw new Error('Expected particle source')
  const next: SceneArtifactSnapshot = { ...source, revision: 2, spec: { ...source.spec,
    particles: [{ id: 'p', x: 10, y: 0, vx: 1, vy: 0, mass: 1 }] } }
  h.rerender(<ArtifactCard {...p} snapshot={next} />)
  fireEvent.click(screen.getByRole('button', { name: en['scene.step'] }))
  await act(async () => { first.reject(new Error('lost response')); await expect(first.promise).rejects.toThrow('lost response') })
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', en['actionSubmission.unknown'])
  expect(screen.getByRole('button', { name: en['scene.confirm'] }).hasAttribute('disabled')).toBe(true)
  const originalText = screen.getByText(en['actionSubmission.original']).closest('details')?.querySelector('pre')?.textContent
  expect(JSON.parse(originalText ?? '')).toMatchObject({ revision: 1, requestId: original?.[5], payload: { time: 0 } })
  fireEvent.click(screen.getByRole('button', { name: en['actionSubmission.retry'] }))
  await screen.findByText(en['actionSubmission.sent'])
  expect(submit.mock.calls[1]).toEqual(original)
  fireEvent.click(screen.getByRole('button', { name: en['scene.confirm'] }))
  await waitFor(() => { expect(submit).toHaveBeenCalledTimes(3) })
  expect(submit.mock.calls[2]?.[1]).toBe(2)
  expect(submit.mock.calls[2]?.[3]).toMatchObject({ time: 0.1, particles: [{ id: 'p', x: 10.1 }] })
  expect(submit.mock.calls[2]?.[5]).not.toBe(original?.[5])
})
