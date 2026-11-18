/** Real-browser acceptance of a generated parameter explorer in a fresh workspace. */
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { HtmlArtifactSnapshot } from '@agentrans/artifact/types'
import type { SessionId } from '@agentrans/session'
import type { Locator, Page } from 'playwright'
import { expect } from 'vitest'
import { readPersistedEvents, type WebScaffold } from './scaffold.ts'
import { expandOwningTurnProcess, scrollIntoView } from './support.ts'

const PROMPT = 'Build an interactive double-slit interference experiment right in your answer. '
  + 'Keep the slit-to-screen distance fixed at 100 cm. Start the slit separation at 20 cm and let me change it from 10 to 40 cm in 10 cm steps. '
  + 'Start the probe 20 cm right of the screen center, with a horizontal screen from −30 to 30 cm. Let me drag the marker itself '
  + 'along that screen, with positive positions to the right. Also give me native range controls labeled Slit separation and Probe position '
  + 'so I can use my keyboard. The Probe position slider moves in 1 cm steps. Label the draggable target Probe marker for accessibility. '
  + 'Show two rays and a compact interference strip. Show the absolute difference of the two geometric path lengths in a live output '
  + 'labeled Path difference, in cm to two decimal places. Fit the controls and readout in a short mobile card.'

const TEMPLATE = /data-artifact-template=["']parameter-explorer["']/u
const TEMPLATE_REGIONS = ['data-explorer-stage', 'data-explorer-controls', 'data-explorer-readings'] as const

async function expectUnclipped(iframe: Locator, locator: Locator): Promise<void> {
  await locator.waitFor({ state: 'visible' })
  await expect.poll(() => locator.evaluate((node) => {
    const viewport = node.ownerDocument.documentElement
    const bounds = node.getBoundingClientRect()
    const text = node.ownerDocument.createRange()
    text.selectNodeContents(node)
    const contents = text.getBoundingClientRect()
    return viewport.scrollWidth <= viewport.clientWidth + 1
      && bounds.left >= -1 && bounds.right <= viewport.clientWidth + 1
      && bounds.top >= -1 && bounds.bottom <= viewport.clientHeight + 1
      && contents.left >= -1 && contents.right <= viewport.clientWidth + 1
      && contents.top >= -1 && contents.bottom <= viewport.clientHeight + 1
  })).toBe(true)
  await expect.poll(async () => {
    const bounds = await locator.boundingBox()
    if (bounds === null) return false
    return iframe.evaluate((node, rect) => {
      const y = rect.y + rect.height / 2
      return [rect.x + 1, rect.x + rect.width - 1].every(x => node.ownerDocument.elementFromPoint(x, y) === node)
    }, bounds)
  }).toBe(true)
}

/**
 * Load the bundled template through a real model turn and operate the generated experiment in Edge.
 * @param input - Live browser, workspace, provider and evidence controls.
 */
export async function exerciseDoubleSlit({ page, world, ask, stage, evidence, providerSaw }: {
  readonly page: Page
  readonly world: WebScaffold
  readonly ask: (prompt: string) => Promise<SessionId>
  readonly stage: (name: string) => void
  readonly evidence: string
  readonly providerSaw: (prompt: string, text: string) => boolean
}): Promise<void> {
  stage('double-slit-generate-from-bundled-skill')
  for (const root of ['.agents', '.dsh']) expect(existsSync(join(world.workspaceCwd, root, 'skills'))).toBe(false)
  const model = page.getByRole('button', { name: /^Select model, current DeepSeek/u }).first()
  await model.click()
  await page.getByRole('menuitem', { name: /^Effort/u }).click()
  await page.getByRole('menuitemradio', { name: 'Low', exact: true }).click()
  await expect.poll(() => model.getAttribute('aria-label')).toMatch(/reasoning effort Low/u)
  const sessionId = await ask(PROMPT)
  const events = await readPersistedEvents(world, sessionId)
  const load = events.find((event) => {
    if (event.type !== 'tool/call' || event.data.name !== 'skill') return false
    const argumentsValue: unknown = JSON.parse(event.data.arguments)
    return typeof argumentsValue === 'object' && argumentsValue !== null
      && 'name' in argumentsValue && argumentsValue.name === 'artifact-design'
  })
  if (load?.type !== 'tool/call') throw new Error('The model did not load the bundled artifact-design skill')
  const result = events.find(event => event.type === 'tool/result' && event.data.message.toolCallId === load.data.callId)
  if (result?.type !== 'tool/result') throw new Error('The design skill produced no durable tool result')
  expect(result.data.message.isError).not.toBe(true)
  const text = result.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
  expect(text).toContain('<skill_content name="artifact-design">')
  expect(text).toContain('parameter-explorer.html')
  expect(text).toMatch(TEMPLATE)
  for (const region of TEMPLATE_REGIONS) expect(text).toContain(region)
  expect(providerSaw(PROMPT, text)).toBe(true)

  const firstCreation = events.find(event => event.type === 'tool/call' && event.data.name === 'artifact')
  expect(firstCreation?.seq).toBeGreaterThan(result.seq)
  const artifacts = events.flatMap(event => event.type === 'artifact/upsert' ? [event.data] : [])
  const artifact = artifacts.at(-1)
  if (artifact?.format !== 'html') throw new Error('Expected an HTML double-slit experiment')
  expect(new Set(artifacts.map(item => item.artifactId))).toEqual(new Set([artifact.artifactId]))
  expect(artifact.presentation).toBe('inline')
  expect(artifact.source).toMatch(TEMPLATE)
  expect(artifact.source).toContain('data-explorer-stage')
  expect(artifact.source).toContain('data-explorer-controls')
  await verifyDoubleSlitPreview({ page, artifact, stage, evidence })
}

/**
 * Check the rendered experiment for one exact model-generated source revision.
 * @param input - Browser, committed source identity and evidence controls.
 */
export async function verifyDoubleSlitPreview({ page, artifact, stage, evidence }: {
  readonly page: Page
  readonly artifact: HtmlArtifactSnapshot
  readonly stage: (name: string) => void
  readonly evidence: string
}): Promise<void> {
  const card = page.locator(`section[data-artifact-revision="${artifact.revision}"]`).filter({
    has: page.locator(`iframe[data-artifact-frame][data-artifact-id="${artifact.artifactId}"]`),
  })
  await expandOwningTurnProcess(page, card)
  const iframe = card.locator('iframe[data-artifact-frame]')
  const frame = iframe.contentFrame()
  const spacing = frame.getByRole('slider', { name: 'Slit separation', exact: true })
  const probe = frame.getByRole('slider', { name: 'Probe position', exact: true })
  const output = frame.getByRole('status', { name: 'Path difference', exact: true })
  const marker = frame.locator('[aria-label="Probe marker"]')
  const read = async () => {
    const spacingCm = Number(await spacing.inputValue())
    const probeCm = Number(await probe.inputValue())
    const display = await output.innerText()
    expect(display).toMatch(/\d+\.\d{2}\s*cm\b/iu)
    const differenceCm = Number(display.match(/\d+\.\d{2}/u)?.[0])
    const expected = Math.abs(Math.hypot(100, probeCm + spacingCm / 2) - Math.hypot(100, probeCm - spacingCm / 2))
    expect(differenceCm).toBeCloseTo(expected, 2)
    return { spacingCm, probeCm, differenceCm }
  }

  stage('double-slit-change-spacing-and-drag-probe')
  await spacing.waitFor({ state: 'visible' })
  expect(await spacing.evaluate(node => node instanceof HTMLInputElement && node.type === 'range')).toBe(true)
  expect(await probe.evaluate(node => node instanceof HTMLInputElement && node.type === 'range')).toBe(true)
  const initial = await read()
  expect(initial).toMatchObject({ spacingCm: 20, probeCm: 20 })
  await spacing.press('ArrowRight')
  const widerSlits = await read()
  expect(widerSlits).toMatchObject({ spacingCm: 30, probeCm: 20 })
  expect(widerSlits.differenceCm).toBeGreaterThan(initial.differenceCm)

  await scrollIntoView(iframe)
  await marker.waitFor({ state: 'visible' })
  const markerBox = await marker.boundingBox()
  const stageBox = await frame.locator('[data-explorer-stage]').boundingBox()
  if (markerBox === null || stageBox === null) throw new Error('Expected a visible probe in its experiment stage')
  const centerX = markerBox.x + markerBox.width / 2
  const centerY = markerBox.y + markerBox.height / 2
  await page.mouse.move(centerX, centerY)
  await page.mouse.down()
  try {
    await page.mouse.move(centerX - Math.min(90, stageBox.width * 0.19), centerY, { steps: 16 })
  } finally {
    await page.mouse.up()
  }
  const dragged = await read()
  expect(dragged.spacingCm).toBe(30)
  expect(dragged.probeCm).toBeLessThan(20)
  expect(dragged.differenceCm).not.toBe(widerSlits.differenceCm)
  const draggedBox = await marker.boundingBox()
  if (draggedBox === null) throw new Error('The probe marker disappeared during the drag')
  expect(draggedBox.x + draggedBox.width / 2).toBeLessThan(centerX - 5)
  await iframe.screenshot({ path: join(evidence, 'double-slit-after-probe-drag.png') })

  stage('double-slit-narrow-keyboard-and-readout')
  const collapse = page.getByRole('button', { name: 'Collapse sidebar', exact: true }).and(page.locator('[data-sidebar-toggle]'))
  if (await collapse.isVisible()) await collapse.click()
  await page.setViewportSize({ width: 390, height: 844 })
  await scrollIntoView(iframe)
  const narrowBox = await iframe.boundingBox()
  if (narrowBox === null) throw new Error('Expected an inline experiment at mobile width')
  expect(narrowBox.x).toBeGreaterThanOrEqual(-1)
  expect(narrowBox.x + narrowBox.width).toBeLessThanOrEqual(391)
  const outputLabel = frame.getByText('Path difference', { exact: true })
  await expectUnclipped(iframe, outputLabel)
  await expectUnclipped(iframe, output)
  const beforeKeyboard = await read()
  await probe.press('ArrowRight')
  const keyboard = await read()
  expect(keyboard.spacingCm).toBe(beforeKeyboard.spacingCm)
  expect(keyboard.probeCm).toBe(beforeKeyboard.probeCm + 1)
  expect(keyboard.differenceCm).not.toBe(beforeKeyboard.differenceCm)
  await expectUnclipped(iframe, outputLabel)
  await expectUnclipped(iframe, output)
  await iframe.screenshot({ path: join(evidence, 'double-slit-narrow-after-keyboard.png') })
  await writeFile(join(evidence, 'double-slit-readings.json'), JSON.stringify({
    initial, widerSlits, dragged, beforeKeyboard, keyboard, narrowFrameWidth: narrowBox.width,
  }, null, 2) + '\n', 'utf8')
}
