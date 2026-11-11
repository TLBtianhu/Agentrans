/**
 * Register a DeepSeek-backed provider in `ctx.web`. It calls the Anthropic-compatible Messages API
 * with native `web_search_20250305`. A search initiated by a Session on the DeepSeek account route
 * authenticates with the account token when the account service allows the search endpoint;
 * every other search reuses `DEEPSEEK_API_KEY`. The provider does not reuse `DEEPSEEK_BASE_URL`;
 * auxiliary search has its own endpoint configuration. The provider reports itself not ready for a
 * model request whose search would have no credential.
 * @module @agentrans/web-search-deepseek
 */
import type { Volatile } from '@agentrans/cordis'

import type { Context } from '@agentrans/cordis'
import z from '@agentrans/schemastery'
import type {} from '@agentrans/agent'
import { credentialRef } from '@agentrans/credentials'
import type { CredentialRef } from '@agentrans/credentials'
import { DEEPSEEK_API_KEY_REF } from '@agentrans/deepseek-issuer'
import type {} from '@agentrans/deepseek-account'
import { launchEnvironmentOf } from '@agentrans/launch-environment'
import type {} from '@agentrans/session'
import type { WebCapabilityState } from '@agentrans/web'
import {
  DeepSeekSearchProvider,
  DEEPSEEK_DEFAULT_API_VERSION,
  DEEPSEEK_DEFAULT_BASE_URL,
  DEEPSEEK_DEFAULT_MAX_TOKENS,
  DEEPSEEK_DEFAULT_MAX_USES,
  DEEPSEEK_DEFAULT_MODEL,
} from './provider.ts'
import type { DeepSeekSearchProviderOptions } from './provider.ts'

export {
  DeepSeekSearchProvider,
  DEEPSEEK_DEFAULT_API_VERSION,
  DEEPSEEK_DEFAULT_BASE_URL,
  DEEPSEEK_DEFAULT_MAX_TOKENS,
  DEEPSEEK_DEFAULT_MAX_USES,
  DEEPSEEK_DEFAULT_MODEL,
  DEEPSEEK_PROVIDER_ID,
} from './provider.ts'
export type { DeepSeekSearchLlmRequest, DeepSeekSearchProviderOptions } from './provider.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-deepseek'

/** The web seam this provider registers into. */
export const inject = ['web']

const DEFAULT_API_KEY_ENV = DEEPSEEK_API_KEY_REF

/** Plugin config (all optional — `apply` fills env-var and constant defaults). */
export interface Config {
  /** Credential reference resolved for each search; defaults to `DEEPSEEK_API_KEY`. */
  apiKeyEnv: Volatile<string>
  /** Anthropic-compatible endpoint base; `/messages` is appended. */
  baseURL: Volatile<string | undefined>
  /** Anthropic-format model name. Defaults to `deepseek-v4-flash`. */
  model: Volatile<string>
  /** `anthropic-version` header value. Defaults to `2023-06-01`. */
  apiVersion: Volatile<string>
  /** Upper bound on generated tokens for the Messages request. Defaults to 4096. */
  maxTokens: Volatile<number>
  /** Maximum `web_search` server-tool uses per request. Defaults to 5. */
  maxUses: Volatile<number>
}

export const Config = z.object({
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV).volatile(),
  // Declared here rather than only at the use site: a configuration surface
  // renders the resolved section, so a default the schema does not carry reads
  // there as no value at all.
  baseURL: z.string().volatile(),
  model: z.string().default(DEEPSEEK_DEFAULT_MODEL).volatile(),
  apiVersion: z.string().default(DEEPSEEK_DEFAULT_API_VERSION).volatile(),
  maxTokens: z.number().step(1).min(1).default(DEEPSEEK_DEFAULT_MAX_TOKENS).volatile(),
  maxUses: z.number().step(1).min(1).default(DEEPSEEK_DEFAULT_MAX_USES).volatile(),
})

/**
 * Auxiliary-search endpoint, independent of the conversation adapter's
 * `$DEEPSEEK_BASE_URL` and selected protocol.
 */
const SEARCH_BASE_URL_ENV = 'DEEPSEEK_SEARCH_BASE_URL'

/** Provider route id `dsh-llm-deepseek-account` registers; `request/context` events record it per Session. */
const ACCOUNT_PROVIDER = 'deepseek-account'

/** Settings namespace carrying this provider's endpoint, model, and key reference. */
export const WEB_SEARCH_DEEPSEEK_SETTINGS_NAMESPACE = 'web-search-deepseek'

/** Options for one search, with the key reference the readiness check reads. */
type SearchOptions = DeepSeekSearchProviderOptions & { readonly apiKeyEnv: CredentialRef }

/**
 * Project one resolved section into the options the provider serves its next
 * search with. Environment fallbacks stay here rather than in the provider:
 * every value it reads is already fully defaulted.
 * @param ctx - plugin context supplying the credential and environment planes.
 * @param config - the currently authoritative section.
 * @returns options for one search.
 */
