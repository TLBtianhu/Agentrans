/** Offline HTML for the exact pages attached to a sent CSV comparison or explanation. */
import type {
  ArtifactCsvComparisonPage, ArtifactCsvComparisonReading, ArtifactCsvComparisonReturnCard, ArtifactCsvComparisonReturnCards,
} from '@agentrans/artifact-followup/types'
import { csvComparisonHtmlLabels, type CsvComparisonHtmlLabels } from './csv-comparison-export-locales.ts'

const statuses = ['kept', 'excluded', 'added'] as const
type SectionHeading = 'h2' | 'h3'
type ReturnSide = 'first' | 'second'

function importedNotice(labels: CsvComparisonHtmlLabels, source: keyof CsvComparisonHtmlLabels['importSource'],
  provenance: 'user-imported' | undefined): string {
  if (provenance === undefined) return ''
  return `<p data-csv-compare-provenance>${labels.imported}</p>\n`
    + `<p data-csv-import-source="${source}">${labels.importSource[source]}</p>\n`
}

function escapeText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function escapeAttribute(value: string): string {
  return escapeText(value).replaceAll('"', '&quot;')
}

function cell(value: string | undefined, labels: CsvComparisonHtmlLabels): string {
  if (value === undefined) return '—'
  if (value === '') return labels.blank
  return escapeText(value)
}

function reading(labels: CsvComparisonHtmlLabels, side: 'original' | 'locked' | 'return', title: string,
  { groupKey, aggregate, valueColumn, filter, value, count }: ArtifactCsvComparisonReading, heading: SectionHeading): string {
  const metric = labels.aggregate[aggregate]
  const calculation = valueColumn === undefined ? metric : labels.calculation(metric, cell(valueColumn, labels))
  const filterText = filter === undefined ? labels.noFilter : `${cell(filter.column, labels)} = ${cell(filter.value, labels)}`
  const marker = side === 'return' ? 'data-csv-return-reading' : `data-csv-compare-reading="${side}"`
  return `<section ${marker}>
<${heading}>${title}</${heading}>
<dl class="reading">
<div><dt>${labels.group}</dt><dd data-csv-reading="key">${cell(groupKey, labels)}</dd></div>
<div><dt>${labels.aggregation}</dt><dd data-csv-reading="aggregate">${calculation}</dd></div>
<div><dt>${labels.filter}</dt><dd data-csv-reading="filter">${filterText}</dd></div>
<div><dt>${labels.value}</dt><dd data-csv-reading="value">${value}</dd></div>
<div><dt>${labels.rows}</dt><dd data-csv-reading="count">${count}</dd></div>
</dl>
</section>`
}

function comparisonPage(labels: CsvComparisonHtmlLabels, page: ArtifactCsvComparisonPage, heading: SectionHeading,
  [earlier, later]: readonly [string, string] = [labels.originalReading, labels.lockedReading]): string {
  const currentFilter = page.current.filter?.column
  const originalFilter = page.original.filter?.column === currentFilter ? undefined : page.original.filter?.column
  const valueColumn = page.current.valueColumn ?? page.original.valueColumn
  const headings = [originalFilter, currentFilter, valueColumn]
    .filter(heading => heading !== undefined).map(heading => `<th scope="col">${cell(heading, labels)}</th>`).join('')
  const first = page.rows.length === 0 ? 0 : page.offset + 1
  const last = page.rows.length === 0 ? 0 : page.offset + page.rows.length
  const counts = statuses.map(status =>
    `<div><dt>${labels[status]}</dt><dd data-csv-compare-count="${status}">${page[status]}</dd></div>`).join('')
  const rows = page.rows.map(row => `<tr data-csv-compare-record="${row.record}" data-csv-compare-status="${row.status}">
<th scope="row">${row.record}</th><td data-csv-compare-cell="status">${labels[row.status]}</td>`
    + (originalFilter === undefined ? '' : `<td data-csv-compare-cell="original-filter">${cell(row.originalFilterValue, labels)}</td>`)
    + (currentFilter === undefined ? '' : `<td data-csv-compare-cell="current-filter">${cell(row.currentFilterValue, labels)}</td>`)
    + (valueColumn === undefined ? '' : `<td data-csv-compare-cell="value">${cell(row.value, labels)}</td>`)
    + '</tr>').join('\n')

  return `<div class="readings">
${reading(labels, 'original', earlier, page.original, heading)}
${reading(labels, 'locked', later, page.current, heading)}
</div>
<section>
<${heading}>${labels.membership}</${heading}>
<dl class="counts">${counts}</dl>
<p data-csv-compare-range>${labels.range(first, last, page.total)}</p>
<table aria-label="${escapeAttribute(labels.reviewedRecords)}">
<thead><tr><th scope="col">${labels.record}</th><th scope="col">${labels.status}</th>${headings}</tr></thead>
<tbody>
${rows}
</tbody>
</table>
</section>`
}

