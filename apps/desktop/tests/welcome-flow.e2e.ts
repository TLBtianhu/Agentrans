/** Built Desktop Host acceptance; run after the repository build, without provider credentials. */

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { prepareProductState, productLaunchEnvironment, resolveProductLaunchContext } from '@agentrans/product-layout/launch-context'
import { DesktopHostProcess } from '../src/host-process.ts'
import { DesktopProjectManager } from '../src/project-manager.ts'
import { resolveDesktopPaths } from '../src/paths.ts'
import { connectDesktopWelcome, type DesktopWelcomeBackend } from '../src/welcome-backend.ts'
import { needsWelcome } from '../src/welcome-api.ts'
import { DESKTOP_HOST_PROTOCOL_VERSION } from '../src/host-protocol.ts'
import { prepareDevelopmentProject } from '../scripts/development-project.ts'

const repository = fileURLToPath(new URL('../../../', import.meta.url))
const builtHost = join(repository, 'apps/desktop-host/lib/index.js')
const networkGuard = new URL('../../../packages/test-support/session-snapshot/tests/fixtures/replay-network-guard.mjs', import.meta.url)

function version(path: string): string {
  return (JSON.parse(readFileSync(path, 'utf8')) as { version: string }).version
}

function auditEvent(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Expected a network audit event')
  return value as Record<string, unknown>
}

