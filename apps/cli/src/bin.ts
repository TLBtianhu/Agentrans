#!/usr/bin/env node
/**
 * Command-line entry for dsh.
 * @module @agentrans/cli/bin
 */

/* v8 ignore file -- built-bin acceptance exercises this self-executing dispatch. */

import { getDshRuntimeVersion, loadLayeredEnv, StartupError } from '@agentrans/app-boot'
import { resolveDshHome } from '@agentrans/home-paths'
import { parseDshArgs } from './args.ts'
import { reportStartupFailure } from './startup-diagnostics.ts'
import type { RunProfileOptions } from './profile-boot.ts'

/** Installation-owned dependencies supplied by a packaged CLI launcher. */
export type RunCliOptions = Pick<RunProfileOptions, 'packageManager'> & {
  /** Permit plugin commands for Desktop's existing profile; reserved for its installed carrier. */
  manageDesktopProfile?: boolean
}

/**
 * Run the public dsh command-line interface.
 * @param options - Package runtime and Desktop profile access supplied by the installation.
 * @returns a promise that settles when the selected command mode finishes.
 */
export async function runCli(options: RunCliOptions = {}): Promise<void> {
  const version = getDshRuntimeVersion()
  const { manageDesktopProfile, ...profileOptions } = options
  const invocation = parseDshArgs(process.argv.slice(2), version, manageDesktopProfile)

  switch (invocation.mode) {
    case 'profile': {
      const { runProfile } = await import('./profile-boot.ts')
      const { startupHomeNotice } = await import('./home.ts')
      // An upgrade must not look like a fresh installation; say where the old data sits.
      const notice = startupHomeNotice()
      if (notice !== undefined) console.warn(notice)
      try {
        await runProfile({
          environment: loadLayeredEnv('dsh'),
          profile: invocation.profile,
          fromDefaultProfile: invocation.fromDefaultProfile,
          patchFiles: invocation.patches,
          args: invocation.args,
          ...profileOptions,
        })
      } catch (error) {
        if (!(error instanceof StartupError)) throw error
        await reportStartupFailure(error, { home: resolveDshHome(), version, profile: invocation.profile })
        process.exit(1)
      }
      break
    }
    case 'plugin': {
      const { runPlugin } = await import('./plugin.ts')
      process.exit(await runPlugin(invocation.profile, invocation.args, options.packageManager))
      break
    }
    case 'dump-config': {
      const { runDumpConfig } = await import('./dump-config.ts')
      runDumpConfig(
        invocation.profile,
        invocation.defaultOnly,
        invocation.patches,
        invocation.fromDefaultProfile,
      )
      break
    }
    case 'dump-config-schema': {
      const { runDumpConfigSchema } = await import('./dump-config-schema.ts')
      await runDumpConfigSchema(invocation.profile, invocation.patches, invocation.fromDefaultProfile)
      break
    }
    case 'home': {
      const { adoptRetiredHome } = await import('./home.ts')
      const result = adoptRetiredHome()
      if (result.status === 'refused') {
        const reasons = {
          'no-retired-home': `no home at ${result.from}`,
          'home-exists': `${result.to} already exists; resolve the two homes yourself`,
          'not-a-directory': `${result.from} is not a directory`,
        }
        console.error(`agentrans: nothing moved: ${reasons[result.reason]}`)
        process.exit(1)
      }
      console.log(`agentrans: moved ${result.from} to ${result.to}`)
      break
    }
    default:
      invocation satisfies never
      throw new Error(`agentrans: unhandled invocation mode ${JSON.stringify(invocation)}`)
  }
}

if (import.meta.main) {
  await runCli()
}
