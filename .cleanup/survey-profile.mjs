import { execFileSync } from 'node:child_process'

/** Check whether a `dsh` manifest key or profile name is a persisted contract. */
const patterns = ['dsh.profile.bundles', 'profiles/dsh', "loadLayeredEnv('dsh')", "loadProfileDirectory('dsh'", "'dsh', profile", '"dsh": {']
const output = execFileSync('git', ['grep', '-n', '-F', ...patterns.flatMap(pattern => ['-e', pattern]), '--', 'packages', 'apps', 'docs'], {
  encoding: 'utf8',
  maxBuffer: 256 * 1024 * 1024,
})
const lines = output.split('\n').filter(Boolean)
console.log(lines.slice(0, 15).join('\n'))
console.log(`total ${String(lines.length)}`)
