/** Select compatible GitHub updates for the installed Desktop release series and architecture. */

import type { AppUpdater } from 'electron-updater'
import { GitHubProvider } from 'electron-updater/out/providers/GitHubProvider.js'
import { parseUpdateInfo, type ProviderRuntimeOptions } from 'electron-updater/out/providers/Provider.js'
import { gt, parse, rcompare, type SemVer } from 'semver'
import { z } from 'zod'
import type { DesktopUpdateChannel } from './update-channel.ts'
import { desktopReleaseArtifactStems, type DesktopReleaseTarget } from './update-release-assets.ts'
import { readUpdateReleaseCoordinates } from './update-verification.ts'

const PAGE_SIZE = 100
const releaseAsset = z.object({ name: z.string(), state: z.string(), size: z.int().nonnegative() })
const releaseList = z.array(z.object({
  tag_name: z.string(),
  draft: z.boolean(),
  prerelease: z.boolean(),
  name: z.string().nullish(),
  body: z.string().nullish(),
  assets: z.array(releaseAsset).default([]),
}))
const updateFiles = z.array(z.looseObject({
  url: z.string(),
  sha512: z.string().regex(/^[A-Za-z0-9+/]{86}==$/u),
  size: z.int().positive(),
}))

const providerOptions = z.object({
  owner: z.string(), repo: z.string(), releaseChannel: z.enum(['nightly', 'latest']), appArchitecture: z.string(),
})
type Release = z.infer<typeof releaseList>[number]
type GitHubUpdateInfo = Awaited<ReturnType<GitHubProvider['getLatestVersion']>>

function updateTarget(platform: ProviderRuntimeOptions['platform'], architecture: string): DesktopReleaseTarget | undefined {
  if (platform === 'darwin' && (architecture === 'arm64' || architecture === 'x64')) return `mac-${architecture}`
  if (platform === 'win32' && architecture === 'x64') return 'win-x64'
}

/** Keep electron-updater's GitHub asset resolution and restrict its release discovery. */
class DesktopGitHubProvider extends GitHubProvider {
  private readonly currentVersion: SemVer
  private readonly releaseChannel: DesktopUpdateChannel
  private readonly target: DesktopReleaseTarget | undefined

  constructor(
    options: unknown,
    updater: AppUpdater,
    runtime: ProviderRuntimeOptions,
  ) {
    const { owner, repo, releaseChannel, appArchitecture } = providerOptions.parse(options)
    super({ provider: 'github', owner, repo }, updater, runtime)
    this.currentVersion = updater.currentVersion
    this.releaseChannel = releaseChannel
    this.target = updateTarget(runtime.platform, appArchitecture)
  }

  override async getLatestVersion(): Promise<GitHubUpdateInfo> {
    // AppUpdater treats its own version as up to date and does not resolve any files.
    const upToDate = { version: this.currentVersion.version, files: [], path: '', sha512: '', releaseDate: '', tag: '' }
    const target = this.target
    if (target === undefined) return upToDate

    const releasesUrl = new URL(`/repos/${this.options.owner}/${this.options.repo}/releases`, this.baseApiUrl)
    releasesUrl.searchParams.set('per_page', String(PAGE_SIZE))
    const nightly = this.releaseChannel === 'nightly'
    const series = nightly ? this.currentVersion.prerelease[0] : undefined
    const candidates: { release: Release; version: SemVer }[] = []
    for (let page = 1; ; page++) {
      releasesUrl.searchParams.set('page', String(page))
      const text = await this.httpRequest(releasesUrl, { accept: 'application/vnd.github+json' })
      const releases = releaseList.parse(JSON.parse(text ?? 'null'))
      for (const release of releases) {
        if (release.draft || release.prerelease !== nightly) continue
        const version = parse(release.tag_name)
        if (version === null || (!nightly && version.prerelease.length > 0) || !gt(version, this.currentVersion.version)) continue
        if (series !== undefined && version.prerelease[0] !== series) continue
        candidates.push({ release, version })
      }
      if (releases.length < PAGE_SIZE) break
    }

    const extension = target === 'win-x64' ? '.exe' : '.zip'
    candidates.sort((left, right) => rcompare(left.version, right.version))
    for (const { release, version } of candidates) {
      const { tag_name: tag, name, body, assets } = release
      const prerelease = version.prerelease[0]
      const channel = prerelease === undefined ? this.getDefaultChannelName() : this.getCustomChannelName(String(prerelease))
      const file = `${channel}.yml`
      const uploaded = new Map(assets.filter(asset => asset.state === 'uploaded' && asset.size > 0).map(asset => [asset.name, asset.size]))
      const installers = desktopReleaseArtifactStems('agentrans', version.version, target).map(stem => stem + extension)
      if (!uploaded.has(file) || !installers.some(installer => uploaded.has(installer))) continue

      const url = new URL(`/${this.options.owner}/${this.options.repo}/releases/download/${encodeURIComponent(tag)}/${file}`, this.baseUrl)
      let rawData: string | null
      try {
        rawData = await this.httpRequest(url)
      } catch (error) {
        if (typeof error === 'object' && error !== null && 'statusCode' in error && error.statusCode === 404) continue
        throw error
      }
      const info = parseUpdateInfo(rawData, file, url)
      if (info?.version !== version.version) throw new Error(`desktop update: ${file} version does not match release ${tag}`)
      const installer = updateFiles.parse(info.files).find(entry =>
        installers.includes(entry.url) && uploaded.get(entry.url) === entry.size)
      if (installer === undefined) continue

      // Give the downloader exactly the file we qualified. In particular, keep the installed architecture under Rosetta.
      const qualified = {
        ...info, files: [installer], path: installer.url, sha512: installer.sha512,
        releaseName: info.releaseName ?? name ?? null, releaseNotes: info.releaseNotes ?? body ?? null, tag,
      }
      // electron-updater also looks for NSIS web archives outside its public UpdateInfo type.
      Reflect.deleteProperty(qualified, 'packages')
      return qualified
    }
    return upToDate
  }
}

/**
 * Bind the packaged GitHub feed to a release channel while retaining the pinned updater transport.
 * @param updater - Desktop's electron-updater instance.
 * @param channel - Installed package channel.
 * @param resourcesPath - Directory containing the packaged app-update.yml.
 * @param appArchitecture - Architecture of the installed Desktop executable.
 */
export async function configureDesktopGitHubUpdateFeed(
  updater: AppUpdater,
  channel: DesktopUpdateChannel,
  resourcesPath: string,
  appArchitecture: NodeJS.Architecture = process.arch,
): Promise<void> {
  const coordinates = await readUpdateReleaseCoordinates(resourcesPath)
  updater.setFeedURL({ provider: 'custom', updateProvider: DesktopGitHubProvider, ...coordinates, releaseChannel: channel, appArchitecture })
}
