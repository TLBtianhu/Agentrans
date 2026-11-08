import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'
import { expect, it, onTestFinished } from 'vitest'

const networkGuard = new URL('../../../../../packages/test-support/session-snapshot/tests/fixtures/replay-network-guard.mjs', import.meta.url)

function auditEvent(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Expected a network audit event')
  return value as Record<string, unknown>
}

it.each(['sdk', 'sdk-minimal'])('the public SDK rejects an explicitly disabled provider in the %s profile', async (profile) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sdk-provider-admission-'))
  const owned: { harness?: DeepSeekHarness } = {}
  onTestFinished(async () => {
    // Retain the files if process cleanup cannot prove that its child exited.
    await owned.harness?.close()
    await rm(root, { recursive: true, force: true })
  })
  const home = join(root, 'home')
  const local = join(root, 'local')
  const roaming = join(root, 'roaming')
  await Promise.all([home, local, roaming].map(path => mkdir(path)))
  const patch = join(root, 'disabled-provider.patch.yml')
  const auditFile = join(root, 'network-audit.jsonl')
  await writeFile(patch, JSON.stringify([{ id: 'llm-deepseek', disabled: true }]))
  // Preserve executable discovery without inheriting credentials, proxies or Node preloads.
  const environment = Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP']
    .flatMap(name => process.env[name] === undefined ? [] : [[name, process.env[name]]]))
  const harness = owned.harness = new DeepSeekHarness({
    profile, cwd: root, processCwd: root, dshHome: home, patches: [patch],
    provider: 'deepseek-official', model: 'deepseek-flash', initializeTimeoutMs: 30_000,
    env: {
      ...environment, HOME: home, USERPROFILE: home, LOCALAPPDATA: local, APPDATA: roaming,
      DSH_AGENTS_HOME: join(root, 'agents'),
      DEEPSEEK_API_KEY: 'keyless-provider-admission-test', DEEPSEEK_BASE_URL: 'https://api.deepseek.com/anthropic',
      NODE_OPTIONS: `--disable-warning=ExperimentalWarning --import=${JSON.stringify(networkGuard.href)}`,
      DSH_SNAPSHOT_NETWORK_AUDIT_FILE: auditFile,
    },
  })

  await expect(harness.start()).rejects.toThrow('no adapter registered for provider "deepseek-official"')
  await harness.close()
  const audit = (await readFile(auditFile, 'utf8')).trim().split('\n').map(line => auditEvent(JSON.parse(line)))
  expect(audit.some(event => event.kind === 'installed' && typeof event.pid === 'number' && event.pid !== process.pid)).toBe(true)
  expect(audit.filter(event => event.kind === 'blocked')).toEqual([])
}, 60_000)
