import { expect, it } from 'vitest'
import { connectDesktopWelcome } from '../src/welcome-backend.ts'

it('waits briefly for Remote descriptors during welcome startup', async () => {
  const calls: string[] = []
  let settingsCalls = 0
  const backend = await connectDesktopWelcome('http://127.0.0.1:1234/?token=owned', async (input, init) => {
    const url = input
    calls.push(url)
    if (!url.includes('/api/')) return new Response(null, { status: 200 })
    if (typeof init?.body !== 'string') throw new TypeError('Expected a JSON-RPC string body')
    const body = JSON.parse(init.body) as { rpcId: string }
    if (url.endsWith('/api/settings/describe')) {
      settingsCalls++
      if (settingsCalls === 1) return new Response('not found', { status: 404 })
    }
    return Response.json({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value: { namespaces: [{ ns: 'locale', value: {} }] } } })
  })
  await expect(backend.readLocalePreference()).resolves.toBeNull()
  expect(settingsCalls).toBe(2)
  expect(calls.filter(url => url.endsWith('/api/settings/describe'))).toHaveLength(2)
})

it('detects configured keys across provider settings without requesting account state', async () => {
  const methods: string[] = []
  const backend = await connectDesktopWelcome('http://127.0.0.1:1234/?token=owned', async (input, init) => {
    if (!input.includes('/api/')) return new Response(null, { status: 200 })
    if (typeof init?.body !== 'string') throw new TypeError('Expected a JSON-RPC string body')
    const body = JSON.parse(init.body) as { rpcId: string; method: string; payload: { args: { refs?: string[] } } }
    methods.push(body.method)
    let value: unknown
    if (body.method === 'settings/describe') value = { namespaces: [
      { ns: 'locale', value: { preference: 'zh-CN' } },
      { ns: 'llm-deepseek', value: { apiKeyEnv: 'OFFICIAL_FIXTURE_KEY' } },
      { ns: 'llm-pi-ai', value: { profiles: { custom: { apiKeyEnv: 'CUSTOM_FIXTURE_KEY' } } } },
    ] }
    else if (body.method === 'llm/listConfigurableProviders') value = [
      { settingsNs: 'llm-deepseek', settingsPath: [] },
      { settingsNs: 'llm-pi-ai', settingsPath: ['profiles', 'custom'] },
    ]
    else if (body.method === 'credentials/describe') {
      expect(body.payload.args.refs).toEqual(['OFFICIAL_FIXTURE_KEY', 'CUSTOM_FIXTURE_KEY'])
      value = {
        OFFICIAL_FIXTURE_KEY: { configured: false, writable: true },
        CUSTOM_FIXTURE_KEY: { configured: true, writable: true },
      }
    } else throw new Error(`Unexpected native welcome request: ${body.method}`)
    return Response.json({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value } })
  })

  await expect(backend.read()).resolves.toEqual({ hasApiKey: true, writable: true, localePreference: 'zh-CN' })
  expect(methods).toEqual(['settings/describe', 'llm/listConfigurableProviders', 'credentials/describe'])
  expect(backend).not.toHaveProperty('account')
})

it('reads an unconfigured profile without requiring an official provider or account service', async () => {
  const methods: string[] = []
  const backend = await connectDesktopWelcome('http://127.0.0.1:1234/?token=owned', async (input, init) => {
    if (!input.includes('/api/')) return new Response(null, { status: 200 })
    if (typeof init?.body !== 'string') throw new TypeError('Expected a JSON-RPC string body')
    const body = JSON.parse(init.body) as { rpcId: string; method: string }
    methods.push(body.method)
    let value: unknown
    if (body.method === 'settings/describe') value = { namespaces: [{ ns: 'locale', value: {} }] }
    else if (body.method === 'llm/listConfigurableProviders') value = []
    else throw new Error(`Unexpected native welcome request: ${body.method}`)
    return Response.json({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value } })
  })

  await expect(backend.read()).resolves.toEqual({ hasApiKey: false, writable: false, localePreference: null })
  expect(methods).toEqual(['settings/describe', 'llm/listConfigurableProviders'])
})

it('keeps key saves write-only and returns a safe failure when the Host rejects a write', async () => {
  const methods: string[] = []
  let failWrite = false
  const backend = await connectDesktopWelcome('http://127.0.0.1:1234/?token=owned', async (input, init) => {
    if (!input.includes('/api/')) return new Response(null, { status: 200 })
    if (typeof init?.body !== 'string') throw new TypeError('Expected a JSON-RPC string body')
    const body = JSON.parse(init.body) as { rpcId: string; method: string; payload: { args: unknown } }
    methods.push(body.method)
    let value: unknown
    if (body.method === 'settings/describe') value = {
      namespaces: [{ ns: 'llm-deepseek', value: { apiKeyEnv: 'OFFICIAL_FIXTURE_KEY' } }],
    }
    else if (body.method === 'credentials/set') {
      if (failWrite) throw new Error('private provider diagnostic')
      expect(body.payload.args).toEqual({ ref: 'OFFICIAL_FIXTURE_KEY', value: 'unit-test-key' })
      value = null
    } else throw new Error(`Unexpected native welcome request: ${body.method}`)
    return Response.json({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value } })
  })

  await expect(backend.save('unit-test-key')).resolves.toEqual({ ok: true })
  failWrite = true
  await expect(backend.save('unit-test-key')).resolves.toEqual({ ok: false })
  expect(methods).toEqual(['settings/describe', 'credentials/set', 'settings/describe', 'credentials/set'])
})
