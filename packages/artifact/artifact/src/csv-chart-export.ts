/** Standalone HTML view of one immutable grouped CSV revision. */
import type { CsvBarChartSpec } from './scene.ts'
import type { SceneExportOrigin } from './scene-export.ts'

const aggregateLabel = { count: 'Count', sum: 'Sum', mean: 'Mean', min: 'Minimum', max: 'Maximum' } as const

function htmlText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}

function jsonData(value: object): string {
  return JSON.stringify(value).replaceAll('<', '\\u003c')
}

/**
 * Render the frozen recipe and results as offline bars with selectable readouts.
 * @param spec - Calculated chart revision being exported.
 * @param title - Chart title shown in the page.
 * @param origin - Source revision recorded in the exported page, when known.
 * @returns A self-contained HTML document with script-safe embedded JSON.
 */
export function buildCsvChartHtml(spec: CsvBarChartSpec, title: string, origin?: SceneExportOrigin): string {
  const groups = spec.groups
  const magnitude = Math.max(0, ...groups.map(group => Math.abs(group.value))) || 1
  const scaled = groups.map(group => group.value / magnitude)
  const min = Math.min(0, ...scaled)
  const max = Math.max(0, ...scaled)
  const span = max - min || 1
  const position = (value: number): number => (value - min) / span * 100
  const zero = position(0)
  const rows = groups.map((group, index) => {
    const end = position(group.value / magnitude)
    const key = htmlText(group.key)
    return `<li><button type="button" data-group-key="${key}" aria-pressed="${index === 0}">`
      + `<span class="group">${key || '(Blank)'}</span>`
      + `<span class="track" aria-hidden="true"><span class="bar" style="--start:${Math.min(zero, end)}%;--length:${Math.abs(end - zero)}%"></span></span>`
      + `<span class="number">${group.value}</span></button></li>`
  }).join('\n')
  const identity = origin === undefined ? '' : `<p class="meta">${htmlText(origin.artifactId)} · revision ${origin.revision}</p>`
    + `<script type="application/json" id="artifact-export-origin-data">${jsonData(origin)}</script>`
  const valueColumn = spec.valueColumn === undefined ? '' : ` · ${htmlText(spec.valueColumn)}`
  const filter = spec.filter === undefined ? '' : `<p class="meta" data-csv-export-filter>Filter: ${htmlText(JSON.stringify(spec.filter.column))} = `
    + `${htmlText(JSON.stringify(spec.filter.value))}</p>`
  const reading = groups.length === 0 ? '<p>No matching records</p>'
    : '<output aria-live="polite"><strong data-csv-export-group></strong> · <span data-csv-export-value></span> · '
      + '<span data-csv-export-count></span> rows</output>'
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>${htmlText(title)}</title>
<style>
:root{color-scheme:light dark;font:16px/1.5 system-ui,sans-serif;--bar:#4564bc;--active:#176a58;--line:#727784}
@media(prefers-color-scheme:dark){:root{--bar:#91a9ff;--active:#72d5b9;--line:#a9aec0}}
body{margin:0;background:Canvas;color:CanvasText}
main{max-width:48rem;margin:auto;padding:clamp(1rem,4vw,2.5rem)}
h1,p{overflow-wrap:anywhere} h1{font-size:clamp(1.5rem,5vw,2.25rem);margin:0}
.meta{margin:.5rem 0;color:GrayText}
ul{list-style:none;padding:0;margin:1.25rem 0}
button{width:100%;box-sizing:border-box;display:grid;grid-template-columns:minmax(5rem,1fr) minmax(3rem,2fr) clamp(3rem,22%,9rem);align-items:center;gap:.75rem;
min-height:2.75rem;padding:.35rem .5rem;border:1px solid transparent;border-radius:.35rem;background:transparent;color:inherit;text-align:start;font:inherit}
button:hover,button[aria-pressed=true]{border-color:var(--active)}
button:focus-visible{outline:2px solid var(--bar);outline-offset:2px}
.group{overflow-wrap:anywhere;white-space:pre-wrap}
.track{height:1.2rem;position:relative;background:color-mix(in srgb,CanvasText 7%,Canvas)}
.track::after{content:"";position:absolute;inset-block:0;left:clamp(0px,var(--zero),calc(100% - 1px));border-left:1px solid var(--line)}
.bar{position:absolute;inset-block:.12rem;left:var(--start);width:var(--length);border-radius:.15rem;background:var(--bar)}
button[aria-pressed=true] .bar{background:var(--active)}
.number{font-variant-numeric:tabular-nums;overflow-wrap:anywhere;text-align:end}
output{display:block;padding:.75rem .875rem;border:1px solid var(--line);border-radius:.35rem;overflow-wrap:anywhere}
@media(max-width:28rem){button{grid-template-columns:minmax(0,1fr) auto;gap:.25rem .5rem}.track{grid-column:1/-1;grid-row:2}}
</style>
<main>
<h1>${htmlText(title)}</h1>
${identity}
<p class="meta"><span data-csv-export-aggregate="${spec.aggregate}">${aggregateLabel[spec.aggregate]}</span>${valueColumn} · Grouped by ${htmlText(spec.groupBy)} · ${spec.rowCount} rows</p>
${filter}
<ul id="csv-group-chart" aria-label="CSV group readings" style="--zero:${zero}%">
${rows}
</ul>
${reading}
</main>
<script type="application/json" id="csv-export-spec">${jsonData(spec)}</script>
<script>
const spec = JSON.parse(document.getElementById('csv-export-spec').textContent)
const buttons = [...document.querySelectorAll('#csv-group-chart button')]
const key = document.querySelector('[data-csv-export-group]')
const value = document.querySelector('[data-csv-export-value]')
const count = document.querySelector('[data-csv-export-count]')
function select(index) {
  buttons.forEach((button, position) => button.setAttribute('aria-pressed', String(index === position)))
  const group = spec.groups[index]
  key.textContent = group.key || '(Blank)'
  value.textContent = String(group.value)
  count.textContent = String(group.count)
}
buttons.forEach((button, index) => button.addEventListener('click', () => select(index)))
if (buttons.length > 0) select(0)
</script>
</html>
`
}
