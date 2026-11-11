import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const guard = new URL('./fixtures/replay-network-guard.mjs', import.meta.url).href
// The negative probes cannot reach a real network even when the tested guard regresses.
const boundaryProbe = `data:text/javascript,${encodeURIComponent(`
  import { Socket } from 'node:net'
  const fetch = globalThis.fetch
  globalThis.fetch = function (...args) {
    if (String(args[0]).includes('example.invalid')) throw new Error('original fetch reached')
    return fetch(...args)
  }
  const connect = Socket.prototype.connect
  Socket.prototype.connect = function (...args) {
    if (JSON.stringify(args).includes('example.invalid')) throw new Error('original socket reached')
    return connect.apply(this, args)
  }
`)}`

async function runGuarded(source: string, auditFile: string): Promise<string> {
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
    env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH,
      NODE_OPTIONS: `--import=${boundaryProbe} --import=${guard}`, AGENTRANS_SNAPSHOT_NETWORK_AUDIT_FILE: auditFile },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', resolve)
  })
  try {
    const code = await exited
    if (code !== 0) throw new Error(`guarded child exited ${String(code)}: ${stderr}`)
    return stdout
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill()
      await exited
    }
  }
}

describe('snapshot replay process networking', () => {
  it('serves a real loopback fixture and refuses external fetch/socket calls before sending', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-replay-network-'))
    const auditFile = join(root, 'audit.jsonl')
    const requests: string[] = []
    const server = createServer((request, response) => {
      requests.push(request.url ?? '')
      response.end('local-fixture')
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    try {
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('missing local fixture port')
      const stdout = await runGuarded(`
        import assert from 'node:assert/strict'
        import { Socket } from 'node:net'
        assert.equal(await (await fetch('http://127.0.0.1:${String(address.port)}/fixture')).text(), 'local-fixture')
        await assert.rejects(fetch('https://example.invalid/must-not-send'), { code: 'SNAPSHOT_EXTERNAL_NETWORK' })
        assert.throws(() => new Socket().connect({ host: 'example.invalid', port: 443 }), { code: 'SNAPSHOT_EXTERNAL_NETWORK' })
        console.log('local fixture accepted; external requests refused')
      `, auditFile)
      expect(stdout.trim()).toBe('local fixture accepted; external requests refused')
      expect(requests).toEqual(['/fixture'])
      const audit = (await readFile(auditFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
      expect(audit.map(event => event.kind)).toEqual(['installed', 'blocked', 'blocked'])
      expect(audit.slice(1).map(event => event.transport)).toEqual(['fetch', 'socket'])
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => {
        if (error) reject(error)
        else resolve()
      }))
      await rm(root, { recursive: true, force: true })
    }
  })

  it('inherits the refusal into a Node child without passing another preload argument', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-replay-network-child-'))
    const auditFile = join(root, 'audit.jsonl')
    try {
      await runGuarded(`
        import { spawn } from 'node:child_process'
        const child = spawn(process.execPath, ['--input-type=module', '-e',
          "import assert from 'node:assert/strict'; await assert.rejects(fetch('https://example.invalid/inherited'), { code: 'SNAPSHOT_EXTERNAL_NETWORK' })"],
          { stdio: 'inherit' })
        const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
        if (code !== 0) throw new Error('nested guarded child failed')
      `, auditFile)
      const audit = (await readFile(auditFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
      expect(audit.filter(event => event.kind === 'installed')).toHaveLength(2)
      expect(new Set(audit.map(event => event.pid)).size).toBe(2)
      expect(audit.filter(event => event.kind === 'blocked')).toMatchObject([{ transport: 'fetch' }])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
