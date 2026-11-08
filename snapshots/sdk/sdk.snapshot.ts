/**
 * Keyless snapshot coverage for the TypeScript SDK path: each scenario spawns
 * the real `dsh --profile sdk` or `sdk-minimal` runtime through
 * `@deepseek-ai/dsh-sdk-client`, drives recorded turns and standalone commands over stdio JSON-RPC,
 * and pins the SDK `RunResult`, the complete notification stream, and the
 * persisted session logs. Replay serves recorded model
 * responses via `llm-replay` (`cordis.snapshot.yml`); `DSH_SNAPSHOT=record`
 * re-records against the live API; `DSH_SNAPSHOT=refresh` replays committed
 * fixtures and rewrites expected outputs.
 */

import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, onTestFinished } from 'vitest'
import { execa } from 'execa'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { resolveExampleLaunch } from '@deepseek-ai/dsh-loader-smoke'
import {
  assertPersistedSessionVersion,
  assertSessionFixtureVersion,
  captureExpectedWorkspaceSnapshot,
  captureWorkspaceSnapshot,
  normalizeSessionFormatMetadata,
  normalizeSessionLog,
  normalizeSessionSnapshots,
  normalizeStdout,
  normalizedHeaders,
  normalizedSystemPrompts,
  normalizedToolSchemas,
  parseSnapshotManifest,
  parseToolSchemasSnapshot,
  redactSessionSnapshotIds,
  refreshFixtureReplacements,
  reconcileCatalogCreationTimes,
  REPLAY_CREDENTIAL_ENV,
  restorePinnedToolSchemas,
  resolveToolSchemasSnapshotPath,
  resolveSystemPromptSnapshotPath,
  scrubModelRequestBulk,
  scrubSessionSnapshot,
  scrubSystemPrompts,
  sessionFixtureName,
  systemPromptPrecedesRequests,
  sessionFixtureNames,
  sessionHeaderVersion,
  writerSnapshotName,
  stabilizeFixtureMessageIds,
  stabilizeRefreshLog,
  tokenizeSessionFixtureCwd,
  writesCurrentSessionFixtures,
  materializeProfilePatch,
  materializeSessionFixtureCwd,
  formatSystemPromptSnapshot,
  formatToolSchemasSnapshot,
  latestPersistedSessionPaths,
  type HarvestedLog,
  type NormalizeContext,
  type SnapshotManifest,
  type WorkspaceSnapshotEntry,
} from '@deepseek-ai/dsh-session-snapshot'
import {
  DeepSeekHarness,
  type HarnessNotification,
  type NotificationSubscription,
  type RunResult,
  type SdkPromptContentBlock,
  type SdkUserQuestionRequest,
  type SdkUserQuestionResult,
} from '@deepseek-ai/dsh-sdk-client'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { deriveReplayScript, parseSessionLog } from '@deepseek-ai/dsh-llm-replay'
import { resolvePwshPath } from '@deepseek-ai/dsh-pwsh-local'

const corpusRoot = fileURLToPath(new URL('../', import.meta.url))
const replayNetworkGuard = new URL('../../packages/test-support/session-snapshot/tests/fixtures/replay-network-guard.mjs', import.meta.url).href

const MINIMAL_SYSTEM_PROMPT = 'You are the environment-selected minimal software engineer.'
const MINIMAL_BASH_DESCRIPTION = `Run commands in a bash shell
* When invoking this tool, the contents of the "command" parameter does NOT need to be XML-escaped.
* You don't have access to the internet via this tool.
* You do have access to a mirror of common linux and python packages via apt and pip.
* State is persistent across command calls and discussions with the user.
* To inspect a particular line range of a file, e.g. lines 10-25, try 'sed -n 10,25p /path/to/the/file'.
* Please avoid commands that may produce a very large amount of output.
* Please run long lived commands in the background, e.g. 'sleep 10 &' or start a server in the background.`

const mode = process.env.DSH_SNAPSHOT ?? 'replay'
const recording = mode === 'record'
const refreshing = mode === 'refresh'
const sessionWriteMode = recording ? 'record' : refreshing ? 'refresh' : 'replay'
const RUNTIME_WORKSPACE_ENTRIES = [
  '.agents',
  '.child-dsh',
  '.dsh',
  '.replay-fixtures',
  '.snapshot-patches',
] as const
const dshSdkDiagnosticChildPatch = fileURLToPath(new URL(
  './subagent-dsh-sdk-diagnostic/child.cordis.yml',
  import.meta.url,
))
const dshSdkChildConfig = fileURLToPath(new URL(
  '../../packages/subagent/subagent-dsh-sdk/tests/fixtures/loader/child.patch.yml',
  import.meta.url,
))

function dirOf(url: string): string {
  return fileURLToPath(new URL('.', url))
}

interface SdkAssertions {
  /** Client decisions for the internal approval protocol recording. */
  approvalOutcomes?: readonly ('allowed-once' | 'rejected')[]
  /** Additional profile patches applied after the shared composition. */
  patches?: readonly string[]
  /** Captured model-request JSONL filename under this scenario's private DSH home. */
  modelRequestsFile?: string
  /** Replay caller-owned commands between turns; profile fixtures own any in-turn commands. */
  replayStandaloneCommands?: boolean
  /** Submit all manifest images with each standalone command, including rejected invocations. */
  commandAttachments?: boolean
  /** Native plan-review choices in the order the fixture requests them. */
  planReviews?: readonly ('keep' | 'approve' | 'dismiss')[]
  /** Wait for the recorded provider title before sending each subsequent prompt. */
  waitForProviderTitle?: boolean
  /** Final response required from a completed turn before updating goldens. */
  expectedFinalResponse?: string
  /** Environment overrides passed to the runtime subprocess. */
  environment?: Readonly<Record<string, string>>
  /** A separate DSH SDK child whose persisted session joins the evidence. */
  dshSdkChild?: {
    /** Profile patch materialized for the child runtime. */
    config: string
    /** Exact request configuration committed by the child runtime. */
    agentConfig: Readonly<Record<string, unknown>>
  }
  /** Assembled model-facing tool names and required argument keys. */
  expectedTools?: Readonly<Record<string, readonly string[]>>
  /** Exact assembled system prompt for the root request. */
  expectedSystem?: string
  /** Exact model-facing descriptions for selected tools. */
  expectedToolDescriptions?: Readonly<Record<string, string>>
  /** Expected runtime-context state in the real assembled request. */
  runtimeContext?: false | { includes: readonly string[]; excludes: readonly string[] }
}

const SDK_ASSERTIONS: Readonly<Record<string, SdkAssertions>> = {
  'approval': {
    approvalOutcomes: ['allowed-once', 'rejected'],
    environment: { DSH_PERMISSION_MODE: 'workspace-write' },
    patches: [fileURLToPath(new URL('./approval/runtime.cordis.yml', import.meta.url))],
  },

  'desktop-context': {
    expectedFinalResponse: 'SDK snapshot OK',
    runtimeContext: {
      includes: ['Current working directory:'],
      excludes: ['Current DeepSeek Harness implementation checkout:', 'Current DeepSeek Harness Web GUI URL:'],
    },
  },
  'desktop-ptc-context': { expectedFinalResponse: 'SDK snapshot OK' },
  'manual-compact': {
    expectedFinalResponse: 'SDK_COMPACT_OK',
    patches: [fileURLToPath(new URL('./manual-compact/capture.cordis.yml', import.meta.url))],
    modelRequestsFile: 'compact-requests.jsonl',
    replayStandaloneCommands: true,
  },
  'permission-switch': {
    expectedFinalResponse: 'SDK_PERMISSION_OK',
    environment: { DSH_PERMISSION_MODE: 'danger-full-access' },
    patches: [fileURLToPath(new URL('./permission-switch/capture.cordis.yml', import.meta.url))],
    modelRequestsFile: 'permission-requests.jsonl',
    replayStandaloneCommands: true,
  },
  'command-identity': {
    expectedFinalResponse: 'SDK_PERMISSION_OK',
    environment: { DSH_PERMISSION_MODE: 'danger-full-access' },
    patches: [fileURLToPath(new URL('./command-identity/runtime.cordis.yml', import.meta.url))],
    modelRequestsFile: 'command-identity-requests.jsonl',
    replayStandaloneCommands: true,
  },
  'plan-review': {
    expectedFinalResponse: 'SDK_PLAN_OK',
    environment: { DSH_PERMISSION_MODE: 'workspace-write' },
    patches: [fileURLToPath(new URL('./plan-review/capture.cordis.yml', import.meta.url))],
    modelRequestsFile: 'plan-requests.jsonl',
    replayStandaloneCommands: true,
    planReviews: ['keep', 'approve', 'dismiss'],
  },
  'goal-rounds': {
    environment: { DSH_PERMISSION_MODE: 'workspace-write' },
    patches: [fileURLToPath(new URL('./goal-rounds/capture.cordis.yml', import.meta.url))],
    modelRequestsFile: 'goal-requests.jsonl',
    replayStandaloneCommands: true,
  },
  'command-attachments': {
    environment: { DSH_PERMISSION_MODE: 'workspace-write' },
    patches: [fileURLToPath(new URL('./command-attachments/capture.cordis.yml', import.meta.url))],
    modelRequestsFile: 'command-attachment-requests.jsonl',
    replayStandaloneCommands: true,
    commandAttachments: true,
  },
  'minimal-image-compaction': {
    expectedFinalResponse: 'MINIMAL_IMAGE_OK',
    expectedTools: { [process.platform === 'win32' ? 'pwsh' : 'bash']: ['command'], read_image: ['file_path'], working_directory: [] },
  },
  'session-title-stability': { waitForProviderTitle: true },
  'dynamic-tool-updates': {
    expectedFinalResponse: 'DONE',
  },
  'tool-scheduler-recovery': {
    patches: [fileURLToPath(new URL('./tool-scheduler-recovery/runtime.cordis.yml', import.meta.url))],
  },
  'tool-error-details': {
    patches: [fileURLToPath(new URL('./tool-error-details/runtime.cordis.yml', import.meta.url))],
    expectedFinalResponse: 'ERROR_DETAILS_OK',
  },
  'ptc-cancel': {
    patches: [fileURLToPath(new URL('./ptc-cancel/runtime.cordis.yml', import.meta.url))],
  },
  'ptc-turn': {
    patches: [fileURLToPath(new URL('./ptc-turn/runtime.cordis.yml', import.meta.url))],
    expectedFinalResponse: 'CODE_ONE+CODE_TWO',
    expectedTools: { run_code: ['code', 'description'] },
  },
  'subagent-spawn-in-process': {
    patches: [fileURLToPath(new URL('./subagent-spawn-in-process/runtime.cordis.yml', import.meta.url))],
  },
  'subagent-fork-in-process': {
    patches: [fileURLToPath(new URL('./subagent-spawn-in-process/runtime.cordis.yml', import.meta.url))],
  },
  'subagent-mixed': {
    patches: [fileURLToPath(new URL('./subagent-spawn-in-process/runtime.cordis.yml', import.meta.url))],
  },
  'subagent-continuable-inheritance': {
    patches: [fileURLToPath(new URL('./subagent-spawn-in-process/runtime.cordis.yml', import.meta.url))],
  },
  'subagent-continuable': {
    environment: { DSH_SNAPSHOT_HUMAN_STEER: '1' },
  },
  'subagent-dsh-sdk-diagnostic': {
    expectedFinalResponse: 'PARENT_OBSERVED_DSH_SDK_DIAGNOSTIC',
    environment: { DSH_TEST_CHILD_PATCH: dshSdkDiagnosticChildPatch },
  },
  'persistent-tools': {
    environment: { DSH_SYSTEM_PROMPT: MINIMAL_SYSTEM_PROMPT },
    expectedTools: { bash: ['command'], str_replace_editor: ['command', 'path'], working_directory: [] },
    expectedSystem: MINIMAL_SYSTEM_PROMPT,
    expectedToolDescriptions: { bash: MINIMAL_BASH_DESCRIPTION },
    runtimeContext: {
      includes: ['Current working directory:', 'Current DSH file policy: danger-full-access', 'Approval prompts are disabled in this session'],
      excludes: ['workspace-write'],
    },
  },
  'persistent-tools-pwsh': {
    environment: { DSH_SYSTEM_PROMPT: MINIMAL_SYSTEM_PROMPT },
    expectedFinalResponse: 'PERSISTENT_PWSH_TOOLS_OK',
    expectedTools: { pwsh: ['command'], str_replace_editor: ['command', 'path'], working_directory: [] },
    expectedSystem: MINIMAL_SYSTEM_PROMPT,
    expectedToolDescriptions: { pwsh: 'Run commands in a persistent PowerShell session.' },
    runtimeContext: {
      includes: ['Current working directory:'],
      excludes: ['Current DSH file policy:', 'Approval prompts'],
    },
  },
  'subagent-dsh-sdk-dynamic-route': {
    environment: { DSH_TEST_PARENT_PROVIDER: 'deepseek-official' },
    dshSdkChild: {
      config: dshSdkChildConfig,
      agentConfig: {
        provider: 'mock',
        model: 'mock-routed',
        reasoningEffort: 'max',
        maxTokens: 777,
      },
    },
  },
}

