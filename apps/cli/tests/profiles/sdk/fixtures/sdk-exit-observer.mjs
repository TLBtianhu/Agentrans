/** Test-process observer of natural exit; it creates no asynchronous work or Cordis effects. */
import { appendFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'

const auditPath = process.env.AGENTRANS_TEST_EXIT_AUDIT
if (auditPath === undefined || !isAbsolute(auditPath)) throw new Error('SDK exit observer requires an absolute test-owned audit path')
process.once('beforeExit', code => {
  appendFileSync(auditPath, JSON.stringify({ event: 'beforeExit', pid: process.pid, code }) + '\n')
})
process.once('exit', code => {
  appendFileSync(auditPath, JSON.stringify({ event: 'exit', pid: process.pid, code }) + '\n')
})
