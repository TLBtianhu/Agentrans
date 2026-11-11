import { describe, expect, it } from 'vitest'
import {
  collectDisabledImportViolations,
  disabledImportsInSource,
  disabledPackageNames,
  packageNameOf,
} from './verify-disabled-package-imports.ts'

const disabled = new Set(['@agentrans/session-log-deepseek'])

describe('shipped-but-off package imports', () => {
  it('rejects a runtime import', () => {
    const source = "import { SessionLog } from '@agentrans/session-log-deepseek'\nexport const use = SessionLog\n"
    expect(disabledImportsInSource('packages/x/src/index.ts', source, disabled))
      .toEqual([expect.stringContaining('imports @agentrans/session-log-deepseek at runtime')])
  })

  it('accepts a type-only import used for declaration merging', () => {
    expect(disabledImportsInSource('packages/x/src/index.ts', "import type {} from '@agentrans/session-log-deepseek'\n", disabled))
      .toEqual([])
  })

  it('reads the package name from a disabled package manifest', () => {
    expect(packageNameOf('packages/session/session-log-deepseek')).toBe('@agentrans/session-log-deepseek')
    expect(packageNameOf('packages/nonexistent/package')).toBeUndefined()
  })

  it('knows every shipped-but-off package', () => {
    expect(disabledPackageNames().size).toBeGreaterThanOrEqual(8)
  })

  it('accepts the current tree', () => {
    const { violations, scannedPackages } = collectDisabledImportViolations()
    expect(violations).toEqual([])
    expect(scannedPackages).toBeGreaterThan(300)
  })
})
