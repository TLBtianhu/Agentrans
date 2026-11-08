/** Prepare immutable per-run bootstrap files without launching the application or loading credentials. */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { readInstalledUpdateRun } from './installed-update-qualification.ts'

/**
 * Write the shared qualification entry for both versions; refuse to overwrite an existing preparation.
 * @param manifest Original run.json in its allocated directory.
 * @returns The private directory whose two modules must be included in each package's files.
 */
export async function prepareInstalledUpdateBootstrap(manifest: string): Promise<string> {
  const run = await readInstalledUpdateRun(manifest)
  const directory = join(run.root, 'bootstrap')
  await mkdir(directory)
  const identity = await build({
    entryPoints: [join(import.meta.dirname, 'installed-update-identity.mjs')],
    bundle: true, platform: 'node', format: 'esm', target: 'node24', write: false,
    alias: {
      '@deepseek-ai/dsh-product-layout/launch-context': fileURLToPath(new URL('../../../packages/boot/product-layout/src/launch-context.ts', import.meta.url)),
    },
  })
  await writeFile(join(directory, 'installed-update-identity.mjs'), identity.outputFiles[0]!.contents,
    { flag: 'wx', mode: 0o600, flush: true })
  const entry = `import { app } from 'electron'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { configureInstalledUpdateIdentity } from './installed-update-identity.mjs'

const run = ${JSON.stringify({ id: run.id, versions: run.versions })}
const metadata = JSON.parse(readFileSync(join(app.getAppPath(), 'package.json'), 'utf8'))
configureInstalledUpdateIdentity(app, run, metadata, process.env, process.resourcesPath ?? app.getAppPath())
await import('./lib/main.js')
`
  await writeFile(join(directory, 'qualification-bootstrap.mjs'), entry, { flag: 'wx', mode: 0o600, flush: true })
  return directory
}
