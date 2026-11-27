/** Prepare a symlink-free executable runtime payload with one instance of each workspace module. */
import { cp, lstat, readFile, readdir, realpath, rm, unlink } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { load } from 'js-yaml'

function isHoistedLocations(value: unknown): value is Record<string, string[]> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.values(value).every(paths => Array.isArray(paths)
      && paths.every((path: unknown) => typeof path === 'string'))
}

/**
 * Require one staged copy of every workspace package, so each Cordis service class loads once.
 * A locked deploy places injected workspace packages at their recorded locations; a second location or a second
 * peer-specialized identity for the same package would give that package two module instances.
 * @param staging - Symlink-free deployed payload root.
 */
export async function assertSingleWorkspaceCopies(staging: string): Promise<void> {
  const modules = resolve(staging, 'node_modules')
  const file = join(modules, '.modules.yaml')
  const manifest: unknown = load(await readFile(file, 'utf8'))
  if (typeof manifest !== 'object' || manifest === null || !('hoistedLocations' in manifest)
    || !isHoistedLocations(manifest.hoistedLocations)) {
    throw new Error(`${file}: hoistedLocations must map dependency identities to path lists`)
  }
  const copies = new Map<string, string[]>()
  for (const [identity, locations] of Object.entries(manifest.hoistedLocations)) {
    const name = /^((?:@[^/]+\/)?[^@()]+)@file:/u.exec(identity)?.[1]
    if (name === undefined) continue
    for (const location of locations) {
      const local = relative(modules, resolve(staging, location))
      if (local === '' || local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local)) {
        throw new Error(`${file}: hoistedLocations path is outside deployed node_modules: ${location}`)
      }
      copies.set(name, [...copies.get(name) ?? [], local.split(sep).join('/')])
    }
  }
  if (copies.size === 0) throw new Error(`${file}: hoistedLocations records no workspace packages`)
  const duplicated = [...copies].filter(([, paths]) => paths.length !== 1)
  if (duplicated.length > 0) {
    throw new Error(`${file}: workspace packages must have exactly one staged copy: ${
      duplicated.map(([name, paths]) => `${name} (${paths.join(', ')})`).join('; ')}`)
  }
  for (const [name, paths] of copies) {
    for (const path of paths) {
      if (!(await lstat(join(modules, path))).isDirectory()) throw new Error(`${file}: staged ${name} is not a directory: ${path}`)
    }
  }
}

/** Return the first symbolic link below a directory, if one exists. */
async function findSymlink(directory: string): Promise<string | undefined> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    const metadata = await lstat(path)
    if (metadata.isSymbolicLink()) return path
    if (metadata.isDirectory()) {
      const nested = await findSymlink(path)
      if (nested !== undefined) return nested
    }
  }
  return undefined
}

/**
 * Replace every deploy-time package link below the staged payload with real files.
 *
 * A deploy can link packages into the target's `node_modules`, and those links
 * must survive packaging as files. One link is not a package: when
 * the deploy target sits inside the deployed project, pnpm links that project
 * into its own `node_modules`. Dereferencing it would copy the payload into
 * itself, and the packaged payload never carries the project source, so the
 * entry is dropped instead.
 * @param staging - Deployed payload root whose `node_modules` becomes symlink-free.
 */
export async function materializeStagedLinks(staging: string): Promise<void> {
  const payload = await realpath(staging)
  const nodeModules = join(staging, 'node_modules')
  let remaining = await findSymlink(nodeModules)
  while (remaining !== undefined) {
    const segments = remaining.slice(nodeModules.length + 1).split(sep)
    const binIndex = segments.lastIndexOf('.bin')
    if (binIndex >= 0) {
      const directory = join(nodeModules, ...segments.slice(0, binIndex + 1))
      if ((await lstat(directory)).isSymbolicLink()) await unlink(directory)
      else await rm(directory, { recursive: true, force: true })
      remaining = await findSymlink(nodeModules)
      continue
    }
    const destination = remaining
    const source = await realpath(destination)
    if (payload === source || payload.startsWith(source + sep)) {
      await unlink(destination)
      remaining = await findSymlink(nodeModules)
      continue
    }
    const nestedNodeModules = join(source, 'node_modules')
    await unlink(destination)
    await cp(source, destination, {
      recursive: true,
      dereference: true,
      filter: path => path !== nestedNodeModules && !path.startsWith(nestedNodeModules + sep),
    })
    remaining = await findSymlink(nodeModules)
  }
}