function chartGroups(labels: CsvComparisonHtmlLabels, { groupBy, groups }: ArtifactCsvComparisonReturnCard): string {
  const rows = groups.map(group => `<tr data-csv-return-group>
<th scope="row" data-csv-return-group-cell="key">${cell(group.key, labels)}</th>
<td data-csv-return-group-cell="value">${group.value}</td><td data-csv-return-group-cell="count">${group.count}</td>
</tr>`).join('\n')
  return `<table aria-label="${escapeAttribute(labels.chartGroups)}">
<thead><tr><th scope="col" data-csv-return-group-by>${cell(groupBy, labels)}</th><th scope="col">${labels.value}</th><th scope="col">${labels.rows}</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>`
}

function returnRecords(labels: CsvComparisonHtmlLabels, side: ReturnSide, { filter, valueColumn }: ArtifactCsvComparisonReading,
  page: ArtifactCsvComparisonPage): string {
  const isEarlier = side === 'first'
  const otherOnly = isEarlier ? 'added' : 'excluded'
  const selected = page.rows.filter(row => row.status !== otherOnly)
  if (selected.length === 0) return `<p>${labels.noReturnRows}</p>`
  const headings = [filter?.column, valueColumn].filter(heading => heading !== undefined)
    .map(heading => `<th scope="col">${cell(heading, labels)}</th>`).join('')
  const rows = selected.map(row => `<tr data-csv-return-record="${row.record}"><th scope="row">${row.record}</th>`
    + (filter === undefined ? '' : `<td data-csv-return-cell="filter">${cell(isEarlier ? row.originalFilterValue : row.currentFilterValue, labels)}</td>`)
    + (valueColumn === undefined ? '' : `<td data-csv-return-cell="value">${cell(row.value, labels)}</td>`)
    + '</tr>').join('\n')
  return `<table aria-label="${escapeAttribute(labels.returnRecords)}">
<thead><tr><th scope="col">${labels.record}</th>${headings}</tr></thead>
<tbody>
${rows}
</tbody>
</table>`
}

function originalReturn(
  labels: CsvComparisonHtmlLabels, side: ReturnSide, label: string, original: ArtifactCsvComparisonReturnCard,
  page: ArtifactCsvComparisonPage,
): string {
  const paragraphs = original.conclusion.map(block => `<p>${escapeText(block)}</p>`).join('\n')
  const saved = side === 'first' ? page.original : page.current
  return `<details data-csv-return-source="${side}">
<summary>${label}</summary>
<div class="originalReturnContent">
<div><h3 data-csv-return-title>${escapeText(original.title)}</h3><p data-csv-return-revision>${labels.revision(original.revision)}</p></div>
<section><h3>${labels.returnConclusion}</h3><div class="returnConclusion" data-csv-return-conclusion>${paragraphs}</div></section>
${reading(labels, 'return', labels.recordedReading, saved, 'h3')}
<section><h3>${labels.chartGroups}</h3>${chartGroups(labels, original)}</section>
<section><h3>${labels.returnRecords}</h3>${returnRecords(labels, side, saved, page)}</section>
</div>
</details>`
}

function document(lang: string, title: string, body: string): Uint8Array {
  return new TextEncoder().encode(`<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>${title}</title>
<style>
:root { color-scheme: light dark; font: 16px/1.5 system-ui, sans-serif; --line: GrayText; }
body { margin: 0; background: Canvas; color: CanvasText; }
main { max-width: 56rem; margin: auto; padding: clamp(1rem, 5vw, 2.5rem); }
h1, h2, h3 { margin: 0 0 .5rem; }
h1 { font-size: clamp(1.5rem, 5vw, 2.25rem); }
h2, h3 { font-size: 1.125rem; }
.readings { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 19rem), 1fr)); gap: 1rem; margin-block: 1rem; }
.readings section { border: 1px solid var(--line); border-radius: .5rem; padding: .875rem; }
dl { margin: 0; }
.reading div { display: grid; grid-template-columns: 7rem minmax(0, 1fr); gap: .5rem; }
.counts { display: flex; flex-wrap: wrap; gap: .5rem 2rem; margin-bottom: 1rem; }
.counts div { display: flex; gap: .5rem; }
dd { margin: 0; }
dd, th, td { white-space: pre-wrap; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
table { border-collapse: collapse; width: 100%; }
th, td { padding: .35rem .5rem; border-bottom: 1px solid var(--line); text-align: start; }
.explanation { padding-inline-start: 1.5rem; }
.explanation li { margin-block: 1.25rem; padding-inline-start: .25rem; }
.explanation li::marker { font-weight: bold; }
.originalReturns, .originalReturnContent { display: grid; gap: .75rem; min-width: 0; }
.originalReturns { margin-block-start: 1.5rem; }
.originalReturnContent { margin-block-start: .75rem; overflow-wrap: anywhere; }
.originalReturnContent p { margin: 0; }
.returnConclusion p { margin-block-end: .5rem; white-space: pre-wrap; }
details { padding: .75rem; border: 1px solid var(--line); border-radius: .5rem; }
summary { cursor: pointer; font-weight: 600; }
@media print { body { background: #fff; color: #111; } .readings section, tr { break-inside: avoid; } }
</style>
</head>
<body>
<main>
<h1>${title}</h1>
${body}
</main>
</body>
</html>
`)
}