interface CorpusScenario {
  readonly key: string
  readonly name: string
  readonly dir: string
  readonly manifest: SnapshotManifest & {
    composition: string
    recording: 'live' | 'authored'
    header: NonNullable<SnapshotManifest['header']>
  }
}

async function collectCorpus(): Promise<CorpusScenario[]> {
  const scenarios: CorpusScenario[] = []
  for (const profile of ['session', 'sdk']) {
    const root = join(corpusRoot, profile)
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const dir = join(root, entry.name)
      const manifestPath = join(dir, 'snapshot.yml')
      if (!existsSync(manifestPath)) continue
      const manifest = parseSnapshotManifest(await readFile(manifestPath, 'utf8'), manifestPath)
      if (manifest.composition === undefined || manifest.recording === undefined || manifest.header === undefined) continue
      scenarios.push({
        key: `${profile}/${entry.name}`,
        name: entry.name,
        dir,
        manifest: { ...manifest, composition: manifest.composition, recording: manifest.recording, header: manifest.header },
      })
    }
  }
  return scenarios
}

const corpus = await collectCorpus()
const hasPwsh = spawnSync(
  resolvePwshPath(),
  ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$true'],
  { encoding: 'utf8', timeout: 10_000, windowsHide: true },
).status === 0
const scenarioByKey = new Map(corpus.map(scenario => [scenario.key, scenario]))
const sdkScenarios = corpus
  .filter(scenario => scenario.manifest.profile === 'sdk' || scenario.manifest.profile === 'sdk-minimal')
  .sort((left, right) => left.name.localeCompare(right.name))
const compositionOwners = new Map<string, CorpusScenario>()
const headerPins = new Map<string, CorpusScenario>()
for (const scenario of corpus) {
  const { composition, header } = scenario.manifest
  if (existsSync(join(scenario.dir, 'cordis.yml'))) {
    if (compositionOwners.has(composition)) throw new Error(`snapshot composition ${composition} has multiple patch owners`)
    compositionOwners.set(composition, scenario)
  }
  if (header.pin === true) {
    const key = `${composition}/${header.class}`
    if (headerPins.has(key)) throw new Error(`snapshot header class ${key} has multiple pins`)
    headerPins.set(key, scenario)
  }
}

function compositionOwner(scenario: CorpusScenario): CorpusScenario {
  const owner = compositionOwners.get(scenario.manifest.composition)
  if (owner === undefined) throw new Error(`${scenario.key}: composition has no cordis.yml owner`)
  return owner
}

function headerPin(scenario: CorpusScenario): CorpusScenario {
  const pin = headerPins.get(`${scenario.manifest.composition}/${scenario.manifest.header.class}`)
  if (pin === undefined) throw new Error(`${scenario.key}: composition/header class has no pin`)
  return pin
}

function sourceScenario(owner: CorpusScenario, source: string | undefined): CorpusScenario {
  const key = source === undefined
    ? owner.key
    : source.includes('/') ? source : `${owner.key.split('/')[0]}/${source}`
  const scenario = scenarioByKey.get(key)
  if (scenario === undefined) throw new Error(`${owner.key}: unknown sidecar source ${key}`)
  return scenario
}

interface PersistedLog {
  readonly path: string
  readonly content: string
  readonly header: Record<string, unknown>
}

async function jsonlFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true })
  return latestPersistedSessionPaths(entries).map(entry => join(dir, entry))
}

async function persistedLogs(sessionsRoot: string): Promise<PersistedLog[]> {
  const files = await jsonlFiles(sessionsRoot)
  return Promise.all(files.map(async (path) => {
    const content = await readFile(path, 'utf8')
    expect(assertPersistedSessionVersion(basename(path), content), `${path}: current writer`).toBe(SESSION_FORMAT_VERSION)
    const header = JSON.parse(content.slice(0, content.indexOf('\n'))) as Record<string, unknown>
    return { path, content, header }
  }))
}

interface LoggedRequestHeader {
  type?: string
  data?: { header?: { tools?: LoggedTool[] } }
}

interface LoggedSystemMessage {
  type?: string
  data?: { message?: { content?: Array<{ type?: string; text?: unknown }> } }
}

interface LoggedTool {
  readonly name: string
  readonly description?: unknown
  readonly parameters: { readonly required?: string[] }
}

function assembledTools(log: PersistedLog): LoggedTool[] {
  const event = log.content.trimEnd().split('\n')
    .map(line => JSON.parse(line) as LoggedRequestHeader)
    .find(candidate => candidate.type === 'request/header')
  const tools = event?.data?.header?.tools
  if (tools === undefined) throw new Error('session log has no request/header tools')
  return tools
}

function assembledToolRequirements(log: PersistedLog): Record<string, string[]> {
  return Object.fromEntries(assembledTools(log).map(tool => [tool.name, tool.parameters.required ?? []]))
}

function assembledToolDescriptions(log: PersistedLog): Record<string, string> {
  return Object.fromEntries(assembledTools(log).map((tool) => {
    if (typeof tool.description !== 'string') throw new Error(`tool ${tool.name} has no description`)
    return [tool.name, tool.description]
  }))
}

/** The rendered system prompt of the root request: the text of the first `system/message` (surface node 0). */
function assembledSystem(log: PersistedLog): string {
  const event = log.content.trimEnd().split('\n')
    .map(line => JSON.parse(line) as LoggedSystemMessage)
    .find(candidate => candidate.type === 'system/message')
  const system = event?.data?.message?.content?.[0]?.text
  if (typeof system !== 'string') throw new Error('session log has no system/message text')
  return system
}

function assembledRuntimeContexts(log: PersistedLog): string[] {
  return log.content.trimEnd().split('\n').flatMap((line) => {
    const event = JSON.parse(line) as {
      type?: string
      data?: { source?: { kind?: string; plugin?: string }; content?: Array<{ type?: string; text?: unknown }> }
    }
    if (event.type !== 'user/message'
      || event.data?.source?.kind !== 'runtime-context') return []
    return event.data.content?.flatMap(block => block.type === 'text' && typeof block.text === 'string' ? [block.text] : []) ?? []
  })
}

function contextOf(logs: readonly { content: string; header: Record<string, unknown> }[], cwd: string): NormalizeContext {
  return {
    sessionIds: logs.flatMap(log => typeof log.header.id === 'string' ? [log.header.id] : []),
    cwd,
  }
}

function contextOfContents(contents: readonly string[]): NormalizeContext {
  const headers = contents.map(content => JSON.parse(content.slice(0, content.indexOf('\n'))) as Record<string, unknown>)
  return {
    sessionIds: headers.flatMap(header => typeof header.id === 'string' ? [header.id] : []),
    cwd: typeof headers[0]?.cwd === 'string' ? headers[0].cwd : '\0no-cwd\0',
  }
}

async function fixtureFiles(scenario: CorpusScenario): Promise<string[]> {
  const names = sessionFixtureNames(await readdir(scenario.dir))
  return Promise.all(names.map(async (name) => {
    const path = join(scenario.dir, name)
    assertSessionFixtureVersion(name, await readFile(path, 'utf8'))
    return path
  }))
}

async function hydrateReplayFixtures(scenario: CorpusScenario, cwd: string): Promise<string[]> {
  const root = join(cwd, '.replay-fixtures')
  await mkdir(root, { recursive: true })
  return Promise.all((await fixtureFiles(scenario)).map(async (source) => {
    const destination = join(root, basename(source))
    const materialized = materializeSessionFixtureCwd(await readFile(source, 'utf8'), cwd)
    // Reject malformed replay input during fixture materialization.
    deriveReplayScript(parseSessionLog(materialized))
    await writeFile(destination, materialized)
    return destination
  }))
}

/**
 * Normalize the SDK-visible notification stream: embedded `session.event`
 * envelopes get the session-log treatment (times zeroed, headers tokenized),
 * then every record is scrubbed like a wire frame.
 */
function normalizeNotifications(notifications: readonly HarnessNotification[], ctx: NormalizeContext): string {
  const events = notifications
    .filter(n => n.method === 'session.event')
    .map(n => n.params.event as Record<string, unknown>)
  const typedIdentities = events.some(event => event.type === 'feedback/message-put'
    || event.type === 'job/registered' || event.type === 'job/settled')
  const eventLog = events.map(event => JSON.stringify(event)).join('\n') + '\n'
  const typedLog = typedIdentities
    ? redactSessionSnapshotIds([
        JSON.stringify({ type: 'session', id: ctx.sessionIds[0] }) + '\n' + eventLog,
        ...ctx.sessionIds.slice(1).map(id => JSON.stringify({ type: 'session', id }) + '\n'),
      ])[0]!.split('\n').slice(1).join('\n')
    : eventLog
  const normalizedEvents = events.length === 0
    ? []
    : scrubModelRequestBulk(normalizeSessionLog(
      normalizeSessionFormatMetadata(typedLog),
      ctx,
      typedIdentities ? { identityMode: 'preserve' } : {},
    )).trimEnd().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
  let eventIndex = 0
  const records = notifications.map((notification) => {
    if (notification.method !== 'session.event') return { method: notification.method, params: notification.params }
    const event = normalizedEvents[eventIndex++]
    return { method: notification.method, params: { ...notification.params, event } }
  })
  let output = records.map(record => JSON.stringify(record)).join('\n') + '\n'
  if (typedIdentities) {
    for (const [index, id] of ctx.sessionIds.entries()) output = output.replaceAll(id, '{{session:' + (index + 1) + '}}')
  }
  return normalizeStdout(output, ctx, typedIdentities ? { identityMode: 'preserve' } : {})
}

/** Normalize the owned-run projection. */
function normalizeResult(result: RunResult, ctx: NormalizeContext): string {
  return normalizeStdout(`${JSON.stringify({
    sessionId: result.sessionId,
    finalResponse: result.finalResponse,
  })}\n`, ctx)
}

interface JsonObject {
  [key: string]: unknown
}

interface TurnAction {
  readonly kind: 'turn'
  readonly turn: number
  readonly content?: JsonObject[]
}

interface CommandAction {
  readonly kind: 'command'
  readonly line: string
}

type SdkAction = TurnAction | CommandAction

function records(log: string): JsonObject[] {
  return log.split(/\r?\n/)
    .filter(line => line.trim() !== '')
    .map(line => JSON.parse(line) as JsonObject)
}

function notificationComparisonRecords(log: string, sourceLogs: readonly string[]): JsonObject[] {
  const versions = sourceLogs.map((source, index) => sessionHeaderVersion(source, `notification Session ${index}`))
  expect(new Set(versions).size, 'wire golden Session roles share one native writer generation').toBe(1)
  return records(log).map((record) => {
    if (record.method !== 'session.event') return record
    const params = record.params as JsonObject
    const event = JSON.parse(normalizeSessionFormatMetadata(JSON.stringify(params.event), versions[0])) as unknown
    return { ...record, params: { ...params, event } }
  })
}

function modelFromSession(log: string): { provider: string; model: string } {
  for (const record of records(log)) {
    if (record.type !== 'request/header') continue
    const data = record.data as JsonObject | undefined
    const header = data?.header as JsonObject | undefined
    const config = header?.config as JsonObject | undefined
    if (typeof config?.provider === 'string' && typeof config.model === 'string') {
      return { provider: config.provider, model: config.model }
    }
  }
  throw new Error('SDK snapshot session has no request model')
}

