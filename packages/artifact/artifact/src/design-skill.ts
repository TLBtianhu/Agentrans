/** Bundled design guidance for authoring custom inline HTML. */
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import type { Context } from '@agentrans/cordis'
import { BUNDLED_SKILL_RANK, type SkillCandidate } from '@agentrans/skill'
import { parse as parseYaml } from 'yaml'

/**
 * Register the bundled `artifact-design` skill; loading it returns the instructions and the parameter explorer template.
 * @param ctx - The HTML tool's scope with a skill registry.
 */
export function registerArtifactDesignSkill(ctx: Context): void {
  const skillRoot = new URL('../skills/artifact-design/', import.meta.url)
  const manifest = readFileSync(new URL('SKILL.md', skillRoot), 'utf8')
  const frontmatter = /^---\r?\n([\s\S]+?)\r?\n---\r?\n/u.exec(manifest)
  if (frontmatter?.[1] === undefined) throw new Error('artifact-design: SKILL.md requires YAML frontmatter')
  const metadata: unknown = parseYaml(frontmatter[1])
  if (typeof metadata !== 'object' || metadata === null || !('name' in metadata) || metadata.name !== 'artifact-design'
    || !('description' in metadata) || typeof metadata.description !== 'string' || metadata.description.trim() === '') {
    throw new Error('artifact-design: SKILL.md requires name artifact-design and a description')
  }
  const instructions = manifest.slice(frontmatter[0].length).trim()
  const templateUrl = new URL('parameter-explorer.html', skillRoot)
  const summary = {
    name: 'artifact-design', description: metadata.description,
    provider: 'artifact-design', source: 'bundled',
    invocation: { modelInvocable: true, userInvocable: true },
  } as const
  const candidate: SkillCandidate = { ...summary, rank: BUNDLED_SKILL_RANK, locator: null }
  ctx.skills.registerProvider(() => ({
    name: summary.provider,
    list: () => Promise.resolve([candidate]),
    async get(_candidate, { signal }) {
      const template = await readFile(templateUrl, { encoding: 'utf8', signal })
      return { ...summary, content: `${instructions}\n\n## parameter-explorer.html\n\n\`\`\`html\n${template.trimEnd()}\n\`\`\`` }
    },
  }))
}
