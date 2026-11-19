/** Identify the two known macOS candidates for the isolated update test and sign the original ZIP. */
import assert from 'node:assert/strict'
import { createHash, createPublicKey } from 'node:crypto'
import { lstat, mkdir, writeFile, appendFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { UPDATE_SIGNING_PUBLIC_KEY } from '../apps/desktop/src/update-signing-key.ts'
import { privateKeyFromBase64, publicKeyFromBase64, sha256File, signFileDigest, verifyFileDigest } from '../apps/desktop/src/update-signature.ts'

const repository = 'TLBtianhu/Agentrans'
const workflow = '.github/workflows/agentrans-hosted-package.yml'
const workflowId = 413465192
const sourceSha = 'aa52b730df40252cbe1675039f1043698148beee'
const oldVersion = '0.1.0-test.20261118.4'
const newVersion = '0.1.0-test.20261118.5'
const oldRun = 44480323500
const oldDigest = 'sha256:99c5cb9fb9e691c4dd33dd197438a819cac5e4e8e0e403231642d2417c47f10a'
const candidateRuns = { arm64: 44501717503, x64: 44501723293 }
const arch = process.env.QA_ARCH
assert.ok(arch === 'x64' || arch === 'arm64', 'Set QA_ARCH to a fixed macOS target')
const newRun = candidateRuns[arch]

async function github(path) {
  assert.ok(process.env.GH_TOKEN, 'An Actions-read token is required to select package artifacts')
  const response = await fetch(`https://api.github.com/repos/${repository}/${path}`, {
    headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, 'X-GitHub-Api-Version': '2022-11-28' }, redirect: 'error',
  })
  assert.ok(response.ok, `GitHub package metadata request returned HTTP ${response.status}`)
  return response.json()
}

async function select(runId, target, version) {
  const name = `agentrans-${target}`
  const [run, list] = await Promise.all([
    github(`actions/runs/${runId}`), github(`actions/runs/${runId}/artifacts?name=${name}`),
  ])
  assert.equal(run.id, runId)
  assert.equal(run.workflow_id, workflowId)
  assert.equal(run.path, workflow)
  assert.equal(run.head_repository?.full_name, repository)
  assert.equal(run.head_sha, sourceSha)
  assert.equal(run.event, 'workflow_dispatch')
  assert.equal(run.conclusion, 'success')
  assert.equal(run.display_title, `Package Agentrans · ${target} · nightly · ${version}`)
  assert.equal(list.total_count, 1, `Expected one ${name} artifact in run ${runId}`)
  const [artifact] = list.artifacts
  assert.equal(artifact.name, name)
  assert.equal(artifact.expired, false)
  assert.equal(artifact.workflow_run.id, runId)
  assert.ok(Number.isSafeInteger(artifact.id) && artifact.id > 0)
  assert.match(artifact.digest, /^sha256:[0-9a-f]{64}$/u)
  return { id: artifact.id, digest: artifact.digest }
}

switch (process.argv[2]) {
  case 'select': {
    const [old, candidate] = await Promise.all([select(oldRun, 'mac', oldVersion), select(newRun, `mac-${arch}`, newVersion)])
    assert.equal(old.digest, oldDigest, 'The original .4 artifact archive changed')
    await appendFile(process.env.GITHUB_OUTPUT,
      `old_run=${oldRun}\nold_artifact=${old.id}\nnew_run=${newRun}\nnew_artifact=${candidate.id}\n`)
    break
  }
  case 'sign': {
    const zip = process.env.QA_NEW_ZIP
    const expected = join(process.env.RUNNER_TEMP, 'candidate-ed25519-input', `agentrans-${newVersion}-mac-${arch}-unsigned.zip`)
    assert.equal(zip, expected, 'Only the downloaded .5 ZIP is an eligible signing input')
    assert.ok((await lstat(zip)).isFile(), 'Candidate must be a regular ZIP file')
    assert.ok(process.env.AGENTRANS_UPDATE_SIGNING_KEY, 'The existing update signing key is required')
    const key = privateKeyFromBase64(process.env.AGENTRANS_UPDATE_SIGNING_KEY)
    const pinned = publicKeyFromBase64(UPDATE_SIGNING_PUBLIC_KEY)
    assert.ok(key.asymmetricKeyType === 'ed25519' && createPublicKey(key).equals(pinned), 'Signing key does not match the shipped public key')
    const signature = await signFileDigest(zip, key)
    assert.ok(await verifyFileDigest(zip, signature, pinned), 'Candidate signature failed self-verification')
    await writeFile(`${zip}.sig`, `${signature}\n`, { flag: 'wx' })
    const reportDirectory = dirname(process.env.QA_REPORT_DIR)
    await mkdir(reportDirectory, { recursive: true })
    const publicKeySha256 = createHash('sha256').update(pinned.export({ type: 'spki', format: 'der' })).digest('hex')
    await writeFile(join(reportDirectory, 'inputs.json'), `${JSON.stringify({
      arch, oldRun, newRun, sourceSha, oldVersion, newVersion, candidateSha256: await sha256File(zip), publicKeySha256,
    }, null, 2)}\n`, { flag: 'wx' })
    console.log(`Signed the original ${arch} candidate with the pinned update key`)
    break
  }
  default: throw new Error('Expected select or sign')
}
