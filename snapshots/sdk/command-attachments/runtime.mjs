/** Keep the command-attachment fixture's ACL skill user-invocable without an automatic model catalog. */
import { isDeepStrictEqual } from 'node:util'

export const name = 'snapshot-command-attachment-skill-policy'
export const inject = ['skills', 'tools', 'workingDirectory']

const skillName = 'diagnose-windows-sandbox-acl'

export function apply(ctx) {
  if (process.platform !== 'win32') return
  ctx.on('agent/created', async ({ agent, signal }) => {
    const cwd = await ctx.workingDirectory.ensure(agent, signal)
    const lookup = { cwd, signal }
    const original = await ctx.skills.get(skillName, lookup)
    if (original === undefined || original.provider !== 'dsh-windows-acl' || original.source !== 'bundled'
      || original.invocation.modelInvocable !== true || original.invocation.userInvocable !== true) {
      throw new Error('Command attachments require the real globally available Windows ACL diagnosis skill')
    }
    const scoped = agent.ctx.get('skills')
    if (scoped === undefined) throw new Error('Command attachments require the agent-scoped skill registry')
    if (!isDeepStrictEqual(await ctx.skills.get(skillName, { ...lookup, scope: agent }), original)) {
      throw new Error('Command attachments found an unexpected existing scoped ACL skill override')
    }
    const userOnly = { ...original, invocation: { modelInvocable: false, userInvocable: true } }
    // register() owns its disposer through the calling agent context's effect.
    scoped.register(userOnly)
    const loaded = await ctx.skills.get(skillName, { ...lookup, scope: agent })
    if (!isDeepStrictEqual(loaded, userOnly)) {
      throw new Error('Command attachments must preserve the complete real ACL skill definition for scoped user loading')
    }
    if (!isDeepStrictEqual(await ctx.skills.get(skillName, lookup), original)) {
      throw new Error('Command attachments must preserve the global ACL skill and its invocation policy')
    }
    if (ctx.tools.get('skill', agent) === undefined) {
      throw new Error('Command attachments must preserve the model skill tool and its schema')
    }
  })
}
