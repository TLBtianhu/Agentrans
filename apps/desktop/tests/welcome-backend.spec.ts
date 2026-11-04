import { expect, it } from 'vitest'
import { connectDesktopWelcome } from '../src/welcome-backend.ts'

it('waits briefly for Remote descriptors during welcome startup', async () => {
  const calls: string[] = []
  let settingsCalls = 0
  const backend = await connectDesktopWelcome('http://127.0.0.1:1234/?token=owned', async (input, init) => {
    const url = String(input)
    calls.push(url)
    if (!url.includes('/api/')) return new Response(null, { status: 200 })
    const body = JSON.parse(String(init?.body)) as { rpcId: string }
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
