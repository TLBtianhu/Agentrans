import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseSessionLog, prepareSessionSnapshotFixtureForComparison } from '@deepseek-ai/dsh-llm-replay'
import {
  assertCorpusReplayFixtureOwner,
  assertFixtureInventory,
  parseSeedFixture,
  recordedSessionFixturePath,
  selectedSessionFixture,
} from './scaffold.ts'

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('Web seed stream timing', () => {
  it.each([2, 3])('preserves embedded timestamps from format v%i and its current projection', async (version) => {
    const fixture = await readFile(new URL(`../../../snapshots/session/skill-load/session.v${version}.jsonl`, import.meta.url), 'utf8')
    const current = prepareSessionSnapshotFixtureForComparison(fixture)
    const expected = parseSessionLog(current)

    expect(parseSeedFixture(fixture).events).toEqual(expected)
    expect(parseSeedFixture(current).events).toEqual(expected)
  })

  it.each(['session.jsonl', 'session.v1.jsonl'])('reconstructs positive stream intervals from %s', async (filename) => {
    const fixture = await readFile(new URL(`../../../snapshots/session/text-turn/${filename}`, import.meta.url), 'utf8')
    const messages = parseSeedFixture(fixture).events.filter(event => event.type === 'assistant/message')
    expect(messages).toHaveLength(1)
    const stream = messages[0]!.data.stream
    expect(stream.length).toBeGreaterThan(1)

    let previousEnd = -1
    for (const record of stream) {
      const start = 'time' in record ? record.time : record.time0
      expect(start).toBeGreaterThan(previousEnd)
      previousEnd = 'time' in record ? record.time : record.time0 + record.dt.reduce((total, delta) => total + delta, 0)
    }
    expect(previousEnd).toBeGreaterThan(0)
  })
})

describe('Web replay fixture ownership', () => {
  async function fixture(profile = 'web'): Promise<{ root: string; corpus: string; directory: string; path: string }> {
    const root = await mkdtemp(join(tmpdir(), 'dsh-web-replay-owner-'))
    roots.push(root)
    const corpus = join(root, 'snapshots')
    const directory = join(corpus, profile, 'example')
    await mkdir(directory, { recursive: true })
    const path = join(directory, 'session.v4.jsonl')
    await writeFile(path, `${JSON.stringify({ type: 'session', version: 4, id: '{{session:1}}' })}\n`)
    return { root, corpus, directory, path }
  }

  function manifest(profile = 'web'): string {
    return `version: 1\nscenario: example\nprofile: ${profile}\ncomposition: example\nrecording: authored\nheader:\n  class: example\n`
  }

  it('allows app-owned input-only replay files outside the corpus', async () => {
    const { root, corpus } = await fixture()
    for (const local of ['app-replay', 'snapshots-sibling']) {
      const directory = join(root, local)
      await mkdir(directory)
      const path = join(directory, 'session.v4.jsonl')
      await writeFile(path, '{"type":"session","version":4}\n')
      await expect(assertCorpusReplayFixtureOwner(path, corpus)).resolves.toBeUndefined()
    }
    await expect(assertCorpusReplayFixtureOwner(join(corpus, 'notes.json'), corpus)).resolves.toBeUndefined()
  })

  it.each(['session.v4.jsonl', 'session.1.v4.jsonl'])('requires a corpus owner for %s', async (name) => {
    const { corpus, directory } = await fixture()
    const path = join(directory, name)
    if (name !== 'session.v4.jsonl') await writeFile(path, '{"type":"session","version":4}\n')
    await expect(assertCorpusReplayFixtureOwner(path, corpus))
      .rejects.toThrow('corpus replay fixtures require an owner manifest')
  })

  it.each([
    ['web', 'web'], ['session', 'headless'], ['sdk', 'sdk'], ['sdk', 'sdk-minimal'], ['acp', 'acp'],
  ])('accepts a real %s corpus owner with profile %s for other test consumers', async (directoryProfile, profile) => {
    const { corpus, directory, path } = await fixture(directoryProfile)
    await writeFile(join(directory, 'snapshot.yml'), manifest(profile))
    await expect(assertCorpusReplayFixtureOwner(path, corpus)).resolves.toBeUndefined()
  })

  it.each([
    ['scenario: example\n', 'scenario: different\n'],
    ['composition: example\n', ''],
    ['recording: authored\n', ''],
    ['header:\n  class: example\n', ''],
  ])('requires complete matching owner metadata: %s', async (from, to) => {
    const { corpus, directory, path } = await fixture()
    await writeFile(join(directory, 'snapshot.yml'), manifest().replace(from, to))
    await expect(assertCorpusReplayFixtureOwner(path, corpus))
      .rejects.toThrow('matching scenario, composition, recording, and header metadata')
  })

  it('rejects a mismatched profile, malformed manifest, or borrowing scenario', async () => {
    const { corpus, directory, path } = await fixture()
    const manifestPath = join(directory, 'snapshot.yml')
    await writeFile(manifestPath, manifest('headless'))
    await expect(assertCorpusReplayFixtureOwner(path, corpus)).rejects.toThrow('profile must match')
    await writeFile(manifestPath, `${manifest()}unexpected: true\n`)
    await expect(assertCorpusReplayFixtureOwner(path, corpus)).rejects.toThrow('unknown field')
    await writeFile(manifestPath, `${manifest()}session:\n  source: ../owner/session.v4.jsonl\n`)
    await expect(assertCorpusReplayFixtureOwner(path, corpus)).rejects.toThrow('a borrowing scenario cannot own')
  })
})

