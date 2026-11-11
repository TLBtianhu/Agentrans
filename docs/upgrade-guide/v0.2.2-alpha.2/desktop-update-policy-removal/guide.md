---
kind: upgrade-guide
description: "Agentrans removes the hosted mandatory-update policy, its test sign-in window, and the local settings file that permitted it; updates come from the GitHub release feed alone."
---

# Review the update policy removal

English | [中文](guide.zh.md)

## Change

Packaged applications no longer consult a remote policy service. The `AGENTRANS_DESKTOP_MANDATORY_UPDATE_*` settings, `AGENTRANS_DESKTOP_AUTO_UPDATE_ENV`, and the embedded `dshMandatoryUpdatePolicy` manifest field are gone, together with the forced-update overlay, its Windows frame, the macOS isolated view, and the test-only Feishu sign-in window. A release build no longer requires a policy origin.

`agent.getPath('userData')/desktop/settings.json` is no longer read. The only field it carried, `updates.allowTestAuthPopupWindow`, gated the removed sign-in window; the shell keeps no local settings file, and an existing document is left on disk untouched.

Updates keep one source: the GitHub release feed the build embeds, with `latest` reading published releases and `nightly` reading prereleases. The application checks it at startup, on foreground or resume when due, and when the user asks. No check forces an update, blocks product work, or depends on a server decision; an available release is offered, downloaded, verified, and installed only after the user approves each step.

## Migration

1. Remove `AGENTRANS_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN`, `AGENTRANS_DESKTOP_MANDATORY_UPDATE_PROD_ORIGIN`, `AGENTRANS_DESKTOP_MANDATORY_UPDATE_CONFIG`, `AGENTRANS_DESKTOP_AUTO_UPDATE_ENV`, and `PACKAGE_TEST_RELEASE_ID` from packaging dotenv files and CI variables. A preset that still declares them fails validation as an unsupported setting rather than silently ignoring them.
2. Delete `desktop/settings.json` under the Electron `userData` directory, or leave it: nothing reads it. Release notes no longer offer the test sign-in.
3. Confirm an installed build checks the feed it should: `latest` installations offer published releases and `nightly` installations offer prereleases. The updater runs the same download, verification, and installation flow as before; only policy polling and the forced block are gone.