/**
 * Render one frozen comparison page as a standalone, script-free document.
 * @param page - The witnessed readings, full membership counts and reviewed records in their saved order.
 * @param provenance - Whether the readings and records were supplied by the user in an imported file.
 * @param locale - Preferred language for document labels.
 * @returns UTF-8 HTML with the exact reviewed range and no external resources.
 */
export function renderCsvComparisonHtml(page: ArtifactCsvComparisonPage, provenance?: 'user-imported', locale?: string): Uint8Array {
  const labels = csvComparisonHtmlLabels(locale)
  const notice = importedNotice(labels, 'single-page', provenance)
  return document(labels.lang, labels.lockedComparison, notice + comparisonPage(labels, page, 'h2'))
}

/**
 * Export a saved comparison and the two verified original return cards it addresses.
 * @param page - The exact reviewed page and full comparison membership totals.
 * @param returns - Original chart revisions and conclusions recovered from history or saved with a portable file.
 * @param provenance - Whether the comparison and cards came from a user-provided file.
 * @param locale - Preferred language for document labels.
 * @returns UTF-8 HTML with separate native disclosures and no external resources.
 */
export function renderCsvReturnedComparisonHtml(
  page: ArtifactCsvComparisonPage, returns: ArtifactCsvComparisonReturnCards, provenance?: 'user-imported', locale?: string,
): Uint8Array {
  const labels = csvComparisonHtmlLabels(locale)
  const sides = [labels.earlierReturn, labels.laterReturn] as const
  const notice = importedNotice(labels, 'return-comparison', provenance)
  return document(labels.lang, labels.lockedComparison, `${notice}${comparisonPage(labels, page, 'h2', sides)}
<section class="originalReturns" aria-label="${escapeAttribute(labels.originalReturns)}">
<h2>${labels.originalReturns}</h2>
${originalReturn(labels, 'first', sides[0], returns.first, page)}
${originalReturn(labels, 'second', sides[1], returns.second, page)}
</section>`)
}

/**
 * Explain the ordered recipe changes and retain both original reviewed pages.
 * @param aggregation - The witnessed comparison of the unfiltered mean and sum.
 * @param filtering - The witnessed comparison whose current reading is the filtered sum.
 * @param provenance - Whether both readings and records were supplied by the user in an imported file.
 * @param locale - Preferred language for document labels.
 * @returns UTF-8 HTML with two independent keyboard-accessible disclosures and no external resources.
 */
export function renderCsvComparisonExplanationHtml(
  aggregation: ArtifactCsvComparisonPage,
  filtering: ArtifactCsvComparisonPage,
  provenance?: 'user-imported',
  locale?: string,
): Uint8Array {
  const labels = csvComparisonHtmlLabels(locale)
  const notice = importedNotice(labels, 'two-step-explanation', provenance)
  return document(labels.lang, labels.explanation, `${notice}<ol class="explanation">
<li data-csv-explanation-step="aggregation">
<h2>${labels.changeAggregation}</h2>
<p>${labels.sameRows}</p>
<div class="readings" data-csv-explanation-readings>
${reading(labels, 'original', labels.unfilteredMean, aggregation.original, 'h3')}
${reading(labels, 'locked', labels.unfilteredSum, aggregation.current, 'h3')}
</div>
<details data-csv-explanation-locked-page="aggregation">
<summary>${labels.viewAggregation}</summary>
${comparisonPage(labels, aggregation, 'h3')}
</details>
</li>
<li data-csv-explanation-step="filtering">
<h2>${labels.applyFilter}</h2>
<p>${labels.matchingRows}</p>
<div class="readings" data-csv-explanation-readings>
${reading(labels, 'original', labels.unfilteredSum, aggregation.current, 'h3')}
${reading(labels, 'locked', labels.filteredSum, filtering.current, 'h3')}
</div>
<details data-csv-explanation-locked-page="filtering">
<summary>${labels.viewFiltering}</summary>
${comparisonPage(labels, filtering, 'h3')}
</details>
</li>
</ol>`)
}
