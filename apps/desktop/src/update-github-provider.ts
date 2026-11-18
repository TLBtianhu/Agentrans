/** Select Desktop updates from the GitHub release class pinned by the installed app. */

import type { AppUpdater } from 'electron-updater'
import { GitHubProvider } from 'electron-updater/out/providers/GitHubProvider.js'
import { parseUpdateInfo, type ProviderRuntimeOptions } from 'electron-updater/out/providers/Provider.js'
import { gt, parse, type SemVer } from 'semver'
import { z } from 'zod'
import type { DesktopUpdateChannel } from './update-channel.ts'
import { readUpdateReleaseCoordinates } from './update-verification.ts'

const PAGE_SIZE = 100
const releaseList = z.array(z.object({
  tag_name: z.string(),
  draft: z.boolean(),
  prerelease: z.boolean(),
  name: z.string().nullish(),
  body: z.string().nullish(),
}))

const providerOptions = z.object({ owner: z.string(), repo: z.string(), releaseChannel: z.enum(['nightly', 'latest']) })
type Release = z.infer<typeof releaseList>[number]
type GitHubUpdateInfo = Awaited<ReturnType<GitHubProvider['getLatestVersion']>>

/** Keep electron-updater's GitHub asset resolution and restrict its release discovery. */
class DesktopGitHubProvider extends GitHubProvider {
  private readonly currentVersion: string
  private readonly releaseChannel: DesktopUpdateChannel

  constructor(
    options: unknown,
    updater: AppUpdater,
    runtime: ProviderRuntimeOptions,
  ) {
    const { owner, repo, releaseChannel } = providerOptions.parse(options)
    super({ provider: 'github', owner, repo }, updater, runtime)
    this.currentVersion = updater.currentVersion.version
    this.releaseChannel = releaseChannel
  }

  override async getLatestVersion(): Promise<GitHubUpdateInfo> {
    const releasesUrl = new URL(`/repos/${this.options.owner}/${this.options.repo}/releases`, this.baseApiUrl)
    releasesUrl.searchParams.set('per_page', String(PAGE_SIZE))
    const nightly = this.releaseChannel === 'nightly'
    let selected: { release: Release; version: SemVer } | undefined
    for (let page = 1; ; page++) {
      releasesUrl.searchParams.set('page', String(page))
      const text = await this.httpRequest(releasesUrl, { accept: 'application/vnd.github+json' })
      const releases = releaseList.parse(JSON.parse(text ?? 'null'))
      for (const release of releases) {
        if (release.draft || release.prerelease !== nightly) continue
        const version = parse(release.tag_name)
        if (version === null || (!nightly && version.prerelease.length > 0) || !gt(version, this.currentVersion)) continue
        if (selected === undefined || gt(version, selected.version)) selected = { release, version }
      }
      if (releases.length < PAGE_SIZE) break
    }

    // AppUpdater treats its own version as up to date and does not resolve any files.
    if (selected === undefined) return { version: this.currentVersion, files: [], path: '', sha512: '', releaseDate: '', tag: '' }

    const { release: { tag_name: tag, name, body }, version } = selected
    const prerelease = version.prerelease[0]
    const channel = prerelease === undefined ? this.getDefaultChannelName() : this.getCustomChannelName(String(prerelease))
    const file = `${channel}.yml`
    const url = new URL(`/${this.options.owner}/${this.options.repo}/releases/download/${encodeURIComponent(tag)}/${file}`, this.baseUrl)
    const info = parseUpdateInfo(await this.httpRequest(url), file, url)
    if (info.version !== version.version) throw new Error(`desktop update: ${file} version does not match release ${tag}`)
    return { ...info, releaseName: info.releaseName ?? name ?? null, releaseNotes: info.releaseNotes ?? body ?? null, tag }
  }
}

/**
 * Bind the packaged GitHub feed to a release channel while retaining the pinned updater transport.
 * @param updater - Desktop's electron-updater instance.
 * @param channel - Installed package channel.
 * @param resourcesPath - Directory containing the packaged app-update.yml.
 */
export async function configureDesktopGitHubUpdateFeed(
  updater: AppUpdater,
  channel: DesktopUpdateChannel,
  resourcesPath: string,
): Promise<void> {
  const coordinates = await readUpdateReleaseCoordinates(resourcesPath)
  updater.setFeedURL({ provider: 'custom', updateProvider: DesktopGitHubProvider, ...coordinates, releaseChannel: channel })
}