describe('Web snapshot generation filenames', () => {
  it('selects the highest parent and child generations without counting retained inputs twice', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-web-fixture-generations-'))
    roots.push(root)
    for (const [name, version] of [
      ['session.jsonl', 0],
      ['session.v2.jsonl', 2],
      ['session.1.jsonl', 0],
      ['session.1.v1.jsonl', 1],
    ] as const) {
      await writeFile(join(root, name), `${JSON.stringify({
        type: 'session', version, id: '{{session:1}}', createdAt: 0, delegationDepth: 0,
      })}\n`)
    }

    await expect(selectedSessionFixture(join(root, 'session.jsonl')))
      .resolves.toBe(join(root, 'session.v2.jsonl'))
    await expect(selectedSessionFixture(join(root, 'session.1.jsonl')))
      .resolves.toBe(join(root, 'session.1.v1.jsonl'))
    await expect(selectedSessionFixture(join(root, 'replay.override.json')))
      .resolves.toBe(join(root, 'replay.override.json'))
  })

  it('leaves an absent override-only parent fixture unresolved', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-web-fixture-generations-'))
    roots.push(root)

    await expect(selectedSessionFixture(join(root, 'session.jsonl'), true))
      .resolves.toBe(join(root, 'session.jsonl'))
    await expect(selectedSessionFixture(join(root, 'session.jsonl')))
      .rejects.toThrow('missing parent session fixture')
  })

  it('records beside an older generation and preserves the parent or child role', () => {
    const fixtures = join('/', 'fixtures')
    expect(recordedSessionFixturePath(join(fixtures, 'session.jsonl'), 1))
      .toBe(join(fixtures, 'session.v1.jsonl'))
    expect(recordedSessionFixturePath(join(fixtures, 'session.2.jsonl'), 3))
      .toBe(join(fixtures, 'session.2.v3.jsonl'))
    expect(recordedSessionFixturePath(join(fixtures, 'session.v1.jsonl'), 1))
      .toBe(join(fixtures, 'session.v1.jsonl'))
    expect(() => recordedSessionFixturePath(join(fixtures, 'notes.jsonl'), 1))
      .toThrow('invalid Session fixture path')
  })

  it('treats retained generations as one exact inventory role', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-web-fixture-inventory-'))
    roots.push(root)
    await writeFile(join(root, 'session.jsonl'), `${JSON.stringify({
      type: 'session', version: 0, id: '{{session:1}}', createdAt: 0, delegationDepth: 0,
    })}\n`)
    await writeFile(join(root, 'session.v1.jsonl'), `${JSON.stringify({
      type: 'session', version: 1, id: '{{session:1}}', createdAt: 0, delegationDepth: 0,
    })}\n`)
    await writeFile(join(root, 'ui.expected.md'), 'stable\n')

    await expect(assertFixtureInventory(root, ['session.jsonl', 'ui.expected.md']))
      .resolves.toBeUndefined()
  })
})
