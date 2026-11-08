# Agent Note: Particle runs retain one calculation across preview and export

Status: implemented

English | [中文](2026-11-07-particle-run-ownership.zh.md)

## Problem

The particle preview and exported player used different integration orders. Preview-owned state also disappeared when source inspection or placement changes remounted the view. A stable Artifact identity did not preserve the experiment being inspected.

## Decision

The pure [particle runtime](../../../../packages/artifact/artifact/src/particle-runtime.ts) owns explicit-Euler evaluation. Absolute step counts determine time, positions, velocities, and a bounded trail. A closed-form sum preserves the preview's integration order without work proportional to elapsed steps. Runtime version 1 identifies this calculation; its step-count checkpoint requires the same source revision.

The SessionBinding's interaction owner holds one calculation per node and Artifact revision. Mounted renderers read it through framework keyed hooks and receive command callbacks. Source inspection and placement changes retain the calculation; hiding pauses playback, while source replacement or the last renderer's release discards it. Physical preview lifetimes and readiness have [separate ownership](2026-11-07-artifact-runtime-reports.md). HTML export captures the current step and uses the same evaluator.

## Alternatives considered

**Keeping the simulation in each view** loses state when presentation changes and leaves export free to implement another experiment. Sharing only the renderer does not resolve either problem.

**Logging every step or adding durable checkpoints now** introduces Session compatibility and recovery policy before those features have a user workflow. This slice keeps runs local and adds no model-visible input until explicit confirmation.

**Replaying every preceding step** makes seek cost depend on duration and step size. Constant gravity permits bounded evaluation; more general solvers require their own execution limits.

## Consequences

Numeric failure retains the last finite state and stops advancement. Checkpoints cannot independently identify a work or restore another revision. [Saved observations](2026-11-07-saved-artifact-observations.md) pair them with a complete durable source; unsaved runs remain transient. Comparison command routing and background export jobs remain separate work. HTML templates and other scene kinds retain their current state ownership.
