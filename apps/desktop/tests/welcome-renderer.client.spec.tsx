// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Welcome } from '../src/client/WelcomePage.tsx'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveDesktopLocale } from '../src/locale.ts'
import type { WelcomeApi, WelcomeSaveResult } from '../src/welcome-api.ts'

const html = readFileSync(join(import.meta.dirname, '../renderer/welcome.html'), 'utf8')
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function mount(language = 'zh-CN') {
  cleanup()
  const api = {
    ...resolveDesktopLocale(language),
    analytics: vi.fn(async (_event: string, _attributes: object) => {}),
    analyticsEnabled: async () => true,
    saveApiKey: vi.fn<(value: string) => Promise<WelcomeSaveResult>>().mockResolvedValue({ ok: true }),
    skip: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    openApiKeyPage: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  } satisfies WelcomeApi
  const mounted = render(<Welcome api={api} />)
  const input = document.querySelector('input')!
  const button = (id: string) => document.querySelector<HTMLButtonElement>(id)!
  const enterKey = (value: string) => { fireEvent.change(input, { target: { value } }) }
  const submit = () => fireEvent.submit(document.querySelector('form')!)
  const copy = () => [
    document.title, document.querySelector('.brand')!.textContent, document.querySelector('#key-title')!.textContent,
    document.querySelector('#key-description')!.textContent, `${input.placeholder} [password]`,
    ...[...document.querySelectorAll('button')].map(item => `${item.textContent}${item.disabled ? ' [disabled]' : ''}`), '',
  ].join('\n')
  return { document, api, input, button, enterKey, submit, copy, unmount: mounted.unmount }
}