function resolveOptions(
  ctx: Context, config: { [K in keyof Config]: ReturnType<Config[K]['get']> },
): SearchOptions {
  const apiKeyEnv = credentialRef(config.apiKeyEnv)
  return {
    resolveAccountToken: async (endpoint) => {
      // The latest request context names the route that served the model
      // request which called this search, as account sign-out reads it.
      const provider = ctx.get('agents')?.currentInitiator()?.session.requestContext()?.provider
      if (provider !== ACCOUNT_PROVIDER) return undefined
      return await ctx.get('deepseekAccount')?.resolveToken(endpoint)
    },
    resolveApiKey: async () => {
      const credentials = ctx.get('credentials')
      if (credentials !== undefined) return (await credentials.resolve(apiKeyEnv))?.value
      // Without the seam the environment is the whole credential plane.
      const ambient = launchEnvironmentOf(ctx).get(apiKeyEnv)
      return ambient !== undefined && ambient.value.length > 0 ? ambient.value : undefined
    },
    apiKeyEnv,
    baseURL: config.baseURL
      ?? launchEnvironmentOf(ctx).get(SEARCH_BASE_URL_ENV)?.value
      ?? DEEPSEEK_DEFAULT_BASE_URL,
    model: config.model,
    apiVersion: config.apiVersion,
    maxTokens: config.maxTokens,
    maxUses: config.maxUses,
    recordRequest: (request) => {
      ctx.get('agents')?.currentInitiator()?.session.append(
        'web/deepseek-search-llm-request',
        request,
      )
    },
  }
}

/**
 * Report why the search a model request on `route` would make can or cannot authenticate,
 * checked in the order the search resolves credentials: the account token first on the
 * account route, then the API key. The three failure facts stay distinct — a failed grant
 * or store read is `unreachable`, an unconfigured reference is `missing`, and a search that
 * carries a credential is `ready` — so a surface can say what to fix.
 * Only presence is checked: the API key's value is not read and the endpoint is not contacted, so a
 * wrong key or an endpoint without native search still counts as configured.
 * @param ctx - plugin context supplying the account, credential, and environment planes.
 * @param options - options the next search would use.
 * @param route - provider route of the model request being assembled.
 * @returns the capability state for that search.
 */
async function searchState(
  ctx: Context, options: SearchOptions, route: string | undefined,
): Promise<WebCapabilityState> {
  const account = ctx.get('deepseekAccount')
  if (route === ACCOUNT_PROVIDER && account !== undefined) {
    let token: string | undefined
    try { token = await account.resolveToken(`${options.baseURL}/messages`) }
    catch (_unreadableGrant) { return 'unreachable' /* The search fails on this read before it tries the API key. */ }
    if (token !== undefined && token.length > 0) return 'ready'
  }
  const credentials = ctx.get('credentials')
  if (credentials === undefined) {
    const ambient = launchEnvironmentOf(ctx).get(options.apiKeyEnv)
    return ambient !== undefined && ambient.value.length > 0 ? 'ready' : 'missing'
  }
  try { return (await credentials.describe(options.apiKeyEnv)).configured ? 'ready' : 'missing' }
  catch (_unreadableStore) { return 'unreachable' /* A store that cannot be read supplies no key to the search either. */ }
}

/**
 * Reject the retired literal-key field.
 *
 * Configuration validation keeps keys the schema does not declare, so a key left behind by
 * an older configuration would otherwise sit in the resolved section unread: searches would
 * report no credential while the user could see one in the file.
 * @param config - the resolved plugin configuration.
 * @throws Error naming the field and where the key belongs now.
 */
function assertNoRetiredKey(config: Config): void {
  if (Object.hasOwn(config, 'apiKey')) {
    throw new Error('web-search-deepseek: "apiKey" is no longer configurable; '
      + 'store the key through the credentials service (the web Models page writes it) '
      + 'or export it in the launching environment, and remove apiKey from this entry')
  }
}

/**
 * Register the DeepSeek search provider with `ctx.web`. Its `state()` answers why a search
 * for a model request on the given route can or cannot authenticate.
 */
export function apply(ctx: Context, config: Config): void {
  assertNoRetiredKey(config)
  const options = () => resolveOptions(ctx, {
    apiKeyEnv: config.apiKeyEnv.get(), baseURL: config.baseURL.get(), model: config.model.get(),
    apiVersion: config.apiVersion.get(), maxTokens: config.maxTokens.get(), maxUses: config.maxUses.get(),
  })
  const provider = new DeepSeekSearchProvider(options)
  ctx.web.registerSearchProvider({
    id: provider.id,
    available: () => provider.available(),
    state: llmProvider => searchState(ctx, options(), llmProvider),
    search: (request, signal) => provider.search(request, signal),
  })
}
