// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@agentrans/client-test-runtime'
import { FunctionPlotView } from '../src/client/FunctionPlotView.tsx'
import { en } from '../src/client/locales.ts'
import type { FunctionPlotSpec } from '@agentrans/artifact/scene'
import type { ArtifactId, RecordArtifactAction } from '../src/client/protocol.ts'

const t = makeTranslate(en)

beforeEach(() => { vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null) })

const spec: FunctionPlotSpec = {
  kind: 'function-plot',
  functions: [
    { id: 'sin', label: 'sin(x)', expression: 'sin(x)' },
    { id: 'cos', label: 'cos(x)', expression: 'cos(x)' },
  ],
  parameters: { d: { value: 0.4, min: 0, max: 2, step: 0.1 } },
  viewport: { x: [0, 12], y: [-10, 10] },
  trace: { x: 0.8, derivative: true, integral: false },
  timeline: { duration: 12, fps: 30 },
}

function view(recordAction: RecordArtifactAction = vi.fn<RecordArtifactAction>().mockResolvedValue(undefined)) {
  return render(
    <FunctionPlotView spec={spec} artifactId={'a' as ArtifactId} revision={1} placement="inline" recordAction={recordAction} t={t} />,
  )
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('FunctionPlotView', () => {
  it.each([
    { expression: 'sqrt(x)', x: 0, value: '0.000', derivative: null, integral: 0 },
    { expression: 'log(x)', x: 1, value: '0.000', derivative: 1, integral: null },
    { expression: '1/x', x: 0, value: '—', derivative: null, integral: null },
  ])('keeps $expression usable and confirms unavailable readings as null', async ({ expression, x, value, derivative, integral }) => {
    const recordAction = vi.fn<RecordArtifactAction>().mockResolvedValue(undefined)
    const onStateChange = vi.fn()
    const domainSpec: FunctionPlotSpec = {
      ...spec,
      functions: [{ id: 'domain', label: expression, expression }],
      viewport: { x: [-1, 4], y: [-2, 4] },
      trace: { x, derivative: false, integral: false },
    }
    render(<FunctionPlotView spec={domainSpec} artifactId={'a' as ArtifactId} revision={1} placement="inline"
      recordAction={recordAction} onStateChange={onStateChange} t={t} />)
    const readout = screen.getAllByRole('status')[0]!
    expect(readout.textContent).toContain(`f(x)${value}`)
    expect(readout.textContent).not.toMatch(/NaN|Infinity/)
    expect(readout.textContent).toContain('—')
    fireEvent.click(screen.getByRole('button', { name: 'Derivative' }))
    fireEvent.click(screen.getByRole('button', { name: 'Integral' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm analysis' }))
    await waitFor(() => { expect(recordAction).toHaveBeenCalled() })
    const call = recordAction.mock.lastCall
    expect(call?.[0]).toBe('a')
    expect(call?.[1]).toBe(1)
    expect(call?.[2]).toBe('plot.inspected')
    expect(call?.[4]).toBe(true)
    const inspected = call?.[3] as { derivative: number | null }
    if (derivative === null) expect(inspected.derivative).toBeNull()
    else expect(inspected.derivative).toBeCloseTo(derivative, 4)
    expect(call?.[3]).toMatchObject({ x, parameters: { d: 0.4 }, integral, zoom: 1 })
    const reported = onStateChange.mock.lastCall?.[0] as { derivative: number | null; integral: number | null }
    expect(reported.integral).toEqual(integral)
    if (derivative === null) expect(reported.derivative).toBeNull()
    else expect(reported.derivative).toBeCloseTo(derivative, 4)
  })

  it('keeps parameter editing available while moving into and out of a function domain', () => {
    const recordAction = vi.fn<RecordArtifactAction>().mockResolvedValue(undefined)
    const domainSpec: FunctionPlotSpec = {
      ...spec, functions: [{ id: 'root', label: 'sqrt(x-d)', expression: 'sqrt(x-d)' }],
      trace: { x: 1, derivative: true, integral: true },
    }
    render(<FunctionPlotView spec={domainSpec} artifactId={'a' as ArtifactId} revision={1} placement="inline"
      recordAction={recordAction} t={t} />)
    fireEvent.change(screen.getByRole('slider'), { target: { value: '1.1' } })
    expect(screen.getAllByRole('status')[0]?.textContent).toContain('f(x)—')
    fireEvent.click(screen.getByRole('button', { name: 'Confirm analysis' }))
    expect(recordAction).toHaveBeenLastCalledWith('a', 1, 'plot.inspected', expect.objectContaining({
      parameters: { d: 1.1 }, derivative: null, integral: null,
    }), true)
    fireEvent.change(screen.getByRole('slider'), { target: { value: '0.2' } })
    expect(screen.getAllByRole('status')[0]?.textContent).toContain('f(x)0.894')
  })

  it('renders the legend, readout, and parameter from the SceneSpec', () => {
    view()
    expect(screen.getAllByText('sin(x)').length).toBeGreaterThan(0)
    expect(screen.getAllByText('cos(x)').length).toBeGreaterThan(0)
    const readout = screen.getAllByRole('status')[0]!
    expect(readout.textContent).toContain('0.80')
    expect(readout.textContent).toContain('0.717')
    expect(readout.textContent).toContain('0.697')
    expect(readout.textContent).toContain('0.303')
    expect(screen.getByText('0.40')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Derivative' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: 'Integral' }).getAttribute('aria-pressed')).toBe('false')
  })

  it('steps the sweep parameter and resets it', () => {
    view()
    fireEvent.click(screen.getByRole('button', { name: 'Step' }))
    expect(screen.getByText('0.50')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }))
    expect(screen.getByText('0.40')).toBeTruthy()
  })

  it('switches the traced function and recomputes the analysis', () => {
    view()
    fireEvent.change(screen.getByLabelText('Trace function'), { target: { value: 'cos' } })
    const readout = screen.getAllByRole('status')[0]!
    expect(readout.textContent).toContain('0.697')
    expect(readout.textContent).toContain('-0.717')
  })

  it('toggles derivative and integral display', () => {
    view()
    const derivative = screen.getByRole('button', { name: 'Derivative' })
    const integral = screen.getByRole('button', { name: 'Integral' })
    fireEvent.click(derivative)
    expect(derivative.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(integral)
    expect(integral.getAttribute('aria-pressed')).toBe('true')
  })

  it('confirms the current analysis with its numeric payload', async () => {
    const recordAction = vi.fn<RecordArtifactAction>().mockResolvedValue(undefined)
    view(recordAction)
    fireEvent.click(screen.getByRole('button', { name: 'Confirm analysis' }))
    await waitFor(() => {
      expect(recordAction).toHaveBeenCalledWith('a', 1, 'plot.inspected', expect.objectContaining({
        x: 0.8, parameters: { d: 0.4 }, zoom: 1,
      }), true)
    })
    const payload = recordAction.mock.calls[0]?.[3] as { derivative: number; integral: number }
    expect(payload.derivative).toBeCloseTo(Math.cos(0.8), 2)
    expect(payload.integral).toBeCloseTo(1 - Math.cos(0.8), 2)
  })

  it('zooms the viewport and resets it', async () => {
    const recordAction = vi.fn<RecordArtifactAction>().mockResolvedValue(undefined)
    view(recordAction)
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm analysis' }))
    await waitFor(() => {
      expect(recordAction).toHaveBeenCalledWith('a', 1, 'plot.inspected', expect.objectContaining({ zoom: 1.25 }), true)
    })
    fireEvent.click(screen.getByRole('button', { name: 'Reset view' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm analysis' }))
    await waitFor(() => {
      expect(recordAction).toHaveBeenLastCalledWith('a', 1, 'plot.inspected', expect.objectContaining({ zoom: 1 }), true)
    })
  })

  it('zooms only on an explicit Ctrl+wheel gesture', () => {
    const recordAction = vi.fn<RecordArtifactAction>().mockResolvedValue(undefined)
    view(recordAction)
    const canvas = screen.getByRole('img', { name: 'Interactive function plot' })
    fireEvent.wheel(canvas, { deltaY: -100 })
    fireEvent.click(screen.getByRole('button', { name: 'Confirm analysis' }))
    expect(recordAction).toHaveBeenLastCalledWith('a', 1, 'plot.inspected', expect.objectContaining({ zoom: 1 }), true)

    fireEvent.wheel(canvas, { deltaY: -100, ctrlKey: true })
    fireEvent.click(screen.getByRole('button', { name: 'Confirm analysis' }))
    const payload = recordAction.mock.calls.at(-1)?.[3] as { zoom: number }
    expect(payload.zoom).toBeCloseTo(Math.exp(0.1), 5)
  })
})
