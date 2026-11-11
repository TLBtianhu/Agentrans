---
kind: upgrade-guide
description: "Persisted Artifact HTML exports require an export-aware Session reader and the Web export service."
---

# Restore fixed-source Artifact HTML exports

English | [中文](guide.zh.md)

## Change

Native Scene HTML export now persists the original source, replay conditions and file receipt through the optional `dsh-artifact-export` Web Host plugin. The shipped Web composition mounts it. Custom Web compositions must provide this service, attachment file storage and the existing file-actions Client service to use the export controls. Headless Artifact use does not require it.

Export writes a required `artifact/export` event. Existing Sessions without exports remain readable; a reader that does not recognize this event refuses affected Sessions. No format-version bump or automatic downgrade is provided. Exported HTML includes fixed source identity; non-particle scenes still use source defaults rather than local UI parameters.

## Migration

1. Upgrade readers before opening Sessions containing exports. Keep the original data when an older reader refuses it.
2. Custom Web compositions add `@agentrans/artifact-export` and mount `attachments`, `sessionProjections`, `artifacts`, and Client `fileActions`. Keep attachment storage in the same isolated instance as its Session logs.
3. Export a saved particle observation, update its source, reload, and download the existing result. Verify the original revision and step. A pending record has no confirmed result; explicitly continue its fixed request. A Web download request does not prove a file was saved.
