/** Explicit product-instance paths shared by application entry points. */
import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync, type Stats } from 'node:fs'
import { basename, dirname, isAbsolute, join, normalize, parse, relative, sep } from 'node:path'

/** Environment field carrying the validated request between product processes. */
export const PRODUCT_LAUNCH_CONTEXT_ENV = 'AGENTRANS_LAUNCH_CONTEXT'

const INSTANCE_MARKER_FILE = '.agentrans-instance.json'
const INSTANCE_MARKER = { schemaVersion: 1, productId: 'agentrans' } as const

/** The reason an instance runs, independently of its distribution form. */
export type ProductLaunchPurpose = 'development' | 'verification' | 'user'

/** Launch-owned roots; no path comes from a workspace, user home, or ambient environment. */
export interface ProductLaunchRequest {
  readonly purpose: ProductLaunchPurpose
  readonly instanceRoot: string
  readonly codeRoot: string
  readonly resourcesRoot: string
}

/** Product-owned writable directories; code directories are never prepared as state. */
export interface ProductLaunchPaths {
  readonly dataDir: string
  readonly modelsDir: string
  readonly runtimesDir: string
  readonly dshHomeDir: string
  readonly dshAgentsHomeDir: string
  readonly electronUserDataDir: string
  readonly logsDir: string
  readonly crashDumpsDir: string
  readonly cacheDir: string
  readonly exportsDir: string
  readonly updateJournalDir: string
}

/** Resolved instance paths shared by GUI, CLI, and child processes. */
export interface ProductLaunchContext extends ProductLaunchRequest {
  readonly paths: Readonly<ProductLaunchPaths>
}

/** Handling-relevant launch failures before application state can be trusted. */
export type ProductLaunchErrorCode =
  | 'INVALID_LAUNCH_REQUEST'
  | 'STATE_CODE_OVERLAP'
  | 'STATE_PATH_LINK'
  | 'STATE_PATH_NOT_DIRECTORY'
  | 'INSTANCE_PURPOSE_MISMATCH'
  | 'CODE_ROOT_UNAVAILABLE'
  | 'STATE_PREPARE_FAILED'

/** A rejected root, wire request, or state-directory preparation. */
export class ProductLaunchError extends Error {
  /**
   * @param code - Stable failure discriminator.
   * @param message - Diagnostic owned by the application entry point.
   * @param path - Rejected filesystem location, when applicable.
   * @param options - Original filesystem or JSON failure, when present.
   */
  constructor(
    readonly code: ProductLaunchErrorCode,
    message: string,
    readonly path?: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'ProductLaunchError'
  }
}

function rootAt(value: string, field: string): string {
  if (value.trim() === '' || value.includes('\0') || !isAbsolute(value)) {
    throw new ProductLaunchError('INVALID_LAUNCH_REQUEST', `${field} must be a non-empty absolute directory`, value)
  }
  const normalized = normalize(value)
  return normalized !== parse(normalized).root && normalized.endsWith(sep) ? normalized.slice(0, -1) : normalized
}

function overlaps(left: string, right: string): boolean {
  const contains = (parent: string, child: string): boolean => {
    const offset = relative(parent, child)
    return offset === '' || (!isAbsolute(offset) && offset !== '..' && !offset.startsWith(`..${sep}`))
  }
  return contains(left, right) || contains(right, left)
}

function stateDirectories(context: ProductLaunchContext): readonly string[] {
  return Object.values(context.paths)
}

function assertStateOutsideCode(state: readonly string[], code: readonly string[]): void {
  for (const directory of state) {
    if (code.some(root => overlaps(directory, root))) {
      throw new ProductLaunchError('STATE_CODE_OVERLAP', 'Product state must not overlap code or resources', directory)
    }
  }
}

/**
 * Resolve all state paths without reading the filesystem or changing the process.
 * @param request - Explicit absolute roots and instance purpose.
 * @returns Frozen roots and derived directories.
 * @throws {ProductLaunchError} For relative roots or state overlapping code.
 */
