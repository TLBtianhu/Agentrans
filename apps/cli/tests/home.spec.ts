import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { adoptRetiredHome, retiredHomeNotice, startupHomeNotice } from '../src/home.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(): { root: string; home: string; retired: string } {
  const root = mkdtempSync(join(tmpdir(), 'agentrans-home-'))
  roots.push(root)
  return { root, home: join(root, '.agentrans'), retired: join(root, '.dsh') }
}

describe('adoptRetiredHome', () => {
  it('moves the retired home onto the current one', () => {
    const { root, home, retired } = fixture()
    mkdirSync(retired)
    writeFileSync(join(retired, 'sessions.json'), '{}')

    expect(adoptRetiredHome({ home, retired })).toEqual({ status: 'moved', from: retired, to: home })
    expect(readdirSync(home)).toEqual(['sessions.json'])
    expect(readdirSync(root).sort()).toEqual(['.agentrans'])
  })

  it('refuses when the retired home is missing', () => {
    const { home, retired } = fixture()
    expect(adoptRetiredHome({ home, retired }))
      .toMatchObject({ status: 'refused', reason: 'no-retired-home' })
  })

  it('refuses to merge into an existing home', () => {
    const { home, retired } = fixture()
    mkdirSync(retired)
    mkdirSync(home)
    expect(adoptRetiredHome({ home, retired }))
      .toMatchObject({ status: 'refused', reason: 'home-exists' })
    expect(readdirSync(home)).toEqual([])
  })

  it('refuses a retired path that is not a directory', () => {
    const { home, retired } = fixture()
    writeFileSync(retired, 'not a home')
    expect(adoptRetiredHome({ home, retired }))
      .toMatchObject({ status: 'refused', reason: 'not-a-directory' })
  })

  it('refuses when the parent of the current home is missing', () => {
    const { home, retired } = fixture()
    mkdirSync(retired)
    const nested = join(home, 'nested', '.agentrans')
    expect(() => adoptRetiredHome({ home: nested, retired })).toThrow(/parent directory/u)
  })
})

describe('retiredHomeNotice', () => {
  it('names the retired home, the current one, and both choices', () => {
    const notice = retiredHomeNotice({ display: '~/.dsh' }, '/data/home')
    expect(notice).toContain('an earlier release kept its data at ~/.dsh')
    expect(notice).toContain('agentrans home adopt')
    expect(notice).toContain('AGENTRANS_HOME')
    expect(notice).toContain('another DeepSeek Harness installation')
  })
})

describe('startupHomeNotice', () => {
  it('returns nothing when the current home already exists', () => {
    const { home, retired } = fixture()
    mkdirSync(home)
    mkdirSync(retired)
    expect(startupHomeNotice({
      env: { AGENTRANS_HOME: home }, home, retired, exists: path => path === home || path === retired, entries: () => 1,
    })).toBeUndefined()
  })

  it('returns the notice for a retired home with data', () => {
    const { home, retired } = fixture()
    const notice = startupHomeNotice({ env: {}, home, retired, exists: path => path === retired, entries: () => 2 })
    expect(notice).toContain('~/.dsh')
    expect(notice).toContain('agentrans home adopt')
  })
})
