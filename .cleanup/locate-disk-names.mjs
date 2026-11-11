import { execFileSync } from 'node:child_process'

/** Locate the on-disk names a user can still meet. */
const patterns = ['.dsh-sign-', 'dsh-spill-', '.dsh-module-fallback', '.dsh-desktop-command.json', '.dsh-command-backup-', '.dsh-command-new-', "schemes: ['dsh']"]
const output = execFileSync('git', ['grep', '-n', '-F', ...patterns.flatMap(pattern => ['-e', pattern]), '--', 'packages', 'apps', 'scripts'], {
  encoding: 'utf8',
  maxBuffer: 256 * 1024 * 1024,
})
console.log(output.split('\n').filter(Boolean).join('\n'))
