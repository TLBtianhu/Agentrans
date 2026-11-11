import { Context } from '@agentrans/cordis'
import Sandbox from '@agentrans/sandbox-local'
import SandboxPolicy from '@agentrans/sandbox-policy'
import SessionProjections from '@agentrans/session-projection'
import { onTestFinished } from 'vitest'
import type { SandboxMode } from '@agentrans/sandbox'

/** Mount the Python runtime's policy and confinement providers with owned teardown. */
export async function createRuntimeContext(policy: { mode?: SandboxMode; workspaceRoot?: string } = {}): Promise<Context> {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(Sandbox, {})
  await ctx.plugin(SessionProjections)
  await ctx.plugin(SandboxPolicy, { mode: 'danger-full-access', ...policy })
  return ctx
}
