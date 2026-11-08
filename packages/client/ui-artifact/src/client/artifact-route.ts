/** Artifact operations use root Session routing; subagent continuation has no corresponding Host operation route. */
import type { SessionSnapshot } from '@deepseek-ai/dsh-api-session-controller/client'

/**
 * Distinguish the real continuation route from a root Session or ordinary manual branch.
 * @param session - Current Session route descriptor, independent of source capability and permission.
 * @returns Whether root-only Artifact operations can use this Session route.
 */
export function artifactHostRouteAvailable(session: Pick<SessionSnapshot, 'subagent'>): boolean {
  return session.subagent === null
}
