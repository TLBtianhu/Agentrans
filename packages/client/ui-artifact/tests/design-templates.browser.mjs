import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join } from 'node:path'

const webRequire = createRequire(new URL('../../../../apps/web/package.json', import.meta.url))
const { chromium } = webRequire('playwright')
const root = fileURLToPath(new URL('../../../../.agents/skills/artifact-design/references/', import.meta.url))
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-sandbox'] })
const evidence = []

try {
  for (const name of ['prediction-lab', 'parameter-explorer', 'function-plot', 'flowchart', 'particle-system']) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, colorScheme: 'light' })
    const errors = []
    const failedRequests = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('requestfailed', request => failedRequests.push(request.url()))
    await page.goto(pathToFileURL(join(root, `${name}.html`)).href)
    await page.waitForTimeout(120)

    if (name === 'prediction-lab') {
      await page.selectOption('#angle', '45')
      await page.click('#predict-hit')
      await page.click('#launch')
      await page.waitForFunction(() => document.getElementById('result')?.textContent?.includes('prediction matched'))
    } else if (name === 'function-plot') {
      await page.click('#integral')
      await page.click('#zoom-in')
      await page.mouse.move(400, 400)
      await page.waitForFunction(() => document.getElementById('readout')?.textContent?.includes('f′'))
      await page.click('#step')
      await page.waitForFunction(() => document.getElementById('parameter-value')?.textContent !== '1.00')
      await page.click('#reset')
      await page.waitForFunction(() => document.getElementById('parameter-value')?.textContent === '1.00')
    } else if (name === 'flowchart') {
      await page.click('[data-node-id="manipulate"]')
      await page.click('#step')
      await page.waitForFunction(() => document.getElementById('selected-value')?.textContent === 'Feedback')
      await page.click('#zoom-in')
      await page.waitForFunction(() => document.getElementById('zoom-value')?.textContent === '1.25×')
      await page.click('#reset')
      await page.waitForFunction(() => document.getElementById('selected-value')?.textContent === 'Observe')
    } else if (name === 'particle-system') {
      await page.click('#step')
      await page.waitForFunction(() => document.getElementById('time-value')?.textContent === '0.03')
      await page.click('#zoom-in')
      await page.waitForFunction(() => document.getElementById('zoom-value')?.textContent === '1.25×')
      await page.click('#reset')
      await page.waitForFunction(() => document.getElementById('time-value')?.textContent === '0.00')
    } else {
      await page.click('#step')
      await page.waitForFunction(() => document.getElementById('summary')?.textContent?.includes('t = 0.10 s'))
      await page.click('#play')
      await page.waitForTimeout(160)
      await page.click('#play')
      await page.waitForFunction(() => document.getElementById('summary')?.textContent?.includes('paused'))
    }

    for (const colorScheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme })
      for (const viewport of [{ width: 1440, height: 960 }, { width: 390, height: 844 }]) {
        await page.setViewportSize(viewport)
        await page.waitForTimeout(80)
        const overflow = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, viewport: window.innerWidth }))
        assert.ok(overflow.width <= overflow.viewport, `${name}: horizontal overflow ${JSON.stringify(overflow)}`)
      }
    }

    const screenshot = `C:/agent制作/artifacts/design-${name}.png`
    await page.setViewportSize({ width: 1440, height: 960 })
    await page.emulateMedia({ colorScheme: 'light' })
    await page.screenshot({ path: screenshot, fullPage: true })
    assert.deepEqual(errors, [], `${name}: page errors`)
    assert.deepEqual(failedRequests, [], `${name}: external requests`)
    evidence.push({ name, screenshot })
    await page.close()
  }
} finally {
  await browser.close()
}

console.log(JSON.stringify({ ok: true, evidence }, null, 2))