describe('desktop welcome API-key setup', () => {
  it.each(['zh-CN', 'en'])('opens directly on the %s key form', async (language) => {
    const view = mount(language)
    expect(view.document.documentElement.lang).toBe(language)
    expect(screen.getByText('Agentrans')).toBe(view.document.querySelector('.brand'))
    expect(view.document.querySelector('img')).toBeNull()
    expect(view.document.body.innerHTML).not.toContain('welcome-brand.svg')
    expect(view.document.activeElement).toBe(view.input)
    expect(view.input.type).toBe('password')
    expect(view.input.autocomplete).toBe('new-password')
    expect(view.document.querySelector('#sign-in, #auth-page, #back-to-login')).toBeNull()
    await expect(view.copy()).toMatchFileSnapshot(`./expected/welcome/${language}.expected.txt`)
  })

  it('sends one trimmed key, blocks competing actions, and clears the draft only after saving', async () => {
    const view = mount()
    const saved = Promise.withResolvers<WelcomeSaveResult>()
    view.api.saveApiKey.mockReturnValue(saved.promise)
    view.enterKey('  sk-desktop-example  ')
    view.submit()
    view.submit()
    fireEvent.click(view.button('#skip-key'))
    fireEvent.click(view.button('#get-key'))
    expect(view.api.saveApiKey).toHaveBeenCalledExactlyOnceWith('sk-desktop-example')
    expect(view.api.skip).not.toHaveBeenCalled()
    expect(view.api.openApiKeyPage).not.toHaveBeenCalled()
    expect(view.input.value).toBe('  sk-desktop-example  ')
    for (const id of ['#save-key', '#skip-key', '#get-key']) expect(view.button(id).disabled).toBe(true)
    expect(view.document.querySelector('form')!.getAttribute('aria-busy')).toBe('true')
    await act(async () => { saved.resolve({ ok: true }); await saved.promise })
    expect(view.input.value).toBe('')
    expect(view.button('#skip-key').disabled).toBe(false)
    expect(view.api.analytics).toHaveBeenCalledExactlyOnceWith('api_key_save_click', {})
  })

  it.each(['rejected', 'thrown'] as const)('keeps saving independent of %s optional collection', async (failure) => {
    const view = mount()
    if (failure === 'rejected') view.api.analytics.mockRejectedValueOnce(new Error('collection unavailable'))
    else view.api.analytics.mockImplementationOnce(() => { throw new Error('collection unavailable') })
    view.enterKey('sk-private-draft')
    await act(async () => { view.submit() })
    expect(view.api.analytics).toHaveBeenCalledExactlyOnceWith('api_key_save_click', {})
    expect(view.api.saveApiKey).toHaveBeenCalledExactlyOnceWith('sk-private-draft')
    expect(view.input.value).toBe('')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it.each(['', 'bad key', '密钥', 'DEEPSEEK_API_KEY=sk-example', '"sk-example"', '`sk-example`'])(
    'rejects invalid input before sending it: %s', (value) => {
      const view = mount()
      view.enterKey(value)
      view.submit()
      expect(view.api.saveApiKey).not.toHaveBeenCalled()
      expect(screen.getByRole('alert').textContent).toBe(value === '' ? view.api.messages.welcomeKeyBlank : view.api.messages.welcomeKeyInvalid)
      expect(view.input.getAttribute('aria-invalid')).toBe('true')
      expect(view.document.activeElement).toBe(view.input)
    },
  )

  it.each(['refused', 'rejected'] as const)('keeps the draft private and permits retry after a %s save', async (outcome) => {
    const view = mount()
    if (outcome === 'refused') view.api.saveApiKey.mockResolvedValueOnce({ ok: false })
    else view.api.saveApiKey.mockRejectedValueOnce(new Error('private diagnostic sk-draft'))
    view.enterKey('sk-draft')
    await act(async () => { view.submit() })
    expect(view.input.value).toBe('sk-draft')
    expect(screen.getByRole('alert').textContent).toBe(view.api.messages.welcomeKeyFailed)
    expect(view.document.body.textContent).not.toContain('sk-draft')
    expect(view.button('#save-key').disabled).toBe(false)
    await act(async () => { view.submit() })
    expect(view.api.saveApiKey).toHaveBeenCalledTimes(2)
    expect(view.input.value).toBe('')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('skips once without saving and starts a fresh renderer with an empty key form', async () => {
    const view = mount()
    const skipped = Promise.withResolvers<undefined>()
    view.api.skip.mockReturnValueOnce(skipped.promise)
    view.enterKey('sk-not-saved')
    fireEvent.click(view.button('#skip-key'))
    fireEvent.click(view.button('#skip-key'))
    view.submit()
    fireEvent.click(view.button('#get-key'))
    expect(view.api.skip).toHaveBeenCalledOnce()
    expect(view.api.saveApiKey).not.toHaveBeenCalled()
    expect(view.api.openApiKeyPage).not.toHaveBeenCalled()
    await act(async () => { skipped.resolve(undefined); await skipped.promise })
    expect(view.input.value).toBe('')
    expect(mount().input.value).toBe('')
  })

  it('retains the draft and permits another choice when skipping fails', async () => {
    const view = mount()
    view.api.skip.mockRejectedValueOnce(new Error('private workspace path'))
    view.enterKey('sk-draft')
    await act(async () => { fireEvent.click(view.button('#skip-key')) })
    expect(screen.getByRole('alert').textContent).toBe(view.api.messages.welcomeContinueFailed)
    expect(view.input.value).toBe('sk-draft')
    expect(view.button('#save-key').disabled).toBe(false)
    await act(async () => { view.submit() })
    expect(view.api.saveApiKey).toHaveBeenCalledExactlyOnceWith('sk-draft')
  })

  it('opens the fixed Key page once through preload without sending or clearing the draft', async () => {
    const view = mount()
    const opened = Promise.withResolvers<undefined>()
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    view.api.openApiKeyPage.mockReturnValueOnce(opened.promise)
    view.enterKey('sk-unsent')
    fireEvent.click(view.button('#get-key'))
    fireEvent.click(view.button('#get-key'))
    view.submit()
    fireEvent.click(view.button('#skip-key'))
    expect(view.api.openApiKeyPage).toHaveBeenCalledExactlyOnceWith()
    expect(view.api.saveApiKey).not.toHaveBeenCalled()
    expect(view.api.skip).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    expect(view.document.querySelector('a[href]')).toBeNull()
    await act(async () => { opened.resolve(undefined); await opened.promise })
    expect(view.input.value).toBe('sk-unsent')
    expect(view.button('#get-key').disabled).toBe(false)
  })

  it('shows a safe link failure and allows retry without marking the key invalid', async () => {
    const view = mount()
    view.api.openApiKeyPage.mockRejectedValueOnce(new Error('private browser diagnostic'))
    view.enterKey('sk-draft')
    await act(async () => { fireEvent.click(view.button('#get-key')) })
    expect(screen.getByRole('alert').textContent).toBe(view.api.messages.welcomeKeyLinkFailed)
    expect(view.input.getAttribute('aria-invalid')).toBe('false')
    expect(view.input.value).toBe('sk-draft')
    await act(async () => { fireEvent.click(view.button('#get-key')) })
    expect(view.api.openApiKeyPage).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it.each(['save', 'skip', 'openApiKeyPage'] as const)('contains a late %s failure after the renderer unmounts', async (operation) => {
    const view = mount()
    const pending = Promise.withResolvers<never>()
    view.enterKey('sk-old-draft')
    if (operation === 'save') {
      view.api.saveApiKey.mockReturnValueOnce(pending.promise)
      view.submit()
    } else {
      view.api[operation].mockReturnValueOnce(pending.promise)
      fireEvent.click(view.button(operation === 'skip' ? '#skip-key' : '#get-key'))
    }
    view.unmount()
    const next = mount()
    next.enterKey('sk-new-draft')
    await act(async () => { pending.reject(new Error('late private operation failure')); await pending.promise.catch(() => {}) })
    expect(next.input.value).toBe('sk-new-draft')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(next.button('#save-key').disabled).toBe(false)
  })

  it('keeps visible copy in shell dictionaries and denies renderer network access', () => {
    expect([...html.matchAll(/>([^<]*\p{L}[^<]*)</gu)]).toEqual([])
    expect(html).toContain("default-src 'none'")
    expect(html).toContain("form-action 'none'")
  })
})
