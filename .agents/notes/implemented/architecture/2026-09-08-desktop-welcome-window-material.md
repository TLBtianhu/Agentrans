# Agent Note: Desktop welcome window material

Status: implemented

English | [中文](2026-09-08-desktop-welcome-window-material.zh.md)

## Problem

The desktop welcome design blurs the desktop behind its entire window. Chromium backdrop filters only sample content inside the renderer. Credential setup also needs an explicit startup owner so a native skip is not followed by a second Web dialog.

## Decision

The [Electron welcome window](../../../../apps/desktop/src/welcome-window.ts) owns native material and controls. Its local React renderer presents one API-key form with a plain-text Agentrans brand. The isolated preload supplies localized copy, save, skip and a parameterless request to open the [official DeepSeek key page](https://platform.deepseek.com/api_keys). Main owns that URL and rejects other windows and subframes. The document denies network requests and navigation. Each sandboxed preload is bundled independently because Electron's restricted require cannot load sibling chunks. Main authenticates through the shared Web launch URL, reads configured-key metadata and writes the official provider's reference through existing settings and credential RPC. The [thin Web wrapper](2026-09-10-desktop-web-wrapper.md) owns HTTP; onboarding adds no Host endpoint or child IPC operation. Responses contain metadata or a safe outcome, never a key or private provider diagnostics.

Cold startup opens the form when no model API-key reference is configured. Native onboarding neither reads account state nor watches account callbacks; existing grants stay stored. Saving enters the workspace after persistence succeeds and retains the draft on failure. Skipping enters without saving a draft or completion flag; the next cold start checks keys again. Save, skip and the external link share a busy lock. The Desktop preload marker suppresses automatic Web credential setup and the welcome notice; Models settings and explicit key editing remain available. The [account provider](2026-09-14-deepseek-account-login.md) remains available to optional Web account and Platform compositions. Native analytics reads the existing collection policy for each event before reporting; it does not depend on an account-state stream.

The generated project follows declared workspace dependencies because pnpm’s hoist index alone can omit configured plugins.

Desktop reads the shared `locale.preference` before opening the welcome window. The Client awaits the isolated preload's preference and OS language order before mounting, then reports resolved locale changes to the shell. Only an explicit Settings selection writes the preference; automatic detection stays provisional. The shell ships eight language dictionaries and falls back to a supported OS language or English.

The welcome flow shares the Desktop backend controller with startup recovery. The main recovery document loads offscreen while the Host starts; a failure reveals it, and successful startup chooses the welcome window or workspace after reading credentials and locale. Recovery actions retain the controller’s serialized retries and awaited child shutdown. The application preload exposes recovery controls only to shell documents and the locale bridge only to application documents.

## Alternatives considered

**A CSS-only backdrop filter.** It cannot blur other application windows or the desktop, so it cannot provide the required native effect.

**Persisting a credential-entry completion flag.** A native skip is valid only for the current process; retaining a flag would suppress the next cold-start choice while no model key is configured. The optional account introduction's separate flag does not bypass this key check.

**Keeping both native and Web credential dialogs.** Their separate completion state would ask for a key twice after a native skip. The composition assigns credential onboarding to one owner.

**Drawing replacement traffic lights.** Native controls preserve platform window behavior and accessibility. Their dimensions and outer window corners follow the OS rather than reproducing Figma geometry exactly.

**Separate preview callbacks.** A visual-only skip cannot demonstrate entry into the workspace and can hide broken startup dependencies. The preview uses the same callbacks and Host as the product.

## Consequences

Native blur strength and font fallback vary by system. The main window uses sidebar vibrancy; onboarding retains a transparent renderer without an additional tint. Windows compositing needs platform QA. Owner-local renderer and text expectations cover the single form and its actions; built-Host acceptance covers key metadata across restarts without account requests. Stored account grants and independent API keys remain intact. Onboarding presentation produces no Session events.
