/** Static CSV comparison export preserves the saved page without interpreting its cells. */
import type { ArtifactCsvComparisonPage, ArtifactCsvComparisonReturnCards } from '@agentrans/artifact-followup/types'
import { expect, it } from 'vitest'
import { renderCsvComparisonExplanationHtml, renderCsvComparisonHtml, renderCsvReturnedComparisonHtml } from '../src/csv-comparison-export.ts'

function expectImportSource(native: string, imported: string, kind: string, label: string): void {
  const notice = '<p data-csv-compare-attribution>User-imported readings and records</p>\n'
    + `<p data-csv-import-source="${kind}">${label}</p>\n`
  expect(native).not.toContain('data-csv-import-source')
  expect(native).not.toContain('data-csv-compare-attribution')
  expect(imported).toContain(notice)
  expect(imported.replace(notice, '')).toBe(native)
}

it('exports only the reviewed record range with original values escaped as text', () => {
  const markup = '<img src="https://example.invalid/x" onerror="alert(1)">&'
  const page: ArtifactCsvComparisonPage = {
    original: { groupKey: '暖', aggregate: 'mean', valueColumn: 'Time <ms>', value: 30, count: 16,
      filter: { column: 'Start & end', value: markup } },
    current: { groupKey: '暖', aggregate: 'sum', valueColumn: 'Time <ms>', value: 35, count: 12,
      filter: { column: 'Batch', value: '' } },
    offset: 9, nextOffset: 11, total: 20, kept: 8, excluded: 8, added: 4,
    rows: [
      { record: 45, status: 'excluded', value: '25', originalFilterValue: markup, currentFilterValue: 'A' },
      { record: 88, status: 'added', value: '35', originalFilterValue: 'B', currentFilterValue: '' },
    ],
  }
  const html = new TextDecoder().decode(renderCsvComparisonHtml(page))
  const imported = new TextDecoder().decode(renderCsvComparisonHtml(page, 'user-imported'))
  expectImportSource(html, imported, 'single-page', 'JSON comparison with one locked page')
  const escapedMarkup = '&lt;img src="https://example.invalid/x" onerror="alert(1)"&gt;&amp;'
  expect(html).toContain('Records 10–11 of 20')
  expect(html).toContain('data-csv-reading="key">暖<')
  expect(html).toContain('Mean of Time &lt;ms&gt;')
  expect(html).toContain('Start &amp; end = ' + escapedMarkup)
  expect(html).toContain('Batch = (Blank)')
  expect(html).toContain('data-csv-compare-count="kept">8<')
  expect(html).toContain('data-csv-compare-count="added">4<')
  expect([...html.matchAll(/data-csv-compare-record="(\d+)"/gu)].map(([, record]) => record)).toEqual(['45', '88'])
  expect(html).toContain('data-csv-compare-cell="original-filter">' + escapedMarkup)
  expect(html).toContain('data-csv-compare-cell="current-filter">(Blank)<')
  expect(html).toContain("default-src 'none'")
  expect(html).not.toMatch(/<(?:img|script|iframe|link|a)\b/iu)

  const chinese = new TextDecoder().decode(renderCsvComparisonHtml(page, 'user-imported', 'ZH-cn'))
  expect(chinese).toContain('<html lang="zh-CN">')
  expect(chinese).toContain('<title>已锁定的 CSV 对照</title>')
  expect(chinese).toContain('<p data-csv-compare-attribution>用户导入的读数和记录</p>')
  expect(chinese).toContain('<p data-csv-import-source="single-page">含一页已锁定结果的 JSON 对照</p>')
  expect(chinese).toContain('data-csv-compare-range>第 10–11 条，共 20 条</p>')
  expect(chinese).toContain('aria-label="已核对记录"')
  expect(chinese).toContain('data-csv-compare-cell="status">排除</td>')
  expect(chinese).toContain('均值（Time &lt;ms&gt;）')
  expect(chinese).toContain('Start &amp; end = ' + escapedMarkup)
  expect(chinese).toContain('data-csv-compare-cell="current-filter">（空白）<')
  expect(chinese).toContain('data-csv-compare-cell="value">25<')
  expect(chinese).not.toMatch(/<(?:img|script|iframe|link|a)\b/iu)

  for (const [locale, language, title] of [
    ['ja', 'ja', '固定したCSV比較'], ['es', 'es', 'Comparación CSV bloqueada'], ['fr-CA', 'fr', 'Comparaison CSV verrouillée'],
    ['de', 'de', 'Fixierter CSV-Vergleich'], ['ru', 'ru', 'Зафиксированное сравнение CSV'], ['pt-BR', 'pt', 'Comparação CSV bloqueada'],
  ] as const) {
    const localized = new TextDecoder().decode(renderCsvComparisonHtml(page, undefined, locale))
    expect(localized).toContain(`<html lang="${language}">`)
    expect(localized).toContain(`<title>${title}</title>`)
    expect(localized).not.toContain('data-csv-import-source')
  }
  for (const locale of ['en', 'zz-ZZ', '__proto__', 'zh\"><script>injected</script>']) {
    expect(new TextDecoder().decode(renderCsvComparisonHtml(page, undefined, locale))).toBe(html)
  }
})