export function resolveProductLaunchContext(request: ProductLaunchRequest): ProductLaunchContext {
  const instanceRoot = rootAt(request.instanceRoot, 'instanceRoot')
  const codeRoot = rootAt(request.codeRoot, 'codeRoot')
  const resourcesRoot = rootAt(request.resourcesRoot, 'resourcesRoot')
  if (instanceRoot === parse(instanceRoot).root) {
    throw new ProductLaunchError('INVALID_LAUNCH_REQUEST', 'The filesystem root cannot own a product instance', instanceRoot)
  }
  const dataDir = join(instanceRoot, 'data')
  const paths = Object.freeze({
    dataDir,
    modelsDir: join(instanceRoot, 'models'),
    runtimesDir: join(instanceRoot, 'runtime-envs'),
    dshHomeDir: join(dataDir, 'dsh', 'home'),
    dshAgentsHomeDir: join(dataDir, 'dsh', 'agents'),
    electronUserDataDir: join(dataDir, 'settings', 'electron'),
    logsDir: join(dataDir, 'logs'),
    crashDumpsDir: join(dataDir, 'cache', 'crash-dumps'),
    cacheDir: join(dataDir, 'cache'),
    exportsDir: join(dataDir, 'exports'),
    updateJournalDir: join(dataDir, 'install', 'update-journal'),
  })
  const context = Object.freeze({ purpose: request.purpose, instanceRoot, codeRoot, resourcesRoot, paths })
  assertStateOutsideCode(stateDirectories(context), [codeRoot, resourcesRoot])
  return context
}

/**
 * Resolve a stable worktree-local development instance outside its source tree.
 * @param request - Canonical absolute source root and optional explicit instance root.
 * @returns Development context independent of commits, cwd, and inherited path variables.
 */
export function resolveDevelopmentLaunchContext(request: {
  readonly sourceRoot: string
  readonly instanceRoot?: string
}): ProductLaunchContext {
  const sourceRoot = rootAt(request.sourceRoot, 'sourceRoot')
  const identity = process.platform === 'win32' ? sourceRoot.toLowerCase() : sourceRoot
  const worktree = createHash('sha256').update(identity).digest('hex').slice(0, 12)
  const instanceRoot = request.instanceRoot ?? join(dirname(sourceRoot), '.dev-data', 'agentrans', 'dev', worktree)
  return resolveProductLaunchContext({ purpose: 'development', instanceRoot, codeRoot: sourceRoot, resourcesRoot: sourceRoot })
}

/**
 * Resolve the Windows payload layout instance/app/resources without granting registration or update rights.
 * Other packaged layouts pass their roots explicitly to resolveProductLaunchContext.
 * @param resourcesRoot - Absolute resources directory belonging to the launched payload.
 * @param encoded - Optional inherited context; only a verification request matching this payload changes the state root.
 * @returns User context by default, or the explicitly bound verification context.
 * @throws {ProductLaunchError} When a verification request belongs to another payload.
 */
export function resolvePackagedLaunchContext(resourcesRoot: string, encoded?: string): ProductLaunchContext {
  const resources = rootAt(resourcesRoot, 'resourcesRoot')
  const codeRoot = dirname(resources)
  const owned = resolveProductLaunchContext({ purpose: 'user', resourcesRoot: resources, codeRoot, instanceRoot: dirname(codeRoot) })
  if (encoded === undefined) return owned
  const candidate = parseProductLaunchContext(encoded)
  if (candidate.purpose !== 'verification') return owned
  if (relative(candidate.codeRoot, owned.codeRoot) !== '' || relative(candidate.resourcesRoot, owned.resourcesRoot) !== '') {
    throw new ProductLaunchError('INVALID_LAUNCH_REQUEST', 'Verification context does not belong to the launched payload', candidate.codeRoot)
  }
  return candidate
}

/**
 * Encode only independent roots, so children derive rather than trust state paths.
 * @param context - Resolved launch context.
 * @returns JSON request for a product-owned process.
 */
export function serializeProductLaunchContext(context: ProductLaunchContext): string {
  return JSON.stringify({
    purpose: context.purpose, instanceRoot: context.instanceRoot,
    codeRoot: context.codeRoot, resourcesRoot: context.resourcesRoot,
  })
}

/**
 * Validate a process-boundary request and derive all writable paths again.
 * @param serialized - JSON emitted by the product launcher.
 * @returns Resolved context with no caller-supplied derived paths.
 * @throws {ProductLaunchError} For malformed JSON, extra fields, invalid purpose, or roots.
 */
