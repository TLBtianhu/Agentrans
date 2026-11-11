/** The optional Developer Tools bundle enables both inspectors, including fetch capture. */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { entryListSchema } from '@agentrans/cordis-plugin-include'
import * as yaml from 'js-yaml'

describe('Inspector profile bundle', () => {
  it('publishes one layer containing both inspectors and the Statistics view', () => {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      publishConfig: { access: string }
      agentrans: { bundle: { patch: string } }
      dependencies: Record<string, string>
    }
    expect(manifest.publishConfig.access).toBe('public')
    expect(manifest.agentrans.bundle.patch).toBe('./cordis.patch.yml')
    expect(manifest.dependencies).toEqual({
      '@agentrans/experimental-client-ui-stats': 'workspace:*',
      '@agentrans/experimental-inspector': 'workspace:*',
      '@agentrans/experimental-session-inspector': 'workspace:*',
    })
    expect(yaml.load(readFileSync(new URL(`../${manifest.agentrans.bundle.patch}`, import.meta.url), 'utf8'), {
      schema: entryListSchema,
    })).toEqual([{ insert: [
      {
        id: 'experimental-inspector', name: '@agentrans/experimental-inspector',
        disabled: false, config: { captureFetch: true },
      },
      { id: 'session-inspector', name: '@agentrans/experimental-session-inspector' },
      { id: 'client-ui-stats', name: '@agentrans/experimental-client-ui-stats' },
    ] }])
  })
})