describe.skipIf(!existsSync(builtHost))('built Desktop welcome flow', () => {
  it('persists write-only API-key configuration without an account service across Host restarts', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'agentrans-desktop-welcome-')))
    let host: DesktopHostProcess | undefined
    let activeAudit: string | undefined
    let launch = 0
    let auditedLaunches = 0
    const pathsRequested: string[] = []
    const methods: string[] = []
    const stop = async (requireGraceful = false): Promise<void> => {
      await host?.stop(requireGraceful)
      host = undefined
      if (activeAudit === undefined) return
      const audit = readFileSync(activeAudit, 'utf8').trim().split('\n').map(line => auditEvent(JSON.parse(line)))
      const installed = audit.filter(event => event.kind === 'installed')
      expect(installed.length).toBeGreaterThan(0)
      for (const event of installed) {
        expect(typeof event.pid).toBe('number')
        expect(event.pid).not.toBe(process.pid)
      }
      const blocked = audit.filter(event => event.kind === 'blocked')
      expect(blocked).toEqual([])
      // The acceptance log retains only process/network facts, never RPC payloads or credentials.
      console.info(JSON.stringify({ test: 'desktop-welcome-api-key', launch, childPids: installed.map(event => event.pid), blocked: blocked.length }))
      auditedLaunches++
      activeAudit = undefined
    }
    try {
      const osHome = join(root, 'os-home')
      const local = join(root, 'local')
      const roaming = join(root, 'roaming')
      for (const path of [osHome, local, roaming]) mkdirSync(path)
      // Preserve executable discovery without inheriting credentials, proxies or Node preloads.
      const inherited: NodeJS.ProcessEnv = {
        ...Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP']
          .flatMap(name => process.env[name] === undefined ? [] : [[name, process.env[name]]])),
        HOME: osHome, USERPROFILE: osHome, LOCALAPPDATA: local, APPDATA: roaming,
        DSH_TELEMETRY_MODE: 'DISABLED',
        DSH_CLIENT_VERSION: version(join(repository, 'apps/desktop/package.json')),
        NODE_OPTIONS: `--import=${JSON.stringify(networkGuard.href)}`,
      }
      const project = prepareDevelopmentProject({
        projectDir: join(root, 'project'),
        cliDir: join(repository, 'apps/cli'),
        hostDir: join(repository, 'apps/desktop-host'),
        dependencyDir: join(repository, 'node_modules/.pnpm/node_modules'),
        release: {
          schemaVersion: 1,
          version: version(join(repository, 'apps/desktop/package.json')),
          pnpmVersion: version(join(repository, 'apps/desktop/node_modules/pnpm/package.json')),
          nodeVersion: process.versions.node,
          hostProtocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
        },
        // This synthetic project does not exercise target-specific packaging resources.
        target: 'mac-x64',
      })
      cpSync(join(repository, 'packages/skill/skill-office/assets'), join(root, 'runtime/office-skills'), { recursive: true })
      const nodeBin = join(root, 'runtime/primary-runtime/dependencies/node/bin')
      mkdirSync(nodeBin, { recursive: true })
      cpSync(process.execPath, join(nodeBin, process.platform === 'win32' ? 'node.exe' : 'node'))
      const context = resolveProductLaunchContext({
        purpose: 'verification', instanceRoot: join(root, 'instance'),
        codeRoot: realpathSync(project), resourcesRoot: realpathSync(join(root, 'runtime')),
      })
      // The same launcher boundary rejects physical/lexical code-state overlap and prepares only this test's state.
      prepareProductState(context)
      const environment = productLaunchEnvironment(context, inherited)
      const paths = resolveDesktopPaths(context.paths.dshHomeDir)
      const manager = new DesktopProjectManager(paths, { dsh: project })
      await manager.applyRelease()
      const patch = join(paths.profile, 'cordis.patch.yml')
      writeFileSync(patch, '- id: webserver\n  config:\n    host: 127.0.0.1\n    port: 0\n')
      let backend: DesktopWelcomeBackend
      const restart = async (extraPreload?: string): Promise<void> => {
        await stop()
        activeAudit = join(root, `network-audit-${String(++launch)}.jsonl`)
        host = new DesktopHostProcess(process.execPath, project, paths.profile, undefined, {
          ...environment, DSH_SNAPSHOT_NETWORK_AUDIT_FILE: activeAudit,
          NODE_OPTIONS: `${environment.NODE_OPTIONS}${extraPreload === undefined ? '' : ` --import=${JSON.stringify(extraPreload)}`}`,
        })
        const { url } = await host.start()
        let cookie = ''
        const send: Parameters<typeof connectDesktopWelcome>[1] = async (input, init) => {
          const path = new URL(input).pathname
          pathsRequested.push(path)
          if (init?.method === 'POST') {
            if (typeof init.body !== 'string') throw new TypeError('Expected a welcome RPC body')
            const request = JSON.parse(init.body) as { method: string }
            methods.push(request.method)
          }
          const headers = new Headers(init?.headers)
          if (cookie !== '') headers.set('cookie', cookie)
          const response = await fetch(input, { ...init, headers, redirect: 'manual' })
          if (response.status !== 303) return response
          cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
          await response.body?.cancel()
          const redirected = new URL(response.headers.get('location')!, url)
          pathsRequested.push(redirected.pathname)
          return fetch(redirected, { headers: { cookie } })
        }
        backend = await connectDesktopWelcome(url, send)
      }
      const status = async () => backend.read()
      await restart()
      expect(await status()).toEqual({ hasApiKey: false, writable: true, localePreference: null })
      expect(needsWelcome(await status())).toBe(true)
      // No credential write means the next cold start still needs setup; native Skip dispatch has separate unit coverage.
      await restart()
      expect(needsWelcome(await status())).toBe(true)
      await stop()
      writeFileSync(patch, readFileSync(patch, 'utf8') + '- id: locale\n  config:\n    preference: zh\n')
      await restart()
      expect(await status()).toEqual({ hasApiKey: false, writable: true, localePreference: 'zh' })
      expect(await backend!.save('sk-local-onboarding-test')).toEqual({ ok: true })
      expect(await status()).toEqual({ hasApiKey: true, writable: true, localePreference: 'zh' })
      expect(needsWelcome(await status())).toBe(false)
      await restart()
      // Presence is metadata only; neither credential values nor their backing file are read back.
      expect(await status()).toEqual({ hasApiKey: true, writable: true, localePreference: 'zh' })
      expect(needsWelcome(await status())).toBe(false)
      // Retain the real update-handoff lifecycle check with an owned post-shutdown open handle.
      await restart(`data:text/javascript,${encodeURIComponent(
        "process.on('message', message => { if (message?.type === 'shutdown') setInterval(() => {}, 1000) })")}`)
      await stop(true)
      expect(auditedLaunches).toBe(launch)
      expect(methods.filter(method => method.startsWith('account/'))).toEqual([])
      expect(methods).not.toContain('credentials/get')
      expect(methods.filter(method => method === 'credentials/set')).toHaveLength(1)
      expect(pathsRequested.filter(path => path.startsWith('/auth-api/') || path.startsWith('/api/account/'))).toEqual([])
    } finally {
      // Retain owned files if stopping the child fails, rather than deleting a running Host's profile.
      await stop()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