export function parseProductLaunchContext(serialized: string): ProductLaunchContext {
  let value: unknown
  try { value = JSON.parse(serialized) }
  catch (error) {
    throw new ProductLaunchError('INVALID_LAUNCH_REQUEST', 'Product launch context is not valid JSON', undefined, { cause: error })
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || !('purpose' in value) || !('instanceRoot' in value) || !('codeRoot' in value) || !('resourcesRoot' in value)
    || Object.keys(value).length !== 4
    || (value.purpose !== 'development' && value.purpose !== 'verification' && value.purpose !== 'user')
    || typeof value.instanceRoot !== 'string' || typeof value.codeRoot !== 'string' || typeof value.resourcesRoot !== 'string') {
    throw new ProductLaunchError('INVALID_LAUNCH_REQUEST', 'Product launch context must contain purpose and three explicit roots')
  }
  return resolveProductLaunchContext({
    purpose: value.purpose, instanceRoot: value.instanceRoot,
    codeRoot: value.codeRoot, resourcesRoot: value.resourcesRoot,
  })
}

/**
 * Project the resolved instance into the legacy Harness process environment.
 * @param context - Authoritative instance roots.
 * @param inherited - Unrelated variables preserved without mutation.
 * @param platform - Environment-name semantics; defaults to the current platform.
 * @returns A new environment with three launcher-owned fields deterministically replaced.
 */
export function productLaunchEnvironment(
  context: ProductLaunchContext,
  inherited: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const environment = { ...inherited }
  applyProductLaunchEnvironment(context, environment, platform)
  return environment
}

/**
 * Materialize only the three launcher-owned fields before importing application modules.
 * @param context - Authoritative instance roots.
 * @param environment - Mutable entry-process environment; unrelated fields are untouched.
 * @param platform - Environment-name semantics; defaults to the current platform.
 */
export function applyProductLaunchEnvironment(
  context: ProductLaunchContext,
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): void {
  const owned = new Set(['DSH_HOME', 'DSH_AGENTS_HOME', PRODUCT_LAUNCH_CONTEXT_ENV])
  for (const key of Object.keys(environment)) {
    if (owned.has(platform === 'win32' ? key.toUpperCase() : key)) Reflect.deleteProperty(environment, key)
  }
  environment.DSH_HOME = context.paths.dshHomeDir
  environment.DSH_AGENTS_HOME = context.paths.dshAgentsHomeDir
  environment[PRODUCT_LAUNCH_CONTEXT_ENV] = serializeProductLaunchContext(context)
}

function actualStateDirectory(path: string): string {
  let current = path
  let canonical: string | undefined
  const missing: string[] = []
  while (true) {
    let item: Stats
    try { item = lstatSync(current) }
    catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
        throw new ProductLaunchError('STATE_PATH_NOT_DIRECTORY', 'Cannot inspect a product state directory', current, { cause: error })
      }
      const parent = dirname(current)
      if (parent === current) {
        throw new ProductLaunchError('STATE_PATH_NOT_DIRECTORY', 'Product state has no accessible filesystem root', current, { cause: error })
      }
      missing.push(basename(current))
      current = parent
      continue
    }
    if (item.isSymbolicLink()) {
      throw new ProductLaunchError('STATE_PATH_LINK', 'Product state cannot pass through a symbolic link or junction', current)
    }
    if (!item.isDirectory()) {
      throw new ProductLaunchError('STATE_PATH_NOT_DIRECTORY', 'Product state has a non-directory ancestor', current)
    }
    if (canonical === undefined) {
      try { canonical = join(realpathSync(current), ...missing.reverse()) }
      catch (error) {
        throw new ProductLaunchError('STATE_PATH_NOT_DIRECTORY', 'Cannot resolve a product state directory', current, { cause: error })
      }
    }
    const parent = dirname(current)
    if (parent === current) return canonical
    current = parent
  }
}

function validateInstanceMarker(path: string, purpose: ProductLaunchPurpose): void {
  let value: unknown
  try {
    const item = lstatSync(path)
    if (!item.isFile() || item.isSymbolicLink()) throw new Error('Expected an ordinary instance marker file')
    value = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new ProductLaunchError('INSTANCE_PURPOSE_MISMATCH', 'Cannot trust the product instance marker', path, { cause: error })
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value) || Object.keys(value).length !== 3
    || !('schemaVersion' in value) || value.schemaVersion !== INSTANCE_MARKER.schemaVersion
    || !('productId' in value) || value.productId !== INSTANCE_MARKER.productId
    || !('purpose' in value) || value.purpose !== purpose) {
    throw new ProductLaunchError('INSTANCE_PURPOSE_MISMATCH', 'Instance marker does not match the requested product and purpose', path)
  }
}

