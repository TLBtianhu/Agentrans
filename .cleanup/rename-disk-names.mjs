import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

/** Rename the on-disk names a user can still meet to the product's own. */
const pairs = [
  ['.dsh-sign-', '.agentrans-sign-'],
  ['.dsh-module-fallback', '.agentrans-module-fallback'],
  ['.dsh-desktop-command.json', '.agentrans-desktop-command.json'],
  ['.dsh-command-backup-', '.agentrans-command-backup-'],
  ['.dsh-command-new-', '.agentrans-command-new-'],
  ['dsh-spill-', 'agentrans-spill-'],
  ["schemes: ['dsh']", "schemes: ['agentrans']"],
]

const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 })
  .split('\0')
  .filter(Boolean)
  .filter(file => !/^(\.agents\/notes\/archived|node_modules)\//u.test(file) && !/(^|\/)lib\//u.test(file))

let rewritten = 0
for (const file of files) {
  const before = readFileSync(file)
  if (before.subarray(0, 8192).includes(0)) continue
  let text = before.toString('utf8')
  const original = text
  for (const [from, to] of pairs) text = text.split(from).join(to)
  if (text === original) continue
  writeFileSync(file, text)
  rewritten += 1
}
console.log(`rewrote ${String(rewritten)} file(s)`)
