/**
 * Inspect the original installer or both macOS distribution files with the platform's native tools.
 * @param target Build target.
 * @param paths Absolute or working-directory-relative artifact paths.
 * @param request Expected release version and update channel.
 * @param identity Trusted public certificate identity.
 */
export function verifySignedDesktopArtifact(
  target: 'win-x64' | 'mac-arm64' | 'mac-x64',
  paths: { installer?: string; dmg?: string; zip?: string },
  request: { version: string; channel: 'nightly' | 'latest' },
  identity: { windowsThumbprint?: string; macTeamId?: string; macSigningIdentity?: string },
): Promise<void>