/** Replay caller inputs; profile fixtures recreate their own in-turn command activity. */
function sdkActions(log: string, replayStandaloneCommands: boolean): SdkAction[] {
  const actions: SdkAction[] = []
  const commandInputs = new Set<string>()
  let commandId: string | undefined
  let current: TurnAction | undefined
  for (const record of records(log)) {
    if (record.type === 'command/run') {
      if (!replayStandaloneCommands || current !== undefined) continue
      const data = record.data as JsonObject | undefined
      if ((data?.source as JsonObject | undefined)?.kind !== 'user') continue
      if (typeof data?.name !== 'string' || typeof data.args !== 'string' || typeof data.commandId !== 'string') {
        throw new Error('SDK snapshot command/run requires commandId, name and recorded string arguments')
      }
      commandId = data.commandId
      actions.push({ kind: 'command', line: `/${data.name}${data.args}` })
      continue
    }
    const data = record.data as JsonObject | undefined
    // Standalone callers send no other input until command/done. Inputs admitted
    // within that invocation belong to its handler, even when their source is user.
    if (commandId !== undefined && record.type === 'agent/inbox/spliced' && Array.isArray(data?.inserted)) {
      for (const message of data.inserted as JsonObject[]) {
        if (typeof message.id === 'string') commandInputs.add(message.id)
      }
    }
    if (record.type === 'command/done' && data?.commandId === commandId) commandId = undefined
    if (record.type === 'turn/start') {
      const data = record.data as JsonObject | undefined
      if (typeof data?.turn !== 'number') throw new Error('SDK snapshot turn/start has no turn')
      current = { kind: 'turn', turn: data.turn }
      continue
    }
    if (record.type === 'user/message' && current !== undefined && current.content === undefined) {
      const data = record.data as JsonObject | undefined
      const source = data?.source as JsonObject | undefined
      if (source?.kind === 'user' && Array.isArray(data?.content)
        && (typeof data.id !== 'string' || !commandInputs.has(data.id))) {
        current = { kind: 'turn', turn: current.turn, content: data.content as JsonObject[] }
      }
      continue
    }
    if (record.type === 'turn/end' && current !== undefined) {
      actions.push(current)
      current = undefined
    }
  }
  return actions
}

function postActionEventTypes(log: string): string[] {
  const values = records(log)
  const finalActionEnd = values.findLastIndex(record => record.type === 'turn/end' || record.type === 'command/done')
  return values.slice(finalActionEnd + 1).flatMap(record => typeof record.type === 'string' ? [record.type] : [])
}

function materializeInput(
  content: readonly JsonObject[],
  scenario: CorpusScenario,
  cwd: string,
  liveSessions: readonly (string | undefined)[],
): SdkPromptContentBlock[] {
  const attachments = new Map(scenario.manifest.input?.attachments?.map(attachment => [attachment.id, attachment]))
  const replace = (value: unknown): unknown => {
    if (typeof value === 'string') {
      let output = value.replaceAll('{{cwd}}', cwd)
      output = output.replace(/\{\{session:([1-9]\d*)\}\}/g, (_token, ordinal: string) => {
        const live = liveSessions[Number(ordinal) - 1]
        if (live === undefined) throw new Error(`${scenario.name}: session token ${ordinal} has not bound`)
        return live
      })
      return output
    }
    if (Array.isArray(value)) return value.map(replace)
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replace(item)]))
    }
    return value
  }
  return content.map((block) => {
    if (block.type !== 'image') return replace(block) as SdkPromptContentBlock
    const attachment = block.attachment as JsonObject | undefined
    const id = attachment?.attachmentId
    const input = typeof id === 'string' ? attachments.get(id) : undefined
    if (input === undefined) throw new Error(`${scenario.name}: no input bytes for image attachment ${String(id)}`)
    return { type: 'image', data: input.data, mimeType: input.mediaType } as SdkPromptContentBlock
  })
}

function notificationEvent(notification: HarnessNotification): JsonObject | undefined {
  return notification.method === 'session.event' && notification.params.event !== null
    && typeof notification.params.event === 'object'
    ? notification.params.event as JsonObject
    : undefined
}

async function waitForRootEvent(
  subscription: NotificationSubscription,
  sessionId: string,
  match: (event: JsonObject) => boolean,
  observe: (notification: HarnessNotification) => void,
): Promise<void> {
  while (true) {
    const notification = await subscription.next()
    observe(notification)
    const event = notification.params.sessionId === sessionId ? notificationEvent(notification) : undefined
    if (event !== undefined && match(event)) return
  }
}

/** Command lifecycle notifications precede the RPC result on the same ordered transport. */
function collectCommandNotifications(
  subscription: NotificationSubscription,
  sessionId: string,
  result: RunResult,
  notifications: HarnessNotification[],
  observe: (notification: HarnessNotification) => void,
): void {
  const run = result.events.find(event => event.type === 'command/run')
  if (run === undefined) throw new Error('Command RunResult has no command/run event')
  const commandId = run.data.commandId
  const done = result.events.find(event => event.type === 'command/done' && event.data.commandId === commandId)
  if (done === undefined || done.type !== 'command/done') throw new Error('Command RunResult has no command/done event')
  expect(result.finishReason).not.toBeNull()
  if (done.data.kind === 'error') {
    expect(result.finishReason).toBe('error')
    expect(result.finalResponse).toBe(done.data.text)
  } else {
    const assistant = result.events.findLast(event => event.type === 'assistant/message')
    if (assistant !== undefined) {
      expect(result.finalResponse).toBe(assistant.data.message.content
        .flatMap(block => block.type === 'text' ? [block.text] : []).join(''))
    }
  }
  let started = false
  for (let notification = subscription.tryNext(); notification !== undefined; notification = subscription.tryNext()) {
    observe(notification)
    const event = notification.params.sessionId === sessionId ? notificationEvent(notification) : undefined
    const data = event?.data as JsonObject | undefined
    if (event?.type === 'command/run' && data?.commandId === commandId) started = true
    if (!started) continue
    notifications.push(notification)
    if (event?.type !== 'command/done' || data?.commandId !== commandId) continue
    expect(done.data.kind).toBe(data.kind)
    expect(done.data.text).toBe(data.text)
    expect(done.data.sourceEventSeq).toBe(data.sourceEventSeq)
    return
  }
  throw new Error('SDK command response arrived without its preceding command lifecycle notifications')
}

// These recorded compositions also pin pre-desktop SDK or headless headers.
// New desktop-context cases exercise the shipped SDK defaults without this patch.
const legacySdkCompositions = new Set([
  'default',
  'dynamic-tool-updates',
  'image',
  'ptc',
  'sdk-account-provider-signout',
  'sdk-default',
  'sdk-dsh-sdk-diagnostic',
  'sdk-dsh-sdk-dynamic-route',
  'sdk-minimal',
  'sdk-serial-created',
  'sdk-upload',
  'session-title',
  'session-title-stability',
  'subagent-activation-limit',
  'subagent-continuable-inheritance',
  'subagent-durability-failure',
  'subagent-send-message',
  'system-prompt-in-history',
])
const legacySdkContextPatch = fileURLToPath(new URL('./legacy-context.patch.yml', import.meta.url))

function authoredPatches(scenario: CorpusScenario, replaying: boolean): string[] {
  const owner = compositionOwner(scenario)
  if (scenario.manifest.composition.startsWith('sdk-')) {
    return [join(owner.dir, 'cordis.yml'), ...(replaying ? [join(owner.dir, 'cordis.snapshot.yml')] : [])]
  }
  const base = compositionOwners.get('default')
  if (base === undefined) throw new Error('SDK corpus has no default transport-neutral composition')
  return [
    join(base.dir, 'cordis.yml'),
    ...owner === base && !replaying ? [] : [join(owner.dir, replaying ? 'cordis.snapshot.yml' : 'cordis.yml')],
    join(base.dir, 'model.cordis.yml'),
  ]
}

interface ReplayRoute {
  provider: string
  model: string
}

function replayRouteFacts(rows: readonly JsonObject[], mainRoute: ReplayRoute): JsonObject[] {
  const native = rows.find(row => row.id === 'llm-deepseek')
  if (native?.disabled !== true) throw new Error('keyless title replay requires llm-deepseek disabled before launch')
  const title = rows.find(row => row.id === 'session-title-provider' && row.disabled !== true)
  const titleConfig = title?.config as JsonObject | undefined
  if (typeof titleConfig?.provider !== 'string' || typeof titleConfig.model !== 'string') {
    throw new Error('keyless title replay has no configured auxiliary title route')
  }
  return [{ rowId: 'llm-deepseek', disabled: true }, ...[mainRoute, {
    provider: titleConfig.provider, model: titleConfig.model,
  }].map((route) => {
    const owners = rows.filter((row) => {
      if (row.name !== '@deepseek-ai/dsh-llm-replay' || row.disabled !== undefined && row.disabled !== false) return false
      const config = row.config as JsonObject | undefined
      return Array.isArray(config?.providers) && config.providers.some((provider: JsonObject) => provider.id === route.provider
        && Array.isArray(provider.models) && provider.models.some((model: JsonObject) => model.id === route.model))
    })
    if (owners.length !== 1) throw new Error(`keyless title replay route ${route.provider}/${route.model} requires one active replay owner`)
    return { rowId: owners[0]!.id, provider: route.provider, model: route.model }
  })]
}

async function preflightTitleReplay(
  scenario: CorpusScenario, patches: readonly string[], cwd: string, env: NodeJS.ProcessEnv, route: ReplayRoute,
): Promise<void> {
  const launch = resolveExampleLaunch({
    srcBin: fileURLToPath(new URL('../../apps/cli/src/bin.ts', import.meta.url)),
    mode: 'src',
    sourceImport: 'tsx/esm',
    tsconfigPath: fileURLToPath(new URL('../../tsconfig.json', import.meta.url)),
    configArgs: ['--profile', scenario.manifest.profile, ...patches.flatMap(path => ['--patch', path]), '--dump-config'],
    env,
  })
  const dumped = await execa(launch.command, launch.args, {
    cwd, env: launch.env, reject: false, timeout: 30_000,
  })
  if (dumped.exitCode !== 0 || dumped.timedOut) throw new Error(`${scenario.name}: keyless dump-config preflight failed`)
  const rows: unknown = yaml.load(dumped.stdout, { schema: entryListSchema })
  if (!Array.isArray(rows) || !rows.every(row => row !== null && typeof row === 'object' && !Array.isArray(row))) {
    throw new Error(`${scenario.name}: dump-config preflight did not return entry rows`)
  }
  console.info(JSON.stringify({ scenario: scenario.name, replayRoutes: replayRouteFacts(rows, route) }))
}

async function assertReplayNetworkAudit(path: string, previousPids?: ReadonlySet<number>): Promise<ReadonlySet<number>> {
  const audit = records(await readFile(path, 'utf8'))
  const installed = audit.filter(event => event.kind === 'installed')
  if (installed.length === 0) throw new Error('keyless replay child did not install its network guard')
  const blocked = audit.find(event => event.kind === 'blocked')
  if (blocked !== undefined) {
    const frames = Array.isArray(blocked.frames) ? blocked.frames.filter(frame => typeof frame === 'string').join('\n') : ''
    throw new Error(`keyless replay attempted external ${String(blocked.transport)}: ${String(blocked.destination)}\n${frames}`)
  }
  const pids = new Set(installed.flatMap(event => typeof event.pid === 'number' ? [event.pid] : []))
  if (pids.size === 0 || previousPids !== undefined && ![...pids].some(pid => !previousPids.has(pid))) {
    throw new Error('keyless replay SDK child did not install a new network guard after preflight')
  }
  return pids
}

function assertReplayTurnOutcome(scenario: string, fixture: string, turn: number, result: RunResult): void {
  const end = records(fixture).find(event => event.type === 'turn/end' && (event.data as JsonObject).turn === turn)
  const expected = ((end?.data as JsonObject | undefined)?.reason as JsonObject | undefined)?.kind
  if (result.finishReason === 'error' && expected !== 'error') {
    throw new Error(`${scenario}: keyless replay turn ${String(turn)} failed instead of ${String(expected)}; refusing to await later events`)
  }
}