it('compares mean, sum and filtered sum while keeping both original pages separately expandable', () => {
  const original = { groupKey: 'Warm', aggregate: 'mean', valueColumn: 'Latency', value: 30, count: 2 } as const
  const current = { ...original, aggregate: 'sum', value: 60 } as const
  const markup = '</summary><script src="https://example.invalid/x"></script>'
  const aggregation: ArtifactCsvComparisonPage = {
    original, current, offset: 0, total: 2, kept: 2, excluded: 0, added: 0,
    rows: [{ record: 4, status: 'kept', value: '25' }, { record: 5, status: 'kept', value: '35' }],
  }
  const filtering: ArtifactCsvComparisonPage = {
    ...aggregation,
    current: { ...current, value: 35, count: 1, filter: { column: 'Batch', value: markup } },
    kept: 1, excluded: 1,
    rows: [{ record: 4, status: 'excluded', value: '25', currentFilterValue: 'A' },
      { record: 5, status: 'kept', value: '35', currentFilterValue: markup }],
  }
  const html = new TextDecoder().decode(renderCsvComparisonExplanationHtml(aggregation, filtering))
  const imported = new TextDecoder().decode(renderCsvComparisonExplanationHtml(aggregation, filtering, 'user-imported'))
  expectImportSource(html, imported, 'two-step-explanation', 'JSON two-step explanation with two original locked pages')
  expect(html).toContain('<h1>CSV comparison explanation</h1>')
  expect([...html.matchAll(/data-csv-explanation-step="([^"]+)"/gu)].map(([, step]) => step)).toEqual(['aggregation', 'filtering'])
  expect([...html.matchAll(/data-csv-reading="value">(\d+)</gu)].map(([, value]) => value)).toEqual([
    '30', '60', '30', '60', '60', '35', '30', '35',
  ])
  expect([...html.matchAll(/<details data-csv-explanation-locked-page="([^"]+)">/gu)].map(([, page]) => page)).toEqual([
    'aggregation', 'filtering',
  ])
  expect(html).toContain('<summary>View locked aggregation comparison</summary>')
  expect(html).toContain('<summary>View locked filtering comparison</summary>')
  expect(html).toContain('data-csv-compare-record="4" data-csv-compare-status="excluded"')
  expect(html).toContain('data-csv-compare-cell="current-filter">&lt;/summary&gt;&lt;script')
  expect(html).toContain("default-src 'none'")
  expect(html).not.toMatch(/<(?:img|script|iframe|link|a)\b/iu)

  const chinese = new TextDecoder().decode(renderCsvComparisonExplanationHtml(aggregation, filtering, 'user-imported', 'zh'))
  expect(chinese).toContain('<h1>CSV 对照两步解释</h1>')
  expect(chinese).toContain('<p data-csv-import-source="two-step-explanation">含两份原始锁定页的 JSON 两步解释</p>')
  expect(chinese).toContain('<details data-csv-explanation-locked-page="aggregation">\n<summary>查看锁定的聚合对照</summary>')
  expect(chinese).toContain('<details data-csv-explanation-locked-page="filtering">\n<summary>查看锁定的筛选对照</summary>')
  expect(chinese).toContain('<h3>未筛选的均值</h3>')
  expect(chinese).toContain('<h3>未筛选的总和</h3>')
  expect(chinese).toContain('<h3>筛选后的总和</h3>')
  expect(chinese).toContain('data-csv-reading="value">35<')
  expect(chinese).toContain('data-csv-compare-cell="current-filter">&lt;/summary&gt;&lt;script')
})

