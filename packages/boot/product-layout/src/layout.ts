/** Single-root product directory layout and non-destructive directory preparation. */
import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'

/** Installation or development form that owns one complete root directory. */
export type ProductChannel = 'development' | 'portable' | 'installed'

/** Current directory-layout version; pre-1.0 layouts are not migrated. */
export const PRODUCT_LAYOUT_VERSION = 1

/** All product-owned paths derived from one installation root. */
export class ProductLayout {
  private constructor(
    readonly root: string,
    readonly channel: ProductChannel,
    readonly appDir: string,
    readonly dataDir: string,
    readonly modelsDir: string,
    readonly runtimesDir: string,
    readonly integrationsDir: string,
    readonly dshHomeDir: string,
    readonly dshAgentsHomeDir: string,
  ) {}

  /**
   * Derive every product-owned path from one root; no independent data roots are accepted.
   * @param root - Installation, portable, or development root directory.
   * @param channel - Form that owns this complete root.
   * @returns An immutable single-root layout.
   */
  static fromRoot(root: string, channel: ProductChannel): ProductLayout {
    if (typeof root !== 'string' || root.trim().length === 0) throw new TypeError('ProductLayout root must be non-empty')
    if (channel !== 'development' && channel !== 'portable' && channel !== 'installed') {
      throw new TypeError(`Unsupported product channel: ${String(channel)}`)
    }
    const absoluteRoot = resolve(root)
    const dataDir = join(absoluteRoot, 'data')
    return new ProductLayout(
      absoluteRoot,
      channel,
      join(absoluteRoot, 'app'),
      dataDir,
      join(absoluteRoot, 'models'),
      join(absoluteRoot, 'runtime-envs'),
      join(absoluteRoot, 'integrations'),
      join(dataDir, 'dsh', 'home'),
      join(dataDir, 'dsh', 'agents'),
    )
  }

  /** Return the conventional DSH integration package directory inside this root. */
  get integrationPackageDir(): string {
    return join(this.integrationsDir, 'dsh-agentrans')
  }

  /** Return the install manifest path inside the data subdirectory. */
  get installManifestPath(): string {
    return join(this.dataDir, 'install', 'manifest.json')
  }
}

/**
 * Create the fixed directory layout without deleting or replacing existing data.
 * @param layout - Single-root layout to prepare.
 * @returns A promise resolved after all required directories exist.
 */
export async function ensureProductLayout(layout: ProductLayout): Promise<void> {
  const directories = [
    layout.appDir,
    layout.dataDir,
    layout.modelsDir,
    layout.runtimesDir,
    layout.integrationsDir,
    layout.dshHomeDir,
    layout.dshAgentsHomeDir,
    join(layout.dataDir, 'install'),
    join(layout.dataDir, 'sessions'),
    join(layout.dataDir, 'workspaces'),
    join(layout.dataDir, 'settings'),
    join(layout.dataDir, 'exports'),
    join(layout.dataDir, 'cache'),
  ]
  for (const directory of directories) await mkdir(directory, { recursive: true })
}