/** One SDK-controlled recorded scenario against a fresh SDK-profile subprocess. */
async function runScenario(scenario: CorpusScenario): Promise<{
  results: RunResult[]
  notifications: HarnessNotification[]
  observedMethods: ReadonlySet<string>
  logs: PersistedLog[]
  initialWorkspace: WorkspaceSnapshotEntry[]
  finalWorkspace: WorkspaceSnapshotEntry[]
  cwd: string
  modelRequests: JsonObject[]
}> {
  const workspaceParent = await realpath(tmpdir())
  let workspacePrefix = `sdk-snapshot-${scenario.name}-`
  const fixedWidthCwd = scenario.name === 'minimal-image-compaction' || scenario.name === 'manual-compact'
  if (fixedWidthCwd) {
    // mkdtemp appends six characters; JSON quoting is part of the runtime-context text.
    const paddingLength = 192 - JSON.stringify(join(workspaceParent, `${workspacePrefix}XXXXXX`)).length
    if (paddingLength < 0) throw new Error('compaction snapshot temporary root exceeds its fixed cwd text length')
    workspacePrefix += '-'.repeat(paddingLength)
  }
  const cwd = await realpath(await mkdtemp(join(workspaceParent, workspacePrefix)))
  let harness: DeepSeekHarness | undefined
  onTestFinished(async () => {
    if (harness !== undefined) await harness.close()
    await rm(cwd, { recursive: true, force: true })
  })
  if (fixedWidthCwd) expect(JSON.stringify(cwd)).toHaveLength(192)
  const dshHome = join(cwd, '.dsh')
  const sessionsRoot = join(dshHome, 'sessions')
  const replayFixtures = recording ? [] : await hydrateReplayFixtures(scenario, cwd)
  const fixtureContents = await Promise.all((await fixtureFiles(scenario)).map(file => readFile(file, 'utf8')))
  const primaryFixture = fixtureContents[0]
  if (primaryFixture === undefined) throw new Error(`${scenario.name}: no primary session fixture`)
  const route = modelFromSession(primaryFixture)
  const patchRoot = join(cwd, '.snapshot-patches')
  await mkdir(patchRoot, { recursive: true })
  const networkAudit = join(patchRoot, 'network-audit.jsonl')
  const assertions = SDK_ASSERTIONS[scenario.name] ?? {}
  const patches = [
    ...legacySdkCompositions.has(scenario.manifest.composition) ? [legacySdkContextPatch] : [],
    ...authoredPatches(scenario, !recording),
    ...assertions.patches ?? [],
    ...scenario.name === 'session-resume' && !recording ? [join(scenario.dir, 'replay.cordis.yml')] : [],
  ]
    .map((patch, index) => materializeProfilePatch(patch, cwd, scenario.manifest.profile, patchRoot, index))
  let childSessionsRoot: string | undefined
  let childEnvironment: Record<string, string> = {}
  if (assertions.dshSdkChild !== undefined) {
    const childHome = join(cwd, '.child-dsh')
    const legacyChildPatch = materializeProfilePatch(legacySdkContextPatch, cwd, 'sdk', patchRoot, patches.length)
    const childPatch = materializeProfilePatch(assertions.dshSdkChild.config, cwd, 'sdk', patchRoot, patches.length + 1)
    await mkdir(childHome, { recursive: true })
    childSessionsRoot = join(childHome, 'sessions')
    childEnvironment = {
      DSH_TEST_CHILD_PATCHES: JSON.stringify([legacyChildPatch, childPatch]),
      DSH_TEST_CHILD_HOME: childHome,
    }
  }
  const workspaceDir = join(scenario.dir, 'workspace')
  if (existsSync(workspaceDir)) {
    for (const entry of await readdir(workspaceDir)) {
      await cp(join(workspaceDir, entry), join(cwd, entry), { recursive: true, verbatimSymlinks: true })
    }
  }
  const initialWorkspace = await captureWorkspaceSnapshot(cwd, {
    ignoredRootEntries: RUNTIME_WORKSPACE_ENTRIES,
  })
  const [parentFixture, ...childFixtures] = replayFixtures
  const actions = sdkActions(primaryFixture, assertions.replayStandaloneCommands === true)
  const resumeReplayFile = scenario.name === 'session-resume' && !recording
    ? join(patchRoot, 'resume-replay.json') : undefined
  const prepareTurnReplay = async (turn: number): Promise<void> => {
    if (resumeReplayFile === undefined || parentFixture === undefined) return
    const events = parseSessionLog(await readFile(parentFixture, 'utf8'))
      .filter(event => 'turn' in event.data && event.data.turn === turn)
    await writeFile(resumeReplayFile, JSON.stringify(deriveReplayScript(events)))
  }
  const firstTurn = actions.find(action => action.kind === 'turn')
  if (firstTurn !== undefined) await prepareTurnReplay(firstTurn.turn)
  const env: Record<string, string> = {
    ...Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)) as Record<string, string>,
    ...recording ? {} : REPLAY_CREDENTIAL_ENV,
    DSH_SNAPSHOT: mode,
    DSH_SNAPSHOT_PROVIDER: route.provider,
    DSH_SNAPSHOT_MODEL: route.model,
    DSH_TELEMETRY_DISABLED: '1',
    DSH_AGENTS_HOME: join(cwd, '.agents'),
    NODE_OPTIONS: [process.env.NODE_OPTIONS, '--disable-warning=ExperimentalWarning'].filter(Boolean).join(' '),
    ...parentFixture === undefined ? {} : {
      DSH_SNAPSHOT_FILE: parentFixture,
      ...childFixtures.length > 0 ? { DSH_SNAPSHOT_CHILD_FILES: childFixtures.join(delimiter) } : {},
    },
    ...!recording && scenario.manifest.replay?.override === true
      ? { DSH_SNAPSHOT_OVERRIDE: join(scenario.dir, 'replay.override.json') }
      : {},
    ...scenario.manifest.environment,
    ...assertions.environment,
    ...childEnvironment,
    ...resumeReplayFile === undefined ? {} : { DSH_SNAPSHOT_OVERRIDE: resumeReplayFile },
    ...recording ? {} : {
      NODE_OPTIONS: `--disable-warning=ExperimentalWarning --import=${replayNetworkGuard}`,
      DSH_SNAPSHOT_NETWORK_AUDIT_FILE: networkAudit,
    },
  }

  const planReviews = assertions.planReviews === undefined ? undefined : [...assertions.planReviews]
  const onUserQuestion = planReviews === undefined ? undefined
    : async (request: SdkUserQuestionRequest): Promise<SdkUserQuestionResult> => {
      expect(request.questions).toHaveLength(1)
      const question = request.questions[0]
      if (question === undefined) throw new Error('plan review has no question')
      expect(question.intent?.kind).toBe('plan-review')
      expect(question.detail).toMatch(/^# /u)
      const choice = planReviews.shift()
      if (choice === undefined) throw new Error('unexpected extra plan review')
      if (choice === 'dismiss') return { cancelled: true }
      return { answers: [{ id: question.id, selected: [choice === 'approve' ? 'Approve' : 'Keep planning'],
        ...choice === 'keep' ? { custom: 'Add rollback.' } : {} }] }
    }
  const createHarness = (model = route.model): DeepSeekHarness => new DeepSeekHarness({
    profile: scenario.manifest.profile,
    ...(assertions.approvalOutcomes === undefined ? {} : { approvalRequests: true }),
    patches,
    dshHome,
    processCwd: cwd,
    env,
    initializeTimeoutMs: 110_000,
    requestTimeoutMs: 110_000,
    cwd,
    provider: route.provider,
    model,
    ...onUserQuestion === undefined ? {} : { onUserQuestion },
  })
  harness = createHarness()
  try {
    let preflightGuardPids: ReadonlySet<number> | undefined
    if (!recording && scenario.manifest.composition.startsWith('session-title')) {
      await preflightTitleReplay(scenario, patches, cwd, env, route)
      preflightGuardPids = await assertReplayNetworkAudit(networkAudit)
    }
    const notifications: HarnessNotification[] = []
    const observedMethods = new Set<string>()
    const results: RunResult[] = []
    const sessionId = 'fixture-root-session'
    const liveSessions: (string | undefined)[] = [sessionId]
    if (assertions.approvalOutcomes !== undefined) {
      const outcomes = [...assertions.approvalOutcomes]
      harness.client.start()
      harness.client.onRequest(async (method, params) => {
        expect(method).toBe('approval/request')
        expect(params).toMatchObject({ sessionId, toolName: 'fixture-write' })
        const outcome = outcomes.shift()
        if (outcome === undefined) throw new Error('unexpected approval request')
        return { outcome }
      })
    }
    await harness.start()
    if (!recording) await assertReplayNetworkAudit(networkAudit, preflightGuardPids)
    let subscription = harness.client.subscribeSessionTree(sessionId)
    const titleSubscription = assertions.waitForProviderTitle === true
      ? harness.client.subscribeSessionTree(sessionId)
      : undefined
    const expectedTitles = records(primaryFixture).filter(event => event.type === 'session/title'
      && ((event.data as JsonObject).source as JsonObject).kind === 'provider')
    const completionSubscription = scenario.name === 'subagent-continuable'
      ? harness.client.subscribeSessionTree(sessionId)
      : undefined
    const observe = (notification: HarnessNotification): void => {
      observedMethods.add(notification.method)
      if (notification.method !== 'subagent.started') return
      const child = notification.params.childSessionId
      if (typeof child !== 'string' || liveSessions.includes(child)) return
      liveSessions.push(child)
    }
    try {
      let session = harness.session(sessionId)
      for (const action of actions) {
        if (action.kind === 'command') {
          const execution = await session.run(assertions.commandAttachments === true ? [
            ...scenario.manifest.input?.attachments?.map(image => ({
              type: 'image' as const, data: image.data, mimeType: image.mediaType,
            })) ?? [],
            { type: 'text', text: action.line },
          ] : action.line)
          expect(execution.sessionId).toBe(sessionId)
          if (!recording) await assertReplayNetworkAudit(networkAudit)
          if (scenario.name === 'plan-review' && action === actions.find(item => item.kind === 'command')) {
            expect(execution).toMatchObject({ finalResponse: 'SDK_PLAN_APPROVED', finishReason: 'completed' })
            expect(execution.events.filter(event => event.type === 'turn/end'))
              .toMatchObject([{ data: { turn: 2, reason: { kind: 'completed' } } }])
          }
          if (scenario.name === 'goal-rounds') {
            expect(execution).toMatchObject({ finalResponse: 'SDK_GOAL_DONE', finishReason: 'completed' })
            expect(execution.events.filter(event => event.type === 'goal/change').map(event => event.data.operation))
              .toEqual(['create', 'complete'])
            expect(execution.events.filter(event => event.type === 'turn/end')).toMatchObject([
              { data: { turn: 2, reason: { kind: 'completed' } } },
              { data: { turn: 3, reason: { kind: 'completed' } } },
            ])
          }
          collectCommandNotifications(subscription, sessionId, execution, notifications, observe)
          continue
        }
        if (action.content === undefined) {
          await waitForRootEvent(
            subscription,
            sessionId,
            event => event.type === 'turn/end' && (event.data as JsonObject | undefined)?.turn === action.turn,
            (notification) => {
              observe(notification)
              if (assertions.replayStandaloneCommands === true) notifications.push(notification)
            },
          )
          continue
        }
        if (scenario.name === 'session-resume' && results.length > 0) {
          subscription.close()
          await harness.close()
          await prepareTurnReplay(action.turn)
          harness = createHarness('deepseek-v4-pro')
          await harness.start()
          subscription = harness.client.subscribeSessionTree(sessionId)
          await expect(harness.resumeSession('missing-session')).rejects.toThrow()
          session = await harness.resumeSession(sessionId)
          expect(session.id).toBe(sessionId)
        }
        let result: RunResult | undefined
        if (assertions.replayStandaloneCommands === true) {
          const content = action.content[0]
          if (action.content.length !== 1 || content?.type !== 'text' || typeof content.text !== 'string') {
            throw new Error(`${scenario.name} run fixture requires one text block per prompt`)
          }
          const outcome = await session.run(content.text, {
            onNotification(message) {
              notifications.push(message)
              observe(message)
            },
          })
          result = outcome
        } else {
          const outcome = await session.run(materializeInput(action.content, scenario, cwd, liveSessions), {
            onNotification: (notification) => {
              notifications.push(notification)
              observe(notification)
            },
          })
          result = outcome
        }
        results.push(result)
        if (!recording) {
          await assertReplayNetworkAudit(networkAudit)
          assertReplayTurnOutcome(scenario.name, primaryFixture, action.turn, result)
        }
        if (titleSubscription !== undefined) {
          const expected = expectedTitles[results.length - 1]?.data as JsonObject | undefined
          expect(expected, 'each turn has a recorded provider title').toBeDefined()
          await waitForRootEvent(titleSubscription, sessionId, event => event.type === 'session/title'
            && ((event.data as JsonObject).source as JsonObject).kind === 'provider'
            && (event.data as JsonObject).title === expected?.title, observe)
        }
        if (completionSubscription !== undefined) {
          expect(result.finalResponse, 'run returns at the first parent idle').toBe('DONE')
          expect(result.events.filter(event => event.type === 'turn/end'))
            .toMatchObject([{ data: { turn: 1 } }])
          expect(await harness.client.request('session/wait', { sessionId })).toEqual({})
          const delivered: HarnessNotification[] = []
          let notification: HarnessNotification | undefined
          while ((notification = completionSubscription.tryNext()) !== undefined) delivered.push(notification)
          const completionOrder = delivered.flatMap((entry) => {
            if (entry.method === 'subagent.finished') return ['child:finished']
            if (entry.params.sessionId !== sessionId) return []
            if (entry.method === 'session.status' && entry.params.status === 'idle') return ['parent:idle']
            const event = notificationEvent(entry)
            if (event?.type !== 'turn/end') return []
            const data = event.data as JsonObject
            expect(data.reason).toEqual({ kind: 'completed' })
            return [`parent:turn:${String(data.turn)}`]
          })
          expect(completionOrder, 'completion notifications arrive before the session/wait response').toEqual([
            'parent:turn:1', 'parent:idle', 'child:finished', 'parent:turn:2', 'parent:idle',
          ])
          const parentMessages = delivered.flatMap((entry) => {
            const event = entry.params.sessionId === sessionId ? notificationEvent(entry) : undefined
            return event?.type === 'assistant/message' ? [event] : []
          })
          expect(parentMessages.at(-1)).toMatchObject({
            data: { turn: 2, message: { content: [{ type: 'text', text: 'SUBAGENT_SETTLED_NOTED' }] } },
          })
        }
        if (scenario.manifest.environment?.DSH_SNAPSHOT_FEEDBACK === '1') {
          const feedback = result.events.filter(event => event.type.startsWith('feedback/'))
          expect(feedback.map(event => event.type)).toEqual([
            'feedback/record', 'feedback/record', 'feedback/message-put', 'feedback/message-put', 'feedback/message-delete',
          ])
        }
        await waitForRootEvent(
          subscription,
          sessionId,
          event => event.type === 'turn/end' && (event.data as JsonObject | undefined)?.turn === action.turn,
          observe,
        )
      }
      for (const type of postActionEventTypes(primaryFixture)) {
        await waitForRootEvent(subscription, sessionId, event => event.type === type, observe)
      }
    } finally {
      subscription.close()
      completionSubscription?.close()
      titleSubscription?.close()
    }
    await harness.close()
    if (!recording) {
      console.info(JSON.stringify({ scenario: scenario.name,
        guardedNodeProcesses: (await assertReplayNetworkAudit(networkAudit)).size, externalRequests: 0 }))
    }
    const logs = (await Promise.all([
      persistedLogs(sessionsRoot),
      ...(childSessionsRoot === undefined ? [] : [persistedLogs(childSessionsRoot)]),
    ])).flat()
    const finalWorkspace = await captureWorkspaceSnapshot(cwd, {
      ignoredRootEntries: RUNTIME_WORKSPACE_ENTRIES,
    })
    const modelRequests = assertions.modelRequestsFile !== undefined
      ? records(await readFile(join(dshHome, assertions.modelRequestsFile), 'utf8'))
      : []
    if (planReviews !== undefined) expect(planReviews).toEqual([])
    return { results, notifications, observedMethods, logs, initialWorkspace, finalWorkspace, cwd, modelRequests }
  } finally {
    await harness.close()
  }
}

