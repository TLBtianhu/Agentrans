import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ParticleCheckpoint, ParticleObservation } from '@agentrans/artifact/particle-runtime'
import type { ParticleSystemSpec } from '@agentrans/artifact/scene'
import type { SceneArtifactSnapshot } from '@agentrans/artifact/types'
import type { Browser, Locator, Page, Request } from 'playwright'
import { expect } from 'vitest'

interface ParticleDownload {
  readonly browser: Browser
  readonly page: Page
  readonly card: Locator
  readonly directory: string
  readonly sessionId: string
  readonly address: { readonly eventSeq: number; readonly messageId: string }
  readonly scene: Pick<SceneArtifactSnapshot, 'artifactId' | 'revision' | 'title'> & { readonly spec: ParticleSystemSpec }
  readonly reading: { readonly checkpoint: ParticleCheckpoint; readonly values: ParticleObservation }
  readonly gravityY?: number
  readonly kind: 'sentQuestion' | 'returnedEvidence'
  readonly fileName?: string
  readonly screenshot?: string
}

/** Verify the exact downloaded checkpoint, including playback and reset in an offline browser context. */
export async function verifyParticleDownload({
  browser, page, card, directory, sessionId, address, scene, reading, gravityY, kind, fileName, screenshot,
}: ParticleDownload) {
  const sent = kind === 'sentQuestion'
  const endpoint = `/api/artifactBranchResults/${sent ? 'exportSentParticle' : 'exportReturnedParticle'}`
  const filename = `${sent ? 'sent' : 'returned'}-particle-${address.eventSeq}.html`
  const marker = sent ? '[data-artifact-question-download]' : '[data-artifact-branch-download]'
  const file = join(directory, fileName ?? filename)
  const spec = gravityY === undefined ? scene.spec : { ...scene.spec, gravity: { ...scene.spec.gravity, y: gravityY } }
  const forbiddenPaths = ['/api/session/prompt', '/api/session/fork', '/api/artifactBranchResults/continueParticle',
    '/api/artifactExports/create', '/api/artifactExports/read']
  const forbiddenRequests: string[] = []
  const watchExport = (request: Request): void => {
    const path = new URL(request.url()).pathname
    if (forbiddenPaths.includes(path)) forbiddenRequests.push(path)
  }

  const offlineContext = await browser.newContext({ offline: true })
  const network: string[] = []
  const errors: string[] = []
  let playedStep: number
  page.on('request', watchExport)
  try {
    const [download, response] = await Promise.all([
      page.waitForEvent('download'),
      page.waitForResponse(receipt => new URL(receipt.url()).pathname === endpoint),
      card.getByRole('button', { name: 'Download experiment HTML', exact: true }).and(card.locator(marker)).click(),
    ])
    expect(response.ok()).toBe(true)
    expect(response.request().postDataJSON()).toHaveProperty('payload.args.request', { sessionId, ...address })
    expect(download.suggestedFilename()).toBe(filename)
    await download.saveAs(file)

    const offline = await offlineContext.newPage()
    offline.on('request', (request) => { if (/^https?:/u.test(request.url())) network.push(request.url()) })
    offline.on('websocket', (socket) => { network.push(socket.url()) })
    offline.on('pageerror', (error) => { errors.push(error.message) })
    await offline.goto(pathToFileURL(file).href)
    await offline.locator('canvas#plot').waitFor({ state: 'visible' })
    expect(await offline.title()).toBe(`${scene.title} · animation`)
    expect(await offline.evaluate('spec')).toEqual(spec)
    const origin: unknown = JSON.parse(await offline.locator('#artifact-export-origin-data').textContent() ?? 'null')
    expect(origin).toMatchObject({ exporterVersion: 1, sessionId, artifactId: scene.artifactId, revision: scene.revision,
      checkpoint: reading.checkpoint, [kind]: address })
    expect(origin).not.toHaveProperty(sent ? 'returnedEvidence' : 'sentQuestion')

    const readout = (label: string) => offline.locator('#readout > div')
      .filter({ has: offline.getByText(label, { exact: true }) }).locator('strong')
    const stepCount = readout('step')
    const expectLockedReading = async (): Promise<void> => {
      expect(await stepCount.textContent()).toBe(String(reading.checkpoint.stepCount))
      expect(await readout('time').textContent()).toBe(reading.values.time.toFixed(2))
      expect(await readout('gravity').textContent()).toBe(`${spec.gravity.x.toFixed(2)}, ${spec.gravity.y.toFixed(2)}`)
      const rows = offline.locator('#particle-readings tr[data-particle-id]')
      expect(await rows.count()).toBe(reading.values.particles.length)
      for (const [index, particle] of reading.values.particles.entries()) {
        const row = rows.nth(index)
        expect(await row.getAttribute('data-particle-id')).toBe(particle.id)
        for (const coordinate of ['x', 'y', 'vx', 'vy'] as const) {
          expect(await row.locator(`[data-particle-coordinate="${coordinate}"]`).textContent()).toBe(String(particle[coordinate]))
        }
      }
    }
    await expectLockedReading()
    const play = offline.getByRole('button', { name: 'Play', exact: true })
    await play.click()
    await expect.poll(async () => Number(await stepCount.textContent())).toBeGreaterThan(reading.checkpoint.stepCount)
    playedStep = Number(await stepCount.textContent())
    await offline.getByRole('button', { name: 'Reset', exact: true }).click()
    await expectLockedReading()
    await play.waitFor({ state: 'visible' })
    if (screenshot !== undefined) await offline.screenshot({ path: join(directory, screenshot) })
    expect(network).toEqual([])
    expect(errors).toEqual([])
  } finally {
    page.off('request', watchExport)
    await offlineContext.close()
  }
  expect(forbiddenRequests).toEqual([])
  return { filename: fileName ?? filename, sessionId, ...address, artifactId: scene.artifactId, revision: scene.revision,
    gravity: spec.gravity, locked: reading, playedStep, exactLockedReadingRestoredAfterReset: true, offlineRequests: 0,
    forbiddenRequests }
}
