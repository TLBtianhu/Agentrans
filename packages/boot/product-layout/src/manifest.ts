/** Versioned install manifests and independently managed asset records. */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { PRODUCT_LAYOUT_VERSION, type ProductChannel, type ProductLayout } from './layout.ts'

/** Lifecycle state of one downloaded or activated asset. */
export type AssetState = 'absent' | 'downloading' | 'verified' | 'active' | 'failed'

/** One independently managed model or runtime asset. */
export interface AssetRecord {
  readonly id: string
  readonly version: string
  readonly sha256: string
  /** Product-root-relative location, so a portable root can move. */
  readonly location: string
  readonly state: AssetState
}

/** Durable installation state stored below the product's data directory. */
export interface InstallManifest {
  readonly layoutVersion: number
  readonly productId: string
  readonly channel: ProductChannel
  readonly root: string
  readonly appVersion: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly assets: Readonly<Record<string, AssetRecord>>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`InstallManifest ${field} must be a non-empty string`)
  return value
}

function validateAsset(value: unknown, id: string): AssetRecord {
  if (!isRecord(value)) throw new Error(`InstallManifest asset ${id} must be an object`)
  const state = value.state
  if (state !== 'absent' && state !== 'downloading' && state !== 'verified' && state !== 'active' && state !== 'failed') {
    throw new Error(`InstallManifest asset ${id} has an invalid state`)
  }
  return {
    id: requiredString(value.id, `asset ${id}.id`),
    version: requiredString(value.version, `asset ${id}.version`),
    sha256: requiredString(value.sha256, `asset ${id}.sha256`),
    location: requiredString(value.location, `asset ${id}.location`),
    state,
  }
}

function validateManifest(value: unknown): InstallManifest {
  if (!isRecord(value)) throw new Error('InstallManifest must be an object')
  if (value.layoutVersion !== PRODUCT_LAYOUT_VERSION) throw new Error('InstallManifest layoutVersion is unsupported')
  const channel = value.channel
  if (channel !== 'development' && channel !== 'portable' && channel !== 'installed') throw new Error('InstallManifest channel is invalid')
  if (!isRecord(value.assets)) throw new Error('InstallManifest assets must be an object')
  const assets: Record<string, AssetRecord> = {}
  for (const [id, asset] of Object.entries(value.assets)) assets[id] = validateAsset(asset, id)
  return {
    layoutVersion: PRODUCT_LAYOUT_VERSION,
    productId: requiredString(value.productId, 'productId'),
    channel,
    root: requiredString(value.root, 'root'),
    appVersion: requiredString(value.appVersion, 'appVersion'),
    createdAt: requiredString(value.createdAt, 'createdAt'),
    updatedAt: requiredString(value.updatedAt, 'updatedAt'),
    assets,
  }
}

/**
 * Create a new install manifest with no assets and identical creation/update timestamps.
 * @param layout - Single-root product layout being installed.
 * @param appVersion - Version of the application payload.
 * @param options - Optional product id and deterministic timestamp.
 * @returns A validated install manifest.
 */
export function createInstallManifest(
  layout: ProductLayout,
  appVersion: string,
  options: { readonly productId?: string; readonly now?: Date } = {},
): InstallManifest {
  const timestamp = (options.now ?? new Date()).toISOString()
  return validateManifest({
    layoutVersion: PRODUCT_LAYOUT_VERSION,
    productId: options.productId ?? 'agentrans',
    channel: layout.channel,
    root: layout.root,
    appVersion,
    createdAt: timestamp,
    updatedAt: timestamp,
    assets: {},
  })
}

/**
 * Read and validate an install manifest without changing it.
 * @param path - Absolute manifest path, normally layout.installManifestPath.
 * @returns The validated manifest.
 */
export async function readInstallManifest(path: string): Promise<InstallManifest> {
  return validateManifest(JSON.parse(await readFile(path, 'utf8')))
}

/**
 * Validate and write an install manifest as readable JSON.
 * @param path - Absolute manifest path.
 * @param manifest - Complete manifest to persist.
 * @returns A promise resolved after the manifest is written.
 */
export async function writeInstallManifest(path: string, manifest: InstallManifest): Promise<void> {
  const validated = validateManifest(manifest)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(validated, null, 2)}\n`, 'utf8')
}