/** Order logs parent-first, children by creation time (fixture layout order). */
function orderLogs(logs: PersistedLog[], expectedCount: number, separateDshSdkChild: boolean): PersistedLog[] {
  if (separateDshSdkChild) {
    expect(logs).toHaveLength(expectedCount)
    return logs
  }
  const parents = logs.filter(log => typeof log.header.parentSession !== 'string')
  const children = logs.filter(log => typeof log.header.parentSession === 'string')
    .sort((left, right) => Number(left.header.createdAt) - Number(right.header.createdAt))
  expect(parents).toHaveLength(1)
  expect(children).toHaveLength(expectedCount - 1)
  return [...parents, ...children]
}

async function writeHeaderSidecars(
  scenario: CorpusScenario,
  ordered: readonly PersistedLog[],
  ctx: NormalizeContext,
): Promise<void> {
  if (scenario.manifest.header.pin === true) {
    const primary = ordered[0]
    if (primary === undefined) throw new Error(`${scenario.name}: no primary header to snapshot`)
    const prompts = normalizedSystemPrompts(primary.content, ctx)
    const schemas = normalizedToolSchemas(primary.content, ctx)
    if (scenario.manifest.header.systemPromptSource === undefined) {
      await writeFile(
        await resolveSystemPromptSnapshotPath(scenario.dir),
        formatSystemPromptSnapshot(prompts[0] as string, prompts.slice(1)),
      )
    }
    if (scenario.manifest.header.toolSchemasSource === undefined) {
      await writeFile(
        await resolveToolSchemasSnapshotPath(scenario.dir),
        formatToolSchemasSnapshot(schemas[0] as unknown[], schemas.slice(1)),
      )
    }
  }
  for (const index of scenario.manifest.header.childSystemPrompts ?? []) {
    const child = ordered[index]
    if (child === undefined) throw new Error(`${scenario.name}: no child ${index} prompt to snapshot`)
    const prompts = normalizedSystemPrompts(child.content, ctx)
    await writeFile(join(scenario.dir, `system-prompt.${index}.expected.md`), formatSystemPromptSnapshot(
      prompts[0] as string,
      prompts.slice(1),
    ))
  }
  for (const index of scenario.manifest.header.childToolSchemas ?? []) {
    const child = ordered[index]
    if (child === undefined) throw new Error(`${scenario.name}: no child ${index} schemas to snapshot`)
    const schemas = normalizedToolSchemas(child.content, ctx)
    await writeFile(join(scenario.dir, `tool-schemas.${index}.expected.json`), formatToolSchemasSnapshot(
      schemas[0] as unknown[],
      schemas.slice(1),
    ))
  }
}

async function verifyHeaders(
  scenario: CorpusScenario,
  ordered: readonly PersistedLog[],
  ctx: NormalizeContext,
  dshSdkChildConfig?: Readonly<Record<string, unknown>>,
): Promise<void> {
  const pin = headerPin(scenario)
  const [pinFixturePath] = await fixtureFiles(pin)
  const pinFixture = await readFile(pinFixturePath as string, 'utf8')
  const firstLine = pinFixture.split('\n').find(line => line.trim() !== '') ?? '{}'
  const pinHeader = JSON.parse(firstLine) as JsonObject
  const pinned = normalizedHeaders(pinFixture, {
    sessionIds: [],
    cwd: typeof pinHeader.cwd === 'string' ? pinHeader.cwd : '\0no-cwd\0',
  })
  const promptOwner = sourceScenario(pin, pin.manifest.header.systemPromptSource)
  const schemaOwner = sourceScenario(pin, pin.manifest.header.toolSchemasSource)
  const prompt = await readFile(await resolveSystemPromptSnapshotPath(promptOwner.dir), 'utf8')
  const schemas = parseToolSchemasSnapshot(await readFile(await resolveToolSchemasSnapshotPath(schemaOwner.dir), 'utf8'))
  const schemaSets = [schemas.initial, ...schemas.changes]
  const reconstructed = pinned.map((header, index) => restorePinnedToolSchemas(
    header,
    schemaSets[index] as unknown[],
  ))

  const childPrompts = new Map<number, string>()
  const childSchemas = new Map<number, unknown[][]>()
  for (const index of scenario.manifest.header.childSystemPrompts ?? []) {
    childPrompts.set(index, await readFile(join(scenario.dir, `system-prompt.${index}.expected.md`), 'utf8'))
  }
  for (const index of scenario.manifest.header.childToolSchemas ?? []) {
    const child = parseToolSchemasSnapshot(await readFile(join(scenario.dir, `tool-schemas.${index}.expected.json`), 'utf8'))
    childSchemas.set(index, [child.initial, ...child.changes])
  }

  for (const [logIndex, log] of ordered.entries()) {
    const headers = normalizedHeaders(log.content, ctx)
    const prompts = normalizedSystemPrompts(log.content, ctx)
    if (headers.length > 0) {
      expect(systemPromptPrecedesRequests(log.content), `${scenario.name}: session ${logIndex} has a system/message before its first request/header`).toBe(true)
      expect(prompts.length, `${scenario.name}: session ${logIndex} system/message count`)
        .toBe(1 + (logIndex === 0 ? pin.manifest.header.promptChanges ?? 0 : 0))
    }
    for (const [index, header] of headers.entries()) {
      const selectedSchemas = childSchemas.get(logIndex)?.[index]
      const base = reconstructed[index] ?? reconstructed[0]
      const configured = logIndex === 1 && dshSdkChildConfig !== undefined
        ? { ...base as JsonObject, config: dshSdkChildConfig }
        : base
      const expected = selectedSchemas === undefined
        ? configured
        : { ...configured as JsonObject, tools: selectedSchemas }
      expect(header, `${scenario.name}: session ${logIndex} header ${index + 1}`).toEqual(expected)
    }
    if (prompts.length > 0) {
      expect(formatSystemPromptSnapshot(prompts[0] as string, prompts.slice(1)), `${scenario.name}: session ${logIndex} system prompts`)
        .toBe(childPrompts.get(logIndex) ?? prompt)
    }
  }
}

/** Preserve cwd encoding before refresh replaces the harvested header's volatile identities. */
function stabilizeSdkFixture(
  fresh: string,
  existing: string,
  replacements: ReturnType<typeof refreshFixtureReplacements>,
  context: NormalizeContext,
): string {
  return scrubSessionSnapshot(stabilizeRefreshLog(
    tokenizeSessionFixtureCwd(fresh), existing, replacements, context,
  ))
}