function assertInstanceOwnership(context: ProductLaunchContext): boolean {
  if (context.purpose === 'user') return false
  const app = join(context.instanceRoot, 'app')
  let hasApp = false
  try {
    lstatSync(app)
    hasApp = true
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
      throw new ProductLaunchError('INSTANCE_PURPOSE_MISMATCH', 'Cannot establish product-instance ownership', app, { cause: error })
    }
  }
  // lstat also observes broken app links, which must not become development or verification state.
  if (hasApp) {
    throw new ProductLaunchError('INSTANCE_PURPOSE_MISMATCH', 'Development and verification cannot claim an app installation', app)
  }
  const manifest = join(context.paths.dataDir, 'install', 'manifest.json')
  actualStateDirectory(dirname(manifest))
  let contents: string | undefined
  try {
    if (lstatSync(manifest).isSymbolicLink()) {
      throw new ProductLaunchError('INSTANCE_PURPOSE_MISMATCH', 'Cannot trust a linked install manifest', manifest)
    }
    contents = readFileSync(manifest, 'utf8')
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
      throw new ProductLaunchError('INSTANCE_PURPOSE_MISMATCH', 'Cannot read the instance install manifest', manifest, { cause: error })
    }
  }
  if (contents !== undefined) {
    let value: unknown
    try { value = JSON.parse(contents) }
    catch (error) {
      throw new ProductLaunchError('INSTANCE_PURPOSE_MISMATCH', 'Cannot use an invalid install manifest', manifest, { cause: error })
    }
    if (context.purpose !== 'development' || typeof value !== 'object' || value === null || !('channel' in value) || value.channel !== 'development'
      || !('productId' in value) || value.productId !== 'agentrans') {
      throw new ProductLaunchError('INSTANCE_PURPOSE_MISMATCH', 'Install manifest does not belong to the requested instance purpose', manifest)
    }
  }
  const marker = join(context.instanceRoot, INSTANCE_MARKER_FILE)
  let hasMarker = false
  try { lstatSync(marker); hasMarker = true }
  catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
      throw new ProductLaunchError('INSTANCE_PURPOSE_MISMATCH', 'Cannot inspect the product instance marker', marker, { cause: error })
    }
  }
  if (hasMarker) { validateInstanceMarker(marker, context.purpose); return false }
  let entries: string[] = []
  try { entries = readdirSync(context.instanceRoot) }
  catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
      throw new ProductLaunchError('INSTANCE_PURPOSE_MISMATCH', 'Cannot inspect the unmarked product root', context.instanceRoot, { cause: error })
    }
  }
  if (entries.length > 0) {
    throw new ProductLaunchError('INSTANCE_PURPOSE_MISMATCH', 'Development and verification cannot claim a non-empty unmarked instance', context.instanceRoot)
  }
  return true
}

function createInstanceMarker(context: ProductLaunchContext): void {
  const marker = join(context.instanceRoot, INSTANCE_MARKER_FILE)
  try {
    mkdirSync(context.instanceRoot, { recursive: true })
    writeFileSync(marker, `${JSON.stringify({ ...INSTANCE_MARKER, purpose: context.purpose })}\n`, { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
      validateInstanceMarker(marker, context.purpose)
      return
    }
    throw new ProductLaunchError('STATE_PREPARE_FAILED', 'Cannot establish the product instance marker', marker, { cause: error })
  }
}

/**
 * Prepare writable state only after every existing ancestor and physical overlap check succeeds.
 * Development and verification roots must be empty or own a matching instance marker; other roots are never adopted.
 * Application code and resources must already exist; no app directory or migration is created.
 * Validation failures create nothing. A later I/O failure can leave an owned marker and empty directories.
 * @param context - Resolved instance context.
 * @throws {ProductLaunchError} For unavailable code, linked or invalid state, overlap, or mkdir failure.
 */
export function prepareProductState(context: ProductLaunchContext): void {
  const code = [context.codeRoot, context.resourcesRoot].map((path) => {
    try {
      if (!statSync(path).isDirectory()) throw new Error('Expected a code directory')
      return realpathSync(path)
    } catch (error) {
      throw new ProductLaunchError('CODE_ROOT_UNAVAILABLE', 'Product code or resources are not available', path, { cause: error })
    }
  })
  const directories = stateDirectories(context)
  assertStateOutsideCode(directories.map(actualStateDirectory), code)
  if (assertInstanceOwnership(context)) createInstanceMarker(context)
  for (const directory of directories) {
    try { mkdirSync(directory, { recursive: true }) }
    catch (error) {
      throw new ProductLaunchError('STATE_PREPARE_FAILED', 'Cannot prepare product state directories', directory, { cause: error })
    }
  }
}
