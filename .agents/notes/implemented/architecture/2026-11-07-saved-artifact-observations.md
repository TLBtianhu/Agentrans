# Agent Note: Saved observations retain their source and durable admission receipts

Status: implemented

English | [中文](2026-11-07-saved-artifact-observations.zh.md)

## Problem

A particle checkpoint identifies a fixed step but cannot identify its source revision. Keeping it in a component loses the experiment on reload. Reusing it with a changed source silently describes another experiment. Retrying a save or send after a lost response can also create duplicate facts or inputs.

## Decision

An explicitly saved observation contains a complete source snapshot, runtime checkpoint, label, and Host-recomputed values. A required `artifact/observations` event replaces one Artifact's complete saved list. The private Artifact Projection restores source lookups and observations; its wire value excludes source lookups and admission receipts, and compact Session summaries exclude observations. No recovery path scans the log or invokes a model.

Save retries compare their stable identity and captured values before testing the latest revision. The UI owns pending requests per Artifact, independently of revision-specific runs and movable views. Historical previews are read-only and use the saved source, while returning to the latest source resumes its separate paused state.

Sending uses ordinary input admission. The projection recognizes matching own-Session inbox or user-message receipts, so an accepted retry does not enqueue again. Forks inherit observations but do not treat parent receipts as their own admission. There is no separate success event between saving a receipt and enqueueing a message.

A particle comparison identifies an ordered pair of saved observations, including their original group and roles. A shared pure module requires equal runtime version, time step and step count and recomputes both sides. The Host resolves references through the same Projection and admits the fixed pair through the saved control revision. Own-Session receipts deduplicate each pair independently of individual sends; the private index stores only admitted keys and the wire value remains unchanged. Its cost grows with explicitly confirmed distinct pairs, not playback frames.

## Alternatives considered

**Checkpoint-only persistence** requires a separate historical source lookup before synchronous restoration. A complete source copy makes saved experiments self-contained; the configured per-Artifact limit bounds new saves without discarding older records.

**Local storage or a second observation ledger** duplicates Session recovery and separates saved experiments from branch ownership. Session Projection already provides recovery, checkpoints, and wire updates.

**Persisting a sent flag before dispatch** can lose input if the process stops between those operations. Deriving admission from the existing durable inbox and consumed messages ties deduplication to the action that actually happened.

**Combining current preview reports** cannot retain an experiment after either source changes. Saved references fix both sources and sampling conditions. A separate comparison ledger adds no fact for a deterministic pair without a user-authored conclusion; ordinary admitted messages already retain the evidence.

## Consequences

Saving and restoring do not change the model context. Explicit sending may reference an older source, while generic live actions retain current-revision checks. Saved source copies cost space, and a full list rejects new saves. Unrecognized required events make old readers refuse the Session instead of losing observations. Comparison selection is local; saved evidence and confirmed messages are durable. Equal sampling conditions do not establish causality. Deletion and automatic saving of live runs are not provided.