it('exports the two original return cards and only each side’s participating records on the saved page', () => {
  const markup = '</summary><script src="https://example.invalid/source.js"></script>&'
  const original = { groupKey: 'Warm', aggregate: 'mean', valueColumn: 'LatencyMs', value: 30, count: 5,
    filter: { column: 'Batch', value: 'A' } } as const
  const current = { ...original, aggregate: 'sum', value: 60, count: 4, filter: { column: 'Run & arm', value: 'B' } } as const
  const page: ArtifactCsvComparisonPage = {
    original, current, offset: 2, nextOffset: 5, total: 6, kept: 3, excluded: 2, added: 1,
    rows: [
      { record: 4, status: 'excluded', value: '25', originalFilterValue: 'A', currentFilterValue: 'C' },
      { record: 5, status: 'kept', value: '35', originalFilterValue: 'A', currentFilterValue: 'B' },
      { record: 9, status: 'added', value: '42', originalFilterValue: 'D', currentFilterValue: 'B' },
    ],
  }
  const returnCards: ArtifactCsvComparisonReturnCards = {
    first: { title: `Mean ${markup}`, revision: 2, conclusion: ['The reported mean is 30.', `Keep this text: ${markup}`],
      groupBy: 'Trial & cohort', groups: [{ key: 'Warm', value: 30, count: 5 }, { key: 'Cold', value: 50, count: 2 }] },
    second: { title: 'Total latency', revision: 4, conclusion: ['The reported sum is 60.'],
      groupBy: 'Trial & cohort', groups: [{ key: 'Warm', value: 60, count: 4 }, { key: 'Cold', value: 100, count: 2 }] },
  }
  const native = new TextDecoder().decode(renderCsvReturnedComparisonHtml(page, returnCards))
  const html = new TextDecoder().decode(renderCsvReturnedComparisonHtml(page, returnCards, 'user-imported'))
  expectImportSource(native, html, 'return-comparison', 'JSON comparison with two original return cards')
  expect(html).toContain('<h1>Locked CSV comparison</h1>')
  expect(html).toContain('<h2>Earlier return</h2>')
  expect(html).toContain('<h2>Later return</h2>')
  expect(html).toContain('Records 3–5 of 6')
  const sections = [...html.matchAll(/<details data-csv-return-source="(first|second)">([\s\S]*?)<\/details>/gu)]
  expect(sections.map(([, side]) => side)).toEqual(['first', 'second'])
  const first = sections[0]?.[2] ?? ''
  const second = sections[1]?.[2] ?? ''
  expect(first).toContain('<summary>Earlier return</summary>')
  expect(second).toContain('<summary>Later return</summary>')
  expect(first).toContain('data-csv-return-title>Mean &lt;/summary&gt;&lt;script')
  expect(first).toContain('data-csv-return-revision>Revision 2<')
  expect(second).toContain('data-csv-return-revision>Revision 4<')
  expect(first).toContain('data-csv-return-conclusion><p>The reported mean is 30.</p>\n<p>Keep this text: &lt;/summary&gt;&lt;script')
  expect(second).toContain('data-csv-return-conclusion><p>The reported sum is 60.</p>')
  expect(first).toContain('data-csv-reading="value">30<')
  expect(second).toContain('data-csv-reading="value">60<')
  expect(first).toContain('data-csv-return-group-by>Trial &amp; cohort<')
  expect(first).toContain('data-csv-return-group-cell="key">Cold<')
  expect(first).toContain('data-csv-return-group-cell="value">50<')
  expect(second).toContain('data-csv-return-group-cell="value">100<')
  expect(first).toContain('Participating records in the saved comparison page')
  expect(second).toContain('Participating records in the saved comparison page')
  const records = (section: string): readonly string[] =>
    [...section.matchAll(/data-csv-return-record="(\d+)"/gu)].map(match => match[1] ?? '')
  expect(records(first)).toEqual(['4', '5'])
  expect(records(second)).toEqual(['5', '9'])
  expect(first).toContain('data-csv-return-cell="filter">A<')
  expect(first).toContain('data-csv-return-cell="value">25<')
  expect(second).toContain('data-csv-return-cell="filter">B<')
  expect(second).toContain('data-csv-return-cell="value">42<')
  expect(html).toContain("default-src 'none'")
  expect(html).not.toMatch(/<(?:img|script|iframe|link|a|form)\b/iu)

  const chinese = new TextDecoder().decode(renderCsvReturnedComparisonHtml(page, returnCards, 'user-imported', 'zh'))
  expect(chinese).toContain('<p data-csv-import-source="return-comparison">含两张原始回流卡的 JSON 对照</p>')
  expect(chinese).toContain('aria-label="原始回流"')
  expect(chinese).toContain('<details data-csv-return-source="first">\n<summary>较早的回流</summary>')
  expect(chinese).toContain('<details data-csv-return-source="second">\n<summary>较晚的回流</summary>')
  expect(chinese).toContain('data-csv-return-revision>修订 2<')
  expect(chinese).toContain('aria-label="已保存的图表分组"')
  expect(chinese).toContain('aria-label="已保存对照页中的参与记录"')
  expect(chinese).toContain('data-csv-return-conclusion><p>The reported sum is 60.</p>')
  expect(chinese).toContain('data-csv-return-group-cell="value">100<')
})
