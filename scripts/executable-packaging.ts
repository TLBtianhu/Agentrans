/** Shared production-deploy preparation for the SDK and SSH executable carriers. */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { extname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { load } from 'js-yaml'

/**
 * Resolve pnpm without invoking a command shell, including Windows shims.
 * @param args - pnpm arguments.
 * @returns the executable and its argument vector.
 */
export function pnpmInvocation(args: string[]): [command: string, args: string[]] {
  const entrypoint = process.env.npm_execpath?.trim()
  if (entrypoint !== undefined && entrypoint !== '') {
    const extension = extname(entrypoint).toLowerCase()
    if (extension === '.js' || extension === '.cjs' || extension === '.mjs') {
      return [process.execPath, [entrypoint, ...args]]
    }
    if (extension !== '.cmd') return [entrypoint, args]
  }
  const home = process.env.PNPM_HOME?.trim()
  if (home !== undefined && home !== '') {
    const packageBin = resolve(home, '..', 'pnpm', 'bin')
    for (const filename of ['pnpm.mjs', 'pnpm.cjs']) {
      const candidate = resolve(packageBin, filename)
      if (existsSync(candidate)) return [process.execPath, [candidate, ...args]]
    }
  }
  if (process.platform === 'win32') {
    throw new Error('executable-packaging: pnpm must expose a JavaScript entrypoint through npm_execpath or PNPM_HOME on Windows.')
  }
  return ['pnpm', args]
}

const DEPLOY_LOCK_FILES = ['pnpm-lock.yaml', 'pnpm-workspace.yaml']
const LIFECYCLE_STAGES = ['preinstall', 'install', 'postinstall'] as const

/**
 * pnpm arguments that deploy a closure from the shared workspace lock.
 * Injected workspace copies let pnpm reuse the reviewed lock instead of resolving the registry again; the hoisted
 * linker yields package directories that staging keeps symlink-free. Copied files keep later staging edits out of the
 * pnpm store and the workspace install, which would otherwise share hard-linked bytes. pnpm keys an injected workspace
 * build script by its absolute path, so strict build checks move to {@link completeLockedDeploy}.
 * @param closure - Workspace package whose dependencies define the deployed payload.
 * @param staging - Empty deployment directory.
 * @returns Arguments for `pnpm`.
 */
export function lockedDeployArgs(closure: string, staging: string): string[] {
  return ['--filter', closure, 'deploy', '--prod', '--config.inject-workspace-packages=true',
    '--config.node-linker=hoisted', '--config.package-import-method=copy', '--config.strict-dep-builds=false', staging]
}

/** One injected workspace package whose reviewed build script pnpm skipped. */
export interface ReviewedWorkspaceBuild {
  /** Package name. */
  readonly name: string
  /** Workspace-relative source directory recorded in `allowBuilds`. */
  readonly directory: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function readYaml(path: string): Promise<Record<string, unknown>> {
  const value: unknown = load(await readFile(path, 'utf8'))
  if (!isRecord(value)) throw new Error(`executable-packaging: ${path} must contain a YAML mapping`)
  return value
}

/**
 * Match the build scripts a locked deploy skipped against the workspace `allowBuilds` review.
 * Only workspace packages approved as `<name>@file:<directory>: true` may be skipped; anything else fails.
 * @param staging - Locked deployment root.
 * @param workspace - Workspace root holding `pnpm-workspace.yaml`.
 * @returns Reviewed workspace packages whose scripts still need to run, in pnpm's order.
 */
export async function skippedWorkspaceBuilds(staging: string, workspace: string): Promise<ReviewedWorkspaceBuild[]> {
  const reviewed = new Map<string, string>()
  const allowBuilds = (await readYaml(join(workspace, 'pnpm-workspace.yaml'))).allowBuilds
  for (const [key, allowed] of Object.entries(isRecord(allowBuilds) ? allowBuilds : {})) {
    const { name, directory } = /^(?<name>(?:@[^/]+\/)?[^@]+)@file:(?<directory>.+)$/u.exec(key)?.groups ?? {}
    if (name !== undefined && directory !== undefined && allowed === true) reviewed.set(name, directory)
  }
  const modules = await readYaml(join(staging, 'node_modules', '.modules.yaml'))
  const ignored = modules.ignoredBuilds ?? []
  if (!Array.isArray(ignored) || !ignored.every(entry => typeof entry === 'string')) {
    throw new Error(`executable-packaging: ${join(staging, 'node_modules', '.modules.yaml')} ignoredBuilds must list package identities`)
  }
  const builds: ReviewedWorkspaceBuild[] = []
  const unreviewed: string[] = []
  for (const identity of ignored) {
    const { name, url } = /^(?<name>(?:@[^/]+\/)?[^@]+)@(?<url>file:\/\/\/.+)$/u.exec(identity)?.groups ?? {}
    const directory = name === undefined ? undefined : reviewed.get(name)
    if (name === undefined || url === undefined || directory === undefined
      || relative(workspace, fileURLToPath(url)).split(sep).join('/') !== directory) unreviewed.push(identity)
    else builds.push({ name, directory })
  }
  if (unreviewed.length > 0) {
    throw new Error(`executable-packaging: locked deploy skipped unreviewed build scripts: ${unreviewed.join(', ')}`)
  }
  return builds
}

function runNodeScript(directory: string, script: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [script], { cwd: directory, stdio: 'inherit' })
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (code === 0 && signal === null) resolvePromise()
      else reject(new Error(`executable-packaging: ${join(directory, script)} failed (${code ?? signal})`))
    })
  })
}

/**
 * Finish a locked deploy: require every direct dependency, run the reviewed workspace build scripts pnpm skipped,
 * and remove the lock files pnpm writes beside the payload.
 * @param staging - Locked deployment root.
 * @param workspace - Workspace root holding `pnpm-workspace.yaml`.
 * @returns Names of workspace packages whose build scripts ran.
 */
export async function completeLockedDeploy(staging: string, workspace: string): Promise<string[]> {
  const manifest = JSON.parse(await readFile(join(staging, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> }
  const missing = Object.keys(manifest.dependencies ?? {}).filter(name => !existsSync(join(staging, 'node_modules', name)))
  if (missing.length > 0) throw new Error(`executable-packaging: locked deploy omitted direct dependencies: ${missing.join(', ')}`)
  const builds = await skippedWorkspaceBuilds(staging, workspace)
  for (const { name } of builds) {
    const directory = join(staging, 'node_modules', name)
    const scripts = (JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as { scripts?: Record<string, string> }).scripts ?? {}
    for (const stage of LIFECYCLE_STAGES) {
      const command = scripts[stage]
      if (command === undefined) continue
      // Reviewed scripts run as plain Node programs, without a shell.
      const script = /^node ([\w./-]+\.m?js)$/u.exec(command)?.[1]
      if (script === undefined) throw new Error(`executable-packaging: ${name} ${stage} must be "node <script>", got ${JSON.stringify(command)}`)
      await runNodeScript(directory, script)
    }
  }
  await Promise.all(DEPLOY_LOCK_FILES.map(file => rm(join(staging, file), { force: true })))
  return builds.map(build => build.name)
}
