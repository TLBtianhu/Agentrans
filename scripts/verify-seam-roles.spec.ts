import { describe, expect, it } from 'vitest'
import {
  collectSeamRoleViolations,
  roleNamesOf,
  providerImportsInSource,
  providerPackagesOf,
  workspacePackages,
} from './verify-seam-roles.ts'
import { SERVICE_ROLES } from './gen-doc-graphs.ts'

const providers = new Set(['@agentrans/llm-deepseek-account'])

describe('seam role verification', () => {
  it('rejects a consumer that imports the provider', () => {
    const source = "import { DeepSeekAccount } from '@agentrans/llm-deepseek-account'\nexport const x = DeepSeekAccount\n"
    expect(providerImportsInSource('packages/web/web-search-deepseek/src/index.ts', source, 'deepseekAccount', 'deepseek-account', providers))
      .toEqual([expect.stringContaining('imports provider @agentrans/llm-deepseek-account at runtime')])
  })

  it('accepts the service lookup and a type-only import', () => {
    const source = [
      "import type {} from '@agentrans/llm-deepseek-account'",
      'export const token = (ctx: { get: (key: string) => { resolveToken: () => string } | undefined }) => ctx.get(\'deepseekAccount\')?.resolveToken()',
      '',
    ].join('\n')
    expect(providerImportsInSource('packages/web/web-search-deepseek/src/index.ts', source, 'deepseekAccount', 'deepseek-account', providers))
      .toEqual([])
  })

  it('maps a seam to the packages implementing it', () => {
    expect(providerPackagesOf({ implementations: ['llm-deepseek-account'] }))
      .toEqual(new Set(['@agentrans/llm-deepseek-account']))
    expect(providerPackagesOf({})).toEqual(new Set())
  })

  it('resolves workspace packages to the names the role table uses', () => {
    const packages = workspacePackages()
    const account = packages.find(pkg => pkg.short === 'deepseek-account')
    expect(account?.name).toBe('@agentrans/deepseek-account')
    expect(account?.directory).toBe('packages/credentials/deepseek-account')
  })

  it('names only packages that exist', () => {
    const known = new Set(workspacePackages().flatMap(pkg => roleNamesOf(pkg)))
    const unknown = SERVICE_ROLES.flatMap(seam => [seam.pkg, ...seam.consumers ?? [], ...seam.implementations ?? []])
      .filter(short => !known.has(short))
    expect(unknown).toEqual([])
  })

  it('accepts the current tree', () => {
    const { violations, seamsChecked } = collectSeamRoleViolations()
    expect(violations).toEqual([])
    expect(seamsChecked).toBeGreaterThan(20)
  })
})
