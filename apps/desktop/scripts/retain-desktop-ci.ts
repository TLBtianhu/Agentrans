/** Copy a completed CI package out of the disposable checkout for later publication. */

import { appendFile, cp, mkdir, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { desktopTargetBuildPaths, resolveDesktopBuildTarget } from './desktop-build-paths.mjs'

/**
 * Resolve the artifact directory a packaging job produced for its target.
 * @param target - Resolved Desktop target name.
 * @param qualification - Signing or notarization state the job produced.
 * @returns Absolute artifact directory.
 */
export function desktopCiArtifactDirectory(
  target: ReturnType<typeof resolveDesktopBuildTarget>,
  qualification: string,
): string {
  const paths = desktopTargetBuildPaths(target)
  if (qualification === 'unsigned') return paths.unsignedArtifacts
  if (qualification === 'unnotarized') return paths.unnotarizedArtifacts
  return paths.artifacts
}

/**
 * Copy every packaged file into a directory outside the checkout.
 *
 * The build directory is disposable: a later job that publishes the release may
 * run from a different checkout or after this one is cleaned, so the artifacts
 * must exist at a path the workflow can hand to an upload step.
 * @param env - Workflow environment naming the target and signing selection.
 * @param directories - Explicit artifact source and destination; the workflow omits them and uses the build layout.
 * @returns Directory containing the copied artifacts.
 */
export async function retainDesktopCi(
  env: NodeJS.ProcessEnv,
  directories: { artifacts?: string; retained?: string } = {},
): Promise<string> {
  const target = resolveDesktopBuildTarget(env)
  const windows = target === 'win-x64'
  const qualification = windows
    ? (env.PACKAGE_SIGNING === 'signed' ? 'signed' : 'unsigned')
    : (env.PACKAGE_SKIP_NOTARIZATION === 'true' ? 'unnotarized' : 'notarized')
  const source = directories.artifacts ?? desktopCiArtifactDirectory(target, qualification)
  // The retained path must outlive the checkout but stay writable by this job.
  const retained = directories.retained ?? resolve(env.RUNNER_TEMP ?? tmpdir(), `retained-desktop-${target}`)
  await mkdir(retained, { recursive: true })
  const entries = await readdir(source)
  if (entries.length === 0) throw new Error(`desktop retention: ${source} contains no artifacts`)
  for (const name of entries) await cp(join(source, name), join(retained, name), { recursive: true })
  if (env.GITHUB_OUTPUT !== undefined) await appendFile(env.GITHUB_OUTPUT, `directory=${retained}\n`)
  if (env.GITHUB_STEP_SUMMARY !== undefined) {
    await appendFile(env.GITHUB_STEP_SUMMARY,
      `\nRetained ${String(entries.length)} packaged file(s) for ${target}.\n\nPublish with publish-github-release from this directory.\n`)
  }
  return retained
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename) {
  await retainDesktopCi(process.env)
}
