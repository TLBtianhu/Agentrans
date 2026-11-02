/** Real-browser Artifact sandbox smoke; no DSH server or external network is required. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(new URL('../../../../apps/web/package.json', import.meta.url))
const { chromium } = require('playwright')

const CSP = [
  "default-src 'none'", "script-src 'unsafe-inline'", "style-src 'unsafe-inline'",
  'img-src data: blob:', 'font-src data:', 'media-src data: blob:', "connect-src 'none'",
  "frame-src 'none'", "child-src 'none'", "worker-src 'none'", "object-src 'none'",
  "form-action 'none'", "base-uri 'none'", "navigate-to 'none'",
].join('; ')

const source = `<!doctype html><html><head><meta charset="utf-8"><title>Counter</title></head><body>
<canvas id="value" width="120" height="40"></canvas><button id="increment" type="button">Add</button>
<script>
const canvas = document.querySelector('#value')
const context = canvas.getContext('2d')
let value = 0
function draw() { context.clearRect(0, 0, 120, 40); context.fillText(String(value), 8, 24) }
document.querySelector('#increment').addEventListener('click', () => {
  value += 2
  draw()
  parent.postMessage({ kind: 'artifact-action', artifactId: 'counter', revision: 1, action: 'counter.changed', payload: { value } }, '*')
})
draw()
</script></body></html>`

const browser = await chromium.launch({ channel: 'msedge', headless: true })
try {
  const page = await browser.newPage()
  await page.setContent('<iframe sandbox="allow-scripts" title="Artifact smoke"></iframe>')
  await page.evaluate(() => {
    window.__artifactActions = []
    window.addEventListener('message', event => { window.__artifactActions.push(event.data) })
  })
  const documentHtml = source.replace('<head>', `<head><meta http-equiv="Content-Security-Policy" content="${CSP}">`)
  await page.locator('iframe').evaluate((frame, html) => { frame.srcdoc = html }, documentHtml)

  const frame = page.mainFrame().childFrames()[0]
  assert.ok(frame, 'expected the Artifact child frame')
  await frame.click('#increment')
  await page.waitForFunction(() => window.__artifactActions.length === 1)
  const action = await page.evaluate(() => window.__artifactActions[0])
  assert.deepEqual(action, {
    kind: 'artifact-action', artifactId: 'counter', revision: 1, action: 'counter.changed', payload: { value: 2 },
  })
  assert.equal(await frame.locator('#value').evaluate(canvas => canvas.getContext('2d') !== null), true)

  const parentAccess = await frame.evaluate(() => {
    try { return window.parent.document.location.href } catch { return 'denied' }
  })
  assert.equal(parentAccess, 'denied')

  const networkAccess = await frame.evaluate(async () => {
    try { await fetch('https://example.com/'); return 'allowed' } catch { return 'blocked' }
  })
  assert.equal(networkAccess, 'blocked')
  console.log(JSON.stringify({ ok: true, action, parentAccess, networkAccess }))
} finally {
  await browser.close()
}
