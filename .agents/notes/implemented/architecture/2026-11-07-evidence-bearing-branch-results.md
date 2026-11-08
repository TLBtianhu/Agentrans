# Agent Note: Branch evidence shares one immutable result admission

Status: implemented

English | [中文](2026-11-07-evidence-bearing-branch-results.zh.md)

## Problem

A branch conclusion can refer to an experiment that changes later. Returning browser text or only a current Artifact id can attach unrelated evidence. A result-only retry key can also silently acknowledge an earlier return after the user selects different evidence. Duplicated parent commit paths would make plain and evidence-bearing returns disagree about maintenance, durability and unknown outcomes.

## Decision

The Artifact branch bridge reads the exact child conclusion and saved evidence from one immutable query cut. Saved observations carry complete original sources and checkpoints; the bridge recomputes values and attaches self-contained text. The evidence is selected by the user and does not assert what the assistant used in its original reasoning. Parent Artifacts and child history stay independent.

Both return providers use the Host-only `session-branch/admission` operation. It serializes parent writes, compares earlier content for the same conclusion, appends only new content and flushes before acknowledging. Identical content recovers its receipt; changed content is an explicit conflict. Only failure before maintenance begins is busy. A later failure keeps an unknown outcome and requires an unchanged retry.

The bridge is a separate Web plugin. The main Artifact service keeps its headless dependencies, and the generic Session Controller has no Artifact evidence rules. The existing `branch-result` source and ordinary text blocks preserve the evidence without another event vocabulary or result ledger.

## Alternatives considered

**Adding Artifact selectors to Session Controller** gives generic lifecycle code ownership of one evidence domain. The bridge owns selection and computation while sharing the actual commit operation.

**Deduplicating only by conclusion without checking content** loses evidence changes while reporting success. One conclusion has one immutable accepted return; a different selection is rejected rather than silently replacing or duplicating it.

**Returning only cross-Session pointers** requires the parent to load child records later and risks confusing same-named Artifacts. Self-contained evidence costs bounded message space but leaves each Session's object namespace intact.

## Consequences

Preview and cancellation have no input effects. Confirmation appends one parent message without waking a model. Unknown retries freeze the complete selection. Large evidence can be rejected by the complete-message limit. New evidence for an already returned result requires a new child conclusion, not an overwrite or automatic chat merge.
