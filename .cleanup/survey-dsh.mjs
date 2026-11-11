import { execFileSync } from 'node:child_process'

/** Survey the identifiers that still carry the retired product name. */
const patterns = ["'dsh'", '"dsh"', '.dsh-', 'dsh-spill', "'dsh'"]
const output = execFileSync('git', ['grep', '-n', '-F', ...patterns.flatMap(pattern => ['-e', pattern]), '--', 'packages', 'apps', 'scripts'], {
  encoding: 'utf8',
  maxBuffer: 256 * 1024 * 1024,
})
const lines = output.split('\n').filter(Boolean).filter(line => !/\/tests?\//u.test(line))
const unique = [...new Set(lines.map(line => line.replace(/^[^:]+:\d+:/u, '').trim().slice(0, 110)))]
console.log(unique.slice(0, 25).join('\n'))
console.log(`total ${String(lines.length)}`)
