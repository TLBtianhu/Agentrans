/**
 * Test-only client roster of the assembled viewer page.
 *
 * A served viewer page is the owner's own Web shell with the owner's client plugins; this roster is the
 * subset the viewer page specs need: the wire plugin, the Gateway, remote access, the Session/Workspace controllers,
 * the menu service, presentation plugins, and the Liveshare `./client` face, which mounts the viewer surfaces when the
 * carrier names a share. Every row is the package's own `/client` face registered as a module-table
 * factory. It must be imported only after {@link prepareViewerRemoteFaces} answered the generated
 * `/remote` faces these plugins import.
 *
 * @module @agentrans/experimental-liveshare/tests/viewer-page-roster
 */

import * as apiGateway from '@agentrans/api-gateway/client'
import * as apiRemoteAccess from '@agentrans/api-remote-access/client'
import * as apiRemotes from '@agentrans/api-remotes/client'
import * as apiSessionController from '@agentrans/api-session-controller/client'
import * as apiWorkspaceController from '@agentrans/api-workspace-controller/client'
import * as clientConnection from '@agentrans/client-connection/client'
import * as clientFileUpload from '@agentrans/client-file-upload/client'
import * as clientLocale from '@agentrans/client-locale/client'
import * as clientModules from '@agentrans/client-modules/client'
import * as clientResources from '@agentrans/client-resources/client'
import * as clientShortcuts from '@agentrans/client-shortcuts/client'
import * as uiAttachment from '@agentrans/client-ui-attachment/client'
import * as uiChat from '@agentrans/client-ui-chat/client'
import * as uiContextMenu from '@agentrans/client-ui-context-menu/client'
import * as uiConversation from '@agentrans/client-ui-conversation/client'
import * as uiDeliverables from '@agentrans/client-ui-deliverables/client'
import * as uiFileDrag from '@agentrans/client-ui-file-drag/client'
import * as uiLayout from '@agentrans/client-ui-layout/client'
import * as uiRenderer from '@agentrans/client-ui-renderer/client'
import * as uiSession from '@agentrans/client-ui-session/client'
import * as uiSettings from '@agentrans/client-ui-settings/client'
import * as uiSidebar from '@agentrans/client-ui-sidebar/client'
import * as uiSidebarRight from '@agentrans/client-ui-sidebar-right/client'
import * as uiTheme from '@agentrans/client-ui-theme/client'
import * as uiTool from '@agentrans/client-ui-tool/client'
import * as uiTrajectory from '@agentrans/client-ui-trajectory/client'
import * as uiWorkspace from '@agentrans/client-ui-workspace/client'
import * as typertRegistry from '@agentrans/typert-registry/client'
import * as liveshare from '../src/client/index.ts'

/** One module-table row: the entry id the Loader creates, and that plugin's client exports. */
export interface ViewerPageRosterRow {
  readonly id: string
  readonly exports: Readonly<Record<string, unknown>>
}

/** Entry id of the module-system bootstrap whose exports the facade hands to the module system. */
export const VIEWER_PAGE_BOOTSTRAP_ID = '@agentrans/client-modules'

/** The viewer page roster; Cordis composes these entries by service injection, so order is irrelevant. */
export const VIEWER_PAGE_ROSTER: readonly ViewerPageRosterRow[] = [
  { id: '@agentrans/typert-registry', exports: typertRegistry },
  { id: '@agentrans/experimental-liveshare', exports: liveshare },
  { id: VIEWER_PAGE_BOOTSTRAP_ID, exports: clientModules },
  { id: '@agentrans/client-connection', exports: clientConnection },
  { id: '@agentrans/api-gateway', exports: apiGateway },
  { id: '@agentrans/api-remote-access', exports: apiRemoteAccess },
  { id: '@agentrans/api-remotes', exports: apiRemotes },
  { id: '@agentrans/api-session-controller', exports: apiSessionController },
  { id: '@agentrans/api-workspace-controller', exports: apiWorkspaceController },
  { id: '@agentrans/client-file-upload', exports: clientFileUpload },
  { id: '@agentrans/client-locale', exports: clientLocale },
  { id: '@agentrans/client-resources', exports: clientResources },
  { id: '@agentrans/client-shortcuts', exports: clientShortcuts },
  { id: '@agentrans/client-ui-renderer', exports: uiRenderer },
  { id: '@agentrans/client-ui-theme', exports: uiTheme },
  { id: '@agentrans/client-ui-settings', exports: uiSettings },
  { id: '@agentrans/client-ui-layout', exports: uiLayout },
  { id: '@agentrans/client-ui-session', exports: uiSession },
  { id: '@agentrans/client-ui-sidebar', exports: uiSidebar },
  { id: '@agentrans/client-ui-conversation', exports: uiConversation },
  { id: '@agentrans/client-ui-chat', exports: uiChat },
  { id: '@agentrans/client-ui-context-menu', exports: uiContextMenu },
  { id: '@agentrans/client-ui-tool', exports: uiTool },
  { id: '@agentrans/client-ui-attachment', exports: uiAttachment },
  { id: '@agentrans/client-ui-file-drag', exports: uiFileDrag },
  { id: '@agentrans/client-ui-sidebar-right', exports: uiSidebarRight },
  { id: '@agentrans/client-ui-trajectory', exports: uiTrajectory },
  { id: '@agentrans/client-ui-deliverables', exports: uiDeliverables },
  { id: '@agentrans/client-ui-workspace', exports: uiWorkspace },
]
