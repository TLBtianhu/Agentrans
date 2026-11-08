/**
 * One owner for the DeepSeek platform identity.
 *
 * The DeepSeek key authenticates several capability classes, and each class has
 * its own endpoint: the Messages API, the search endpoint, and the search/fetch
 * tools API. The credential is shared; the endpoints are not, and a provider
 * must not learn the others' configuration. Every default name lives here so a
 * provider, its settings card, and its documentation cannot drift apart.
 *
 * This module carries identity and defaults only. It performs no request,
 * holds no secret, and has no Cordis surface.
 * @module @deepseek-ai/dsh-deepseek-issuer
 */

/** Issuer id shared by every DeepSeek capability class. */
export const DEEPSEEK_ISSUER = 'deepseek'

/**
 * Credential reference every DeepSeek capability class reads by default.
 *
 * One secret authenticates all of them; a capability that needs a different
 * secret (another vendor, a self-hosted gateway) overrides this on its own
 * configuration instead of introducing a second default here.
 */
export const DEEPSEEK_API_KEY_REF = 'DEEPSEEK_API_KEY'

/** Capability classes the issuer serves. */
export const DEEPSEEK_CAPABILITIES = ['models', 'search', 'search-tools'] as const

/** One DeepSeek capability class. */
export type DeepSeekCapability = typeof DEEPSEEK_CAPABILITIES[number]

/** An endpoint default and the environment variable that overrides it. */
export interface DeepSeekEndpointDefault {
  /** Endpoint used when no configuration overrides it. */
  readonly url: string
  /** Environment variable that overrides {@link url}. */
  readonly environmentVariable: string
}

/**
 * Endpoint defaults by capability class.
 *
 * `models` and `search-tools` are roots the provider appends its own paths to;
 * `search` is the Anthropic-compatible root the search provider calls directly.
 * They stay separate on purpose: pointing the model route at a gateway must not
 * move the search route, and the reverse.
 */
export const DEEPSEEK_ENDPOINTS = {
  models: { url: 'https://api.deepseek.com/anthropic', environmentVariable: 'DEEPSEEK_BASE_URL' },
  search: { url: 'https://api.deepseek.com/anthropic/v1', environmentVariable: 'DEEPSEEK_SEARCH_BASE_URL' },
  'search-tools': { url: 'https://api.deepseek.com/v1/tools', environmentVariable: 'DEEPSEEK_SEARCH_TOOLS_BASE_URL' },
} as const satisfies Record<DeepSeekCapability, DeepSeekEndpointDefault>