describe('TypeScript SDK snapshots over the jsonrpc runtime', () => {
  it.each([String.raw`C:\Users\fixture\sdk-snapshot-ABC123`, String.raw`\\server\share\sdk-snapshot-ABC123`])(
    'refreshes new nested JSON input without retaining the generated cwd %s', async cwd => {
      const existing = await readFile(join(corpusRoot, 'sdk/persistent-tools-pwsh/session.v4.jsonl'), 'utf8')
      const input = {
        path: `${cwd}/new.txt`,
        literal: String.raw`C:\external\keep.txt`,
      }
      const appended = { type: 'user/message', surfaceOp: 'append', data: {
        id: 'refresh-new-message', role: 'user', source: { kind: 'user' },
        content: [{ type: 'text', text: JSON.stringify({ input: JSON.stringify(input) }) }],
      } }
      const fresh = materializeSessionFixtureCwd(existing, cwd).trimEnd() + '\n' + JSON.stringify(appended) + '\n'
      const header = records(fresh)[0]!
      const replacements = refreshFixtureReplacements([{ id: String(header.id), createdAt: Number(header.createdAt), content: fresh }], [existing])
      const stable = records(stabilizeSdkFixture(fresh, existing, replacements, contextOfContents([fresh])))
      expect(stable.at(-1)).toEqual({ ...appended, data: { ...appended.data, content: [{
        type: 'text', text: JSON.stringify({ input: JSON.stringify({ ...input, path: '{{cwd}}/new.txt' }) }),
      }] } })
      expect(stable[0]).toMatchObject({ version: SESSION_FORMAT_VERSION, cwd: '{{cwd}}' })
    },
  )
  it('rejects a keyless title composition without exclusive replay routes', () => {
    const main = { provider: 'deepseek-official', model: 'fixture-main' }
    const rows: JsonObject[] = [
      { id: 'llm-deepseek', disabled: true },
      { id: 'session-title-provider', config: { provider: 'title-replay', model: 'fixture-title' } },
      { id: 'main-replay', name: '@deepseek-ai/dsh-llm-replay', config: {
        providers: [{ id: main.provider, models: [{ id: main.model }] }],
      } },
      { id: 'title-replay', name: '@deepseek-ai/dsh-llm-replay', config: {
        providers: [{ id: 'title-replay', models: [{ id: 'fixture-title' }] }],
      } },
    ]
    expect(replayRouteFacts(rows, main).map(fact => fact.rowId)).toEqual(['llm-deepseek', 'main-replay', 'title-replay'])
    expect(() => replayRouteFacts([{ ...rows[0], disabled: false }, ...rows.slice(1)], main))
      .toThrow('requires llm-deepseek disabled')
    expect(() => replayRouteFacts(rows.filter(row => row.id !== 'main-replay'), main)).toThrow('requires one active replay owner')
    expect(() => replayRouteFacts([...rows.slice(0, 3), { ...rows[3], disabled: true }], main))
      .toThrow('requires one active replay owner')
  })

  it('reports an unexpected replay error before waiting for later events while retaining recorded errors', () => {
    const result: RunResult = { sessionId: 'fixture', finalResponse: '', finishReason: 'error', events: [], notifications: [] }
    const fixture = (kind: string): string => JSON.stringify({ type: 'turn/end', data: { turn: 1, reason: { kind } } })
    expect(() => assertReplayTurnOutcome('fixture', fixture('completed'), 1, result)).toThrow('refusing to await later events')
    expect(() => assertReplayTurnOutcome('fixture', fixture('error'), 1, result)).not.toThrow()
  })

  it.each([String.raw`C:\Users\fixture\sdk-replay`, String.raw`\\server\share\sdk-replay`])(
    'validates real title replay input with JSON-safe cwd %s before launching', async (cwd) => {
      const source = await readFile(join(corpusRoot, 'sdk/session-title-after-turn/session.v4.jsonl'), 'utf8')
      expect(() => parseSessionLog(source.replaceAll('{{cwd}}', cwd))).toThrow('session snapshot line 1 contains invalid JSON')
      const materialized = materializeSessionFixtureCwd(source, cwd)
      expect(deriveReplayScript(parseSessionLog(materialized))).toEqual(deriveReplayScript(parseSessionLog(source)))
    },
  )

  it('rejects an input reference to a recorded session that has not bound', () => {
    const scenario = scenarioByKey.get('sdk/session-title-after-turn')!
    expect(() => materializeInput([{ type: 'text', text: '{{session:2}}' }], scenario, '/snapshot', ['parent']))
      .toThrow('session token 2 has not bound')
  })

  it('requires an SDK guard PID beyond the separate preflight process', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sdk-guard-pids-'))
    const path = join(root, 'audit.jsonl')
    try {
      await writeFile(path, '{"kind":"installed","pid":1}\n')
      await expect(assertReplayNetworkAudit(path, new Set([1]))).rejects.toThrow('did not install a new network guard')
      await writeFile(path, '{"kind":"installed","pid":1}\n{"kind":"installed","pid":2}\n')
      expect([...(await assertReplayNetworkAudit(path, new Set([1])))]).toEqual([1, 2])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('restores the retained V3 max-tokens recording after an interrupted next-turn restart', async () => {
    const path = join(corpusRoot, 'sdk/max-tokens-continue/session.v3.jsonl')
    const fixture = await readFile(path, 'utf8')
    const rows = records(fixture)
    const turnEnd = rows.findIndex(row => row.type === 'turn/end')
    expect(rows[turnEnd + 1]).toMatchObject({ type: 'agent/inbox/spliced', data: { target: 'next-turn', inserted: [expect.anything()] } })
    expect(rows[turnEnd + 2]).toMatchObject({ type: 'turn/start', data: { turn: 2 } })
    const interrupted = rows.filter((_, index) => index !== turnEnd)
    const expected = [...interrupted.slice(0, turnEnd + 1),
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'interrupted' } } },
      ...interrupted.slice(turnEnd + 1)]
    const serialize = (values: JsonObject[]) => values.map(row => JSON.stringify(row)).join('\n') + '\n'
    const context = contextOfContents([fixture])
    expect(normalizeSessionSnapshots([serialize(interrupted)], context))
      .toEqual(normalizeSessionSnapshots([serialize(expected)], context))
    expect(await readFile(path, 'utf8')).toBe(fixture)
  })

  for (const scenario of sdkScenarios) {
    const skipped = scenario.manifest.platform === 'posix' && process.platform === 'win32'
      || scenario.manifest.platform === 'pwsh' && !hasPwsh
      || recording && (scenario.manifest.recording === 'authored' || scenario.manifest.sessionFormat !== undefined)
    const scenarioTest = skipped ? it.skip : it
    scenarioTest(`${mode}s ${scenario.name} through dsh --profile ${scenario.manifest.profile}`, async () => {
      const scenarioDir = scenario.dir
      const retained = scenario.manifest.sessionFormat !== undefined
      const notificationsExpectedPath = join(scenarioDir, retained ? 'notifications.current.expected.jsonl' : 'notifications.expected.jsonl')
      const resultExpectedPath = join(scenarioDir, 'result.expected.json')
      const hasWireGoldens = existsSync(notificationsExpectedPath) || existsSync(resultExpectedPath)
      const assertions = SDK_ASSERTIONS[scenario.name] ?? {}
      const writesSessionFixtures = writesCurrentSessionFixtures(scenario.manifest, sessionWriteMode)

      let files = await fixtureFiles(scenario)
      const replayContents = await Promise.all(files.map(file => readFile(file, 'utf8')))
      if (!recording && !refreshing) {
        const writerFiles = (await readdir(scenarioDir)).filter(name => /^writer(?:\.[1-9]\d*)?\.expected\.jsonl$/u.test(name)).sort()
        expect(writerFiles, 'native writer oracle inventory').toEqual(retained
          ? files.map((_, index) => writerSnapshotName(index)).sort() : [])
      }
      const { results, notifications, observedMethods, logs, initialWorkspace, finalWorkspace, cwd, modelRequests } = await runScenario(scenario)
      const ordered = orderLogs(
        logs,
        recording ? logs.length : files.length,
        assertions.dshSdkChild !== undefined,
      )
      reconcileCatalogCreationTimes(ordered.map(log => log.content), 'validate')
      const actualContext = contextOf(ordered, cwd)
      if (scenario.name === 'command-attachments') {
        const parent = ordered[0]
        if (parent === undefined) throw new Error('command attachments have no persisted Session')
        const events = parseSessionLog(parent.content)
        const commands = events.filter(event => event.type === 'command/run')
        expect(commands.map(event => ({ name: event.data.name, args: event.data.args }))).toEqual([
          { name: 'plan', args: ' Reply SDK_COMMAND_IMAGE_OK without tools.' },
          { name: 'plan', args: ' off' },
          { name: 'compact', args: '' },
          { name: 'permission', args: ' read-only' },
          { name: 'goal', args: '' },
          { name: 'goal', args: ' pause' },
          { name: 'goal', args: ' resume' },
          { name: 'goal', args: ' clear' },
        ])
        const completed = events.filter(event => event.type === 'command/done')
        expect(completed.map(event => event.data.commandId)).toEqual(commands.map(event => event.data.commandId))
        expect(completed.map(event => ({ kind: event.data.kind, text: event.data.text }))).toEqual([
          { kind: 'success', text: 'Plan mode on. Use /plan off to leave.' },
          { kind: 'error', text: 'Attachments cannot accompany /plan off.' },
          { kind: 'error', text: '/compact does not accept attachments' },
          { kind: 'error', text: '/permission does not accept attachments' },
          ...Array.from({ length: 4 }, () => ({ kind: 'error',
            text: 'Attachments only accompany a goal objective: /goal <objective> or /goal edit <objective>.' })),
        ])
        expect(events.filter(event => event.type === 'plan/mode').map(event => event.data.active)).toEqual([true])
        expect(events.filter(event => event.type === 'permission/preset').map(event => event.data.preset)).toEqual(['workspace-write'])
        expect(events.filter(event => event.type === 'goal/change')).toEqual([])
        expect(events.filter(event => event.type === 'turn/start')).toHaveLength(1)
        expect(events.filter(event => event.type === 'step/start')).toHaveLength(1)
        expect(modelRequests).toHaveLength(1)
        const userMessages = events.filter(event => event.type === 'user/message' && event.data.source.kind === 'user')
        expect(userMessages).toHaveLength(1)
        const content = userMessages[0]?.data.content
        expect(content).toEqual([
          { type: 'image', attachment: { attachmentId: scenario.manifest.input?.attachments?.[0]?.id,
            mediaType: 'image/png', bytes: 69, width: 1, height: 1 } },
          { type: 'text', text: 'Reply SDK_COMMAND_IMAGE_OK without tools.' },
        ])
        const requestMessages = modelRequests[0]?.messages as JsonObject[]
        expect(requestMessages.map(message => message.content)).toContainEqual(content)
        expect(JSON.stringify(requestMessages)).toContain('You are in plan mode.')
        expect(events.findLast(event => event.type === 'assistant/message'))
          .toMatchObject({ data: { message: { content: [{ type: 'text', text: 'SDK_COMMAND_IMAGE_OK' }] } } })
      }
      if (scenario.name === 'goal-rounds') {
        const parent = ordered[0]
        if (parent === undefined) throw new Error('goal rounds have no persisted Session')
        const events = parseSessionLog(parent.content)
        expect(events.filter(event => event.type === 'goal/change').map(event => event.data.operation))
          .toEqual(['create', 'complete'])
        expect(events.filter(event => event.type === 'user/message' && event.data.source.kind === 'goal')
          .map(event => event.data.source)).toMatchObject([{ round: 1, revision: 1 }, { round: 2, revision: 1 }])
        expect(events.filter(event => event.type === 'turn/start')).toHaveLength(3)
        expect(events.filter(event => event.type === 'step/start')).toHaveLength(5)
        expect(modelRequests).toHaveLength(5)
        expect(JSON.stringify(modelRequests.at(-1)?.messages)).toContain('<goal_complete>')
        expect(events.findLast(event => event.type === 'assistant/message'))
          .toMatchObject({ data: { message: { content: [{ type: 'text', text: 'SDK_GOAL_DONE' }] } } })
        expect(events.filter(event => event.type === 'sandbox/mode').map(event => event.data.mode)).toEqual(['workspace-write'])
        expect(events.filter(event => event.type === 'approval/policy').map(event => event.data.policy)).toEqual(['ask'])
        expect(notifications.flatMap(notification => {
          const event = notificationEvent(notification)
          return event?.type === 'goal/change' ? [event] : []
        })).toEqual(events.filter(event => event.type === 'goal/change'))
      }
      if (scenario.name === 'plan-review') {
        const parent = ordered[0]
        if (parent === undefined) throw new Error('plan review has no persisted Session')
        const events = parseSessionLog(parent.content)
        expect(events.filter(event => event.type === 'plan/mode').map(event => event.data.active))
          .toEqual([true, false, true, false])
        expect(events.filter(event => event.type === 'command/run').map(event => ({ name: event.data.name, args: event.data.args })))
          .toEqual([{ name: 'plan', args: ' Prepare a plan through exit_plan_mode; revise after feedback and acknowledge approval.' },
            { name: 'plan', args: '' }, { name: 'plan', args: ' off' }])
        expect(events.filter(event => event.type === 'permission/preset').map(event => event.data.preset)).toEqual(['workspace-write'])
        expect(events.filter(event => event.type === 'sandbox/mode').map(event => event.data.mode)).toEqual(['workspace-write'])
        expect(events.filter(event => event.type === 'approval/policy').map(event => event.data.policy)).toEqual(['ask'])
        expect(events.filter(event => event.type === 'turn/start')).toHaveLength(4)
        expect(events.filter(event => event.type === 'step/start')).toHaveLength(6)
        expect(modelRequests).toHaveLength(6)
        const active = modelRequests.map((request) => {
          const messages = request.messages as JsonObject[]
          const system = messages.filter(message => message.role === 'system').at(-1)
          return JSON.stringify(system).includes('You are in plan mode.')
        })
        expect(active).toEqual([false, true, true, false, true, false])
        expect(modelRequests.map(request => (request.tools as JsonObject[]).some(tool => tool.name === 'exit_plan_mode')))
          .toEqual([false, true, true, true, true, true])
        const toolResults = events.filter(event => event.type === 'tool/result')
        expect(toolResults).toHaveLength(3)
        expect(JSON.stringify(toolResults[0]?.data)).toContain('Add rollback.')
        expect(JSON.stringify(toolResults[1]?.data)).toContain('Plan approved')
        expect(JSON.stringify(toolResults[2]?.data)).toContain('The user dismissed the plan review')
      }
      if (scenario.name === 'command-identity') {
        const parent = ordered[0]
        if (parent === undefined) throw new Error('Command identity has no persisted Session')
        const events = parseSessionLog(parent.content)
        expect(events.filter(event => event.type === 'command/run').map(event => event.data.name))
          .toEqual(['access', 'access', 'access'])
        expect(events.filter(event => event.type === 'command/done').map(event => event.data.kind))
          .toEqual(['success', 'success', 'error'])
        expect(events.filter(event => event.type === 'permission/preset').map(event => event.data.preset))
          .toEqual(['danger-full-access', 'read-only'])
        const userMessages = events.filter(event => event.type === 'user/message' && event.data.source.kind === 'user')
        expect(userMessages[0]?.data.content).toEqual([{ type: 'text', text: '/permission read-only' }])
        expect(modelRequests).toHaveLength(2)
        const messages = modelRequests[0]?.messages as JsonObject[]
        expect(messages.some(message => message.role === 'user'
          && (message.content as JsonObject[]).some(block => block.type === 'text' && block.text === '/permission read-only')))
          .toBe(true)
      }
      if (scenario.name === 'permission-switch') {
        const parent = ordered[0]
        if (parent === undefined) throw new Error('permission switch has no persisted Session')
        const events = parseSessionLog(parent.content)
        const commands = events.filter(event => event.type === 'command/run')
        expect(commands.map(event => ({ name: event.data.name, args: event.data.args }))).toEqual([
          { name: 'permission', args: ' read-only' },
          { name: 'permission', args: ' read-only' },
          { name: 'permission', args: ' missing-preset' },
        ])
        const completed = events.filter(event => event.type === 'command/done')
        expect(completed.map(event => event.data.kind)).toEqual(['success', 'success', 'error'])
        expect(completed.map(event => event.data.commandId)).toEqual(commands.map(event => event.data.commandId))
        expect(events.filter(event => event.type === 'permission/preset').map(event => event.data.preset))
          .toEqual(['danger-full-access', 'read-only'])
        expect(events.filter(event => event.type === 'sandbox/mode').map(event => event.data.mode))
          .toEqual(['danger-full-access', 'read-only'])
        expect(events.filter(event => event.type === 'approval/policy').map(event => event.data.policy))
          .toEqual(['never', 'ask'])
        expect(events.filter(event => event.type === 'turn/start').map(event => event.data.turn)).toEqual([1, 2])
        expect(events.filter(event => event.type === 'step/start')).toHaveLength(2)
        const notices = events.filter(event => event.type === 'user/message' && event.data.source.kind === 'user-approval')
        expect(notices).toHaveLength(1)
        expect(modelRequests).toHaveLength(2)
        const [initialRequest, continuationRequest] = modelRequests
        if (initialRequest === undefined || continuationRequest === undefined) {
          throw new Error('permission switch requires its initial and continuation request')
        }
        const initialMessages = initialRequest.messages as JsonObject[]
        const continuationMessages = continuationRequest.messages as JsonObject[]
        expect(continuationMessages[0]).toEqual(initialMessages[0])
        for (const field of ['provider', 'model', 'maxTokens', 'reasoningEffort', 'tools']) {
          expect(continuationRequest[field], `permission switch retained ${field}`).toEqual(initialRequest[field])
        }
        const runtimeContexts = continuationMessages.filter(message => (message.source as JsonObject | undefined)?.kind === 'runtime-context')
        const runtimeText = JSON.stringify(runtimeContexts.at(-1))
        expect(runtimeText).toContain('Current DSH file policy: read-only.')
        const texts = continuationMessages.flatMap(message => message.content as JsonObject[])
          .flatMap(block => block.type === 'text' ? [block.text] : [])
        expect(texts).toContain('SDK_PERMISSION_READY')
        expect(continuationMessages.map(message => message.content)).toContainEqual(notices[0]?.data.content)
        expect(texts).not.toContain('/permission read-only')
        expect(texts).not.toContain('preset read-only')
      }
      if (scenario.name === 'manual-compact') {
        const parent = ordered[0]
        if (parent === undefined) throw new Error('manual compact has no persisted Session')
        const events = parseSessionLog(parent.content)
        const commands = events.filter(event => event.type === 'command/run')
        expect(commands).toHaveLength(1)
        const command = commands[0]
        if (command === undefined) throw new Error('manual compact has no command record')
        expect(command.data.name).toBe('compact')
        const summaries = events.filter(event => event.type === 'compaction/summary')
        expect(summaries).toHaveLength(1)
        const summary = summaries[0]
        if (summary === undefined) throw new Error('manual compact has no summary')
        expect(summary.data).toMatchObject({ sourceCommandId: command.data.commandId, llmStreamCall: true })
        const bracket = events.filter(event => event.type === 'compaction/start' || event.type === 'compaction/end')
        expect(bracket.map(event => event.type)).toEqual(['compaction/start', 'compaction/end'])
        for (const event of bracket) expect(event.data).toMatchObject({ turn: null, sourceCommandId: command.data.commandId })
        const done = events.find(event => event.type === 'command/done')
        expect(done?.data).toMatchObject({ commandId: command.data.commandId, kind: 'success', sourceEventSeq: summary.seq })
        const checkpoint = events.find(event => event.type === 'user/message'
          && event.data.source.kind === 'compact-checkpoint')
        expect(checkpoint?.surfaceOp).toEqual({
          op: 'replace', startSeq: summary.data.shadowedRange.start, endSeq: summary.data.shadowedRange.end,
        })
        expect(events.filter(event => event.type === 'turn/start').map(event => event.data.turn)).toEqual([1, 2])
        expect(events.filter(event => event.type === 'step/start')).toHaveLength(2)
        const commandNotifications = notifications.flatMap(notification => {
          const event = notification.params.sessionId === parent.header.id ? notificationEvent(notification) : undefined
          return event?.type === 'command/run' || event?.type === 'command/done' ? [event.type] : []
        })
        expect(commandNotifications).toEqual(['command/run', 'command/done'])

        expect(modelRequests.map(request => request.purpose)).toEqual([undefined, 'compaction', undefined])
        const [initialRequest, summaryRequest, continuationRequest] = modelRequests
        if (initialRequest === undefined || summaryRequest === undefined || continuationRequest === undefined) {
          throw new Error('manual compact requires an initial, auxiliary, and continuation request')
        }
        const initialMessages = initialRequest.messages as JsonObject[]
        const summaryMessages = summaryRequest.messages as JsonObject[]
        const continuationMessages = continuationRequest.messages as JsonObject[]
        expect(summaryRequest.tools).toEqual(initialRequest.tools)
        expect(continuationRequest.tools).toEqual(initialRequest.tools)
        expect(continuationRequest.provider).toBe(initialRequest.provider)
        expect(continuationRequest.model).toBe(initialRequest.model)
        expect(continuationMessages[0]).toEqual(initialMessages[0])
        expect(summaryMessages.slice(0, -1)).toEqual(initialMessages)
        expect(summaryMessages.at(-1)).toMatchObject({ role: 'user', content: [{
          type: 'text', text: expect.stringContaining('You are now acting as a compaction engine'),
        }] })
        const continuationBlocks = continuationMessages.flatMap(message => message.content as JsonObject[])
        expect(continuationBlocks).toEqual(expect.arrayContaining(summary.data.summary))
        const texts = continuationBlocks.flatMap(block => block.type === 'text' ? [block.text] : [])
        expect(texts).not.toContain('/compact')
        expect(texts).not.toContain(done?.data.text)
        expect(texts).toContain('SDK_COMPACT_READY')
      }
      if (scenario.name === 'ptc-cancel') {
        const events = results.flatMap(result => result.events)
        expect(events.find(event => event.type === 'tool/result')).toMatchObject({ data: {
          message: {
            toolCallId: 'ptc-cancel',
            isError: true,
            content: [{ type: 'text', text: 'Error: tool call aborted' }],
          },
          error: { name: 'AbortError', code: 'ABORTED' },
        } })
        expect(events.find(event => event.type === 'turn/end')).toMatchObject({
          data: { reason: { kind: 'aborted', reason: { kind: 'user' } } },
        })
      }
      if (scenario.name === 'persistent-tools-pwsh') {
        const toolResults = results.flatMap(result => result.events).filter(event => event.type === 'tool/result')
        expect(toolResults).toHaveLength(8)
        for (const result of toolResults) expect(result).toMatchObject({ data: { message: { isError: false } } })
        for (const [toolCallId, text] of [
          ['pwsh-state-1', 'COUNT=1 CWD=persistent-state'],
          ['pwsh-state-2', 'COUNT=2 CWD=persistent-state'],
          ['pwsh-delayed-pipeline', 'delayed'],
          ['pwsh-exit', '[shell exited: code 9]'],
          ['pwsh-exit', 'persistent pwsh shell was reset'],
          ['pwsh-reset', 'RESET_WORKSPACE=True COUNT_SET=False'],
        ]) {
          expect(toolResults).toContainEqual(expect.objectContaining({ data: expect.objectContaining({ message: expect.objectContaining({
            toolCallId, content: [{ type: 'text', text: expect.stringContaining(text) }],
          }) }) }))
        }
      }
      if (scenario.name === 'minimal-image-compaction') {
        const events = results.flatMap(result => result.events)
        const failures = events.filter(event => event.type === 'turn/end' && event.data.reason.kind === 'error')
        expect(failures, 'minimal profile completes its checkpointed turn').toEqual([])
        const image = events.find(event => event.type === 'tool/result')
        expect(image).toMatchObject({ data: { message: {
          toolCallId: 'minimal-image-read',
          isError: false,
          content: expect.arrayContaining([expect.objectContaining({ type: 'image', attachment: {
            attachmentId: expect.stringMatching(/^sha256:/u),
            mediaType: 'image/png', bytes: 69, width: 1, height: 1, name: 'red.png',
          } })]),
        } } })
        const summaries = events.filter(event => event.type === 'compaction/summary')
        expect(summaries).toHaveLength(1)
        expect(summaries[0]).toMatchObject({ data: {
          llmStreamCall: true,
          rawOutput: [{ type: 'text', text: 'Read red.png and report MINIMAL_IMAGE_OK.' }],
        } })
        expect(summaries[0]?.data).not.toHaveProperty('sourceCommandId')
        expect(events.filter(event => event.type === 'compaction/end')).toHaveLength(1)
        expect(events.filter(event => event.type === 'compaction/error')).toHaveLength(0)
        const offloads = events.filter(event => event.type === 'image/offload')
        expect(offloads).toHaveLength(1)
        const imageSeq = events.find(event => event.type === 'tool/result')?.seq
        expect(offloads[0]).toMatchObject({ data: { targets: [{ seq: imageSeq, imageIndexes: [0] }] } })
        const subscribed = notifications.flatMap(notification => {
          const event = notificationEvent(notification)
          return event?.type === 'compaction/summary' ? [event] : []
        })
        expect(subscribed).toEqual(summaries)
        expect(events.findLastIndex(event => event.type === 'assistant/message'))
          .toBeGreaterThan(events.findIndex(event => event.type === 'compaction/summary'))
      }
      expect(logs.some(log => log.content.includes('llm-replay: script exhausted')), `${scenario.name}: replay script covers every model request`).toBe(false)
      if (scenario.name === 'subagent-dsh-sdk-diagnostic' || scenario.name === 'subagent-dsh-sdk-dynamic-route') {
        const parentEvents = records(ordered[0]!.content)
        const notices = parentEvents.filter(event => event.type === 'user/message'
          && (event.data as JsonObject | undefined)?.source !== undefined
          && ((event.data as JsonObject).source as JsonObject).kind === 'subagent-settled')
        const expectedCount = scenario.name === 'subagent-dsh-sdk-diagnostic' ? 2 : 1
        expect(notices).toHaveLength(expectedCount)
        const catalog = parentEvents.filter(event => event.type === 'subagent/catalog')
        expect(catalog).toHaveLength(expectedCount)
        expect(catalog.every(event => (event.data as JsonObject).mode === 'external')).toBe(true)
        const expectedContent = scenario.name === 'subagent-dsh-sdk-diagnostic'
          ? 'partial child loader answer'
          : 'child route: mock/mock-routed/max/777; cwd:'
        for (const notice of notices) expect(JSON.stringify(notice)).toContain(expectedContent)
        const finalAssistant = parentEvents.findLastIndex(event => event.type === 'assistant/message')
        for (const notice of notices) expect(parentEvents.indexOf(notice)).toBeLessThan(finalAssistant)
        expect(parentEvents.filter(event => event.type === 'turn/end')).toEqual([
          expect.objectContaining({ data: { turn: 1, reason: { kind: 'completed' } } }),
        ])
      }
      if (scenario.name === 'dynamic-tool-updates') {
        const selectedTypes = new Set(['request/header', 'request/context', 'developer/message', 'tool/call', 'tool/result'])
        const events = results.flatMap(result => result.events).filter(event => selectedTypes.has(event.type))
        const subscribed = notifications.flatMap(notification => {
          const event = notificationEvent(notification)
          return event !== undefined && typeof event.type === 'string' && selectedTypes.has(event.type) ? [event] : []
        })
        expect(subscribed, 'SDK notifications retain the dynamic-tool events').toEqual(events)
        expect(records(ordered[0]!.content).filter(event => typeof event.type === 'string' && selectedTypes.has(event.type)),
          'SDK events agree with the durable log').toEqual(events)
        const headers = events.filter(event => event.type === 'request/header')
        expect(headers).toHaveLength(3)
        const toolNames = headers.map(event => (event.data as { header: { tools: LoggedTool[] } }).header.tools.map(tool => tool.name))
        expect(toolNames.map(names => names.includes('snapshot_ping'))).toEqual([false, true, false])
        expect(toolNames[1]!.filter(name => !toolNames[0]!.includes(name))).toEqual(['snapshot_ping'])
        expect(toolNames[2]).toEqual(toolNames[0])
        const updates = events.filter(event => event.type === 'developer/message')
        expect(updates).toMatchObject([
          { data: { headerSeq: headers[1]!.seq, message: {
            role: 'developer', source: { kind: 'tool-registry' },
            content: [{ type: 'tool-addition', toolName: 'snapshot_ping' }],
          } }, surfaceOp: 'append' },
          { data: { message: {
            role: 'developer', source: { kind: 'tool-registry' },
            content: [{ type: 'tool-removal', toolName: 'snapshot_ping' }],
          } }, surfaceOp: 'append' },
        ])
        expect(updates[1]!.data).not.toHaveProperty('headerSeq')
        expect(events.filter(event => event.type === 'tool/call').map(event => event.data['name']))
          .toEqual(['read', 'snapshot_ping'])
        expect(events.filter(event => event.type === 'tool/result').at(-1)).toMatchObject({ data: { message: {
          toolCallId: 'call_dynamic_ping', isError: false, content: [{ type: 'text', text: 'pong' }],
        } } })
      }
      if (scenario.name === 'tool-scheduler-recovery') {
        expect(results).toHaveLength(2)
        const events = results.flatMap(result => result.events)
        expect(results[1]?.finalResponse, JSON.stringify(events.filter(event => event.type === 'turn/end')))
          .toBe('SCHEDULER_RECOVERY_OK')
        expect(events.filter(event => event.type === 'turn/end').map(event => event.data['reason']))
          .toEqual([
            { kind: 'error', error: { message: 'Snapshot scheduler preparation failed', code: 'UNKNOWN' } },
            { kind: 'completed' },
          ])
        expect(events.filter(event => event.type === 'tool/call').map(event => event.data['callId']))
          .toEqual(['scheduler-complete', 'scheduler-fail'])
        const toolResults = events.filter(event => event.type === 'tool/result')
          .map(event => event.data['message'] as { role: string; toolCallId: string; isError: boolean })
        expect(toolResults.map(result => [result.role, result.toolCallId, result.isError])).toEqual([
          ['tool', 'scheduler-complete', false], ['tool', 'scheduler-fail', true], ['tool', 'scheduler-unstarted', true],
        ])
        expect(events.filter(event => event.type === 'todo/write')).toHaveLength(1)
      }
      if (scenario.name === 'subagent-activation-limit') {
        expect(ordered).toHaveLength(2)
        const denied = records(ordered[0]!.content).find(record => record.type === 'tool/result'
          && JSON.stringify(record).includes('call_over_capacity'))
        expect(denied).toMatchObject({ data: {
          message: { content: [{ type: 'text', text: expect.stringContaining('subagent limit reached (active child limit: 1)') }], isError: true },
        } })
      }
      if (scenario.name === 'tool-error-details') {
        const events = results.flatMap(result => result.events)
        const headers = events.filter(event => event.type === 'request/header')
          .map(event => (event.data.header as { tools: { name: string }[] }).tools.map(tool => tool.name))
        expect(headers, JSON.stringify(events.filter(event => event.type === 'turn/end' || event.type === 'tool/result'))).toHaveLength(2)
        expect(headers[0]).toContain('bash')
        expect(headers[0]).not.toContain('run_code')
        expect(headers[1]).toEqual(['run_code'])
        const errors = events.filter(event => event.type === 'tool/result' || event.type === 'tool/ptc-dispatch')
          .map(event => event.data['error']).filter(error => error !== undefined)
        expect(errors).toEqual(Array.from({ length: 2 }, () => ({
          name: 'AutoReviewDeniedError', code: 'AUTO_REVIEW_DENIED', reason: '  transport raw\r\nreason  ',
        })))
        const ptc = events.filter(event => event.type.startsWith('tool/ptc-dispatch'))
        expect(ptc.map(event => event.type)).toEqual(['tool/ptc-dispatch-start', 'tool/ptc-dispatch'])
        for (const event of ptc) {
          expect(event.data).not.toHaveProperty('description')
          expect(event.data).not.toHaveProperty('parameters')
          expect(event.data).not.toHaveProperty('schema')
        }
      }
      if (assertions.expectedFinalResponse !== undefined) {
        const failures = results.flatMap(result => result.events).filter(event => event.type === 'turn/end' || event.type === 'tool/result')
        expect(results.at(-1)?.finalResponse, `${scenario.name}: final response; outcomes: ${JSON.stringify(failures)}`).toBe(assertions.expectedFinalResponse)
        const parent = ordered[0]
        if (parent === undefined) throw new Error(`${scenario.name}: no primary session log`)
        const turnEnds = records(parent.content).filter(record => record.type === 'turn/end')
        const expectedTurns = records(replayContents[0]!).filter(record => record.type === 'turn/end')
        expect(turnEnds, `${scenario.name}: completed turns`).toHaveLength(expectedTurns.length)
        for (const turnEnd of turnEnds) expect(turnEnd).toMatchObject({ data: { reason: { kind: 'completed' } } })
      }

      let expectedContents = retained && !refreshing
        ? await Promise.all(files.map((_, index) => readFile(join(scenarioDir, writerSnapshotName(index)), 'utf8')))
        : replayContents

      if (recording) {
        expectedContents = redactSessionSnapshotIds(stabilizeFixtureMessageIds(
          ordered.map(log => scrubSessionSnapshot(tokenizeSessionFixtureCwd(log.content))),
          expectedContents,
        ))
      }

      if (refreshing && (writesSessionFixtures || retained)) {
        const harvested = ordered.map((log): HarvestedLog => ({
          id: String(log.header.id),
          createdAt: Number(log.header.createdAt),
          ...typeof log.header.parentSession === 'string' ? { parentSession: log.header.parentSession } : {},
          content: log.content,
        }))
        const replacements = refreshFixtureReplacements(harvested, expectedContents)
        const refreshed = ordered.map((log, index) => {
          const existing = expectedContents[index]
          if (existing === undefined) throw new Error(`no fixture for persisted log ${index}`)
          return stabilizeSdkFixture(log.content, existing, replacements, actualContext)
        })
        expectedContents = redactSessionSnapshotIds(stabilizeFixtureMessageIds(reconcileCatalogCreationTimes(refreshed, 'preserve-headers'), expectedContents))
      }

      if (writesSessionFixtures || refreshing && retained) {
        const outputFiles = ordered.map((log, index) => join(scenarioDir, retained
          ? writerSnapshotName(index)
          : sessionFixtureName(index, sessionHeaderVersion(log.content, `harvested Session ${index}`))))
        await Promise.all(expectedContents.map((stable, index) => writeFile(outputFiles[index] as string, stable)))
        files = outputFiles
        await writeHeaderSidecars(scenario, ordered, actualContext)
      }

      for (const [index, expected] of expectedContents.entries()) {
        expect(scrubModelRequestBulk(expected), `${scenario.name} session fixture ${index} carries prompt text or tool-schema bulk`)
          .toBe(expected)
      }
      expect(redactSessionSnapshotIds(expectedContents), `${scenario.name}: identity redaction fixed point`)
        .toEqual(expectedContents)

      if (retained) {
        expect(await Promise.all((await fixtureFiles(scenario)).map(file => readFile(file, 'utf8'))),
          'historical replay input remains unchanged').toEqual(replayContents)
        for (const [index, content] of expectedContents.entries()) {
          expect(sessionHeaderVersion(content, writerSnapshotName(index))).toBeLessThanOrEqual(SESSION_FORMAT_VERSION)
        }
      }

      // Persisted transcripts match the committed fixtures.
      const expectedContext = contextOfContents(expectedContents)
      const actualSnapshots = normalizeSessionSnapshots(ordered.map(log => log.content), actualContext, { nativeWriterOutput: true })
      const expectedSnapshots = normalizeSessionSnapshots(expectedContents, expectedContext, { nativeWriterOutput: true })
      expect(actualSnapshots.map(records), `${scenario.name}: sessions`).toEqual(expectedSnapshots.map(records))
      await verifyHeaders(scenario, ordered, actualContext, assertions.dshSdkChild?.agentConfig)

      // Genuine SDK protocol cases retain their secondary wire projections.
      const finalResult = results.at(-1)
      if (hasWireGoldens) {
        if (finalResult === undefined) throw new Error(`${scenario.name}: SDK wire golden has no run result`)
        const normalizedNotifications = normalizeNotifications(notifications, actualContext)
        const normalizedResult = normalizeResult(finalResult, actualContext)
        if (recording || refreshing) {
          await writeFile(notificationsExpectedPath, normalizedNotifications)
          await writeFile(resultExpectedPath, normalizedResult)
        }
        const expectedNotifications = await readFile(notificationsExpectedPath, 'utf8')
        expect(
          notificationComparisonRecords(normalizedNotifications, ordered.map(log => log.content)),
          `${scenario.name}: notifications`,
        )
          .toEqual(notificationComparisonRecords(expectedNotifications, expectedContents))
        expect(normalizedResult).toBe(await readFile(resultExpectedPath, 'utf8'))
      }

      if (scenario.name === 'system-prompt-in-history') {
        const events = notifications.flatMap(notification => {
          const event = notificationEvent(notification)
          return event === undefined ? [] : [event]
        })
        const systems = events.filter(event => event.type === 'system/message')
        expect(systems).toHaveLength(2)
        expect(systems.map(event => event.surfaceOp)).toEqual(['append', 'append'])
        const prompts = systems.map(event => (event.data as {
          message: { content: Array<{ text: string }> }
        }).message.content[0]!.text)
        expect(prompts[0]).not.toContain('Snapshot guidance added after the first read')
        expect(prompts[1]).toContain('Snapshot guidance added after the first read')
        expect(prompts[1]).not.toBe(prompts[0])
        expect(events.indexOf(systems[1]!)).toBeGreaterThan(events.findIndex(event => event.type === 'tool/result'))
        expect(events.filter(event => event.type === 'request/header')).toHaveLength(1)
        expect(events.filter(event => event.type === 'request/context')).toMatchObject([
          { data: { systemPromptUpdate: 'in-history' } },
        ])
        expect(events.filter(event => event.surfaceOp !== undefined).every(event => event.surfaceOp === 'append')).toBe(true)
      }

      // Wire-shape invariants that must hold in every mode.
      if (scenario.manifest.workspace?.final === true) {
        const expectedWorkspace = await captureExpectedWorkspaceSnapshot(join(scenario.dir, 'workspace.expected'))
        expect(finalWorkspace, `${scenario.name}: complete final workspace`).toEqual(expectedWorkspace)
      } else {
        expect(finalWorkspace, `${scenario.name}: a changed workspace requires workspace.final`).toEqual(initialWorkspace)
      }
      if (assertions.expectedTools !== undefined) {
        const parent = ordered[0]
        if (parent === undefined) throw new Error(`${scenario.name} has no parent session log`)
        expect(assembledToolRequirements(parent)).toEqual(assertions.expectedTools)
      }
      if (assertions.expectedSystem !== undefined) {
        const parent = ordered[0]
        if (parent === undefined) throw new Error(`${scenario.name} has no parent session log`)
        expect(assembledSystem(parent)).toBe(assertions.expectedSystem)
      }
      if (assertions.expectedToolDescriptions !== undefined) {
        const parent = ordered[0]
        if (parent === undefined) throw new Error(`${scenario.name} has no parent session log`)
        expect(assembledToolDescriptions(parent)).toMatchObject(assertions.expectedToolDescriptions)
      }
      if (assertions.runtimeContext !== undefined) {
        const parent = ordered[0]
        if (parent === undefined) throw new Error(`${scenario.name} has no parent session log`)
        const contexts = assembledRuntimeContexts(parent)
        if (assertions.runtimeContext === false) {
          expect(contexts).toEqual([])
        } else {
          expect(contexts).toHaveLength(1)
          const context = contexts[0] as string
          for (const clause of assertions.runtimeContext.includes) expect(context).toContain(clause)
          for (const clause of assertions.runtimeContext.excludes) expect(context).not.toContain(clause)
          const system = assembledSystem(parent)
          for (const clause of assertions.runtimeContext.includes) expect(system).not.toContain(clause)
        }
      }
      if (scenario.name === 'serial-created') {
        expect(observedMethods.has('subagent.started')).toBe(false)
      }
      if (ordered.length > 1 && assertions.dshSdkChild === undefined) {
        expect(observedMethods.has('subagent.started')).toBe(true)
        expect(observedMethods.has('subagent.finished')).toBe(true)
      }
    })
  }
})
