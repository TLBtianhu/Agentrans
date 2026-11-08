/** Test-only request contribution observing the actual minimal profile's sharing rows. */
export const name = 'sdk-minimal-sharing-probe'
export const inject = ['deepseekLlmApiExtensions', 'loader', 'profileContext']

/** Register through the same public extension registry that sharing contributors use. */
export function apply(ctx) {
  ctx.deepseekLlmApiExtensions.register('dsh_minimal_fixture_probe', {
    prepare() {
      const entries = [...ctx.loader.entries()]
      return { value: {
        profile: ctx.profileContext.name,
        sessionLogService: ctx.get('sessionLogDeepSeek') !== undefined,
        rows: ['session-log-deepseek', 'plugin-package-inventory-deepseek'].map(id => {
          const entry = entries.find(candidate => candidate.options.id === id)
          if (entry === undefined) throw new Error(`Missing SDK-minimal sharing row: ${id}`)
          return { id, disabled: entry.disabled, mounted: entry.fiber !== undefined }
        }),
      } }
    },
  })
}
