---
name: artifact-design
description: Create or revise beautiful, interactive HTML Artifacts, simulations, prediction labs, parameter explorers, and explanatory animations using Agentrans design tokens, self-contained templates, restrained motion primitives, and real-browser screenshot review. Use when an answer should include a polished visual explanation rather than plain text or an unstyled card.
---

# Agentrans Artifact design

## Summary

Use this skill when an Artifact should feel like a designed explanation, not an HTML placeholder. Start from a complete template, keep its visual hierarchy and controls, and replace only the domain model, copy, and interaction semantics. Every Artifact remains self-contained: no CDN, remote font, image-generation model, video-generation model, or network dependency is allowed.

## Table of Contents

- [Choose a template](#choose-a-template)
- [Design and motion rules](#design-and-motion-rules)
- [Customize safely](#customize-safely)
- [Render, inspect, revise](#render-inspect-revise)
- [Validation](#validation)

## Choose a template

- [Prediction lab](references/prediction-lab.html) — guided observation → prediction → manipulation → feedback. It includes a trajectory stage, angle control, prediction buttons, launch result, and the `shot.completed` action used by Agentrans. Preserve the `artifact-action` fields and revision when adapting its semantics.
- [Parameter explorer](references/parameter-explorer.html) — a live damped-oscillator chart with amplitude/frequency/damping sliders, play, pause, step, and reset. Use it for simulations that need parameter manipulation and immediate visual feedback.
- [Theme source](references/theme.css) — shared light/dark tokens, layout, controls, metrics, charts, and responsive rules. Edit this when changing the visual system rather than forking colors per Artifact.
- [Motion source](references/motion.js) — small one-shot `beat`, `highlight`, and `tween` helpers. Inline them into custom Artifacts; no import or package is required.

Run `node .agents/skills/artifact-design/references/build.mjs` after editing the theme, motion helper, or `references/src/*.html`. It inlines those sources into the complete templates above.

## Design and motion rules

- Establish one main idea per screen: concept and prediction first, simulation second, controls beside it, result and feedback last. Do not fill every region with decoration.
- Use the shared accent, ink, muted text, surface, border, spacing, and radius tokens. Do not introduce arbitrary colors or shadows for each answer. Both light and dark themes must remain readable.
- Keep the main stage stable. Animate only the object being explained, using `beat` for staged entry, `highlight` for a changed result, and `tween` for a short state change. Avoid infinite animation and autoplay that cannot be paused.
- Use SVG/Canvas for trajectories, charts, and diagrams. Use CSS for transitions. Add a larger animation library only when the scene genuinely needs it, and bundle it locally instead of linking a CDN.
- Support keyboard focus, `aria-pressed` for toggles, `role="status"` for results, and `prefers-reduced-motion`. Never make motion the only way to understand the result.
- Keep the model deterministic. User prediction and manipulation may change state, but network responses, random layout changes, and decorative motion must not alter the educational result.

## Customize safely

1. Copy the closest complete template, not just its CSS. Preserve the controls, accessible names, and semantic action protocol.
2. Replace the domain formula, labels, and explanatory copy. Keep the stage, controls, result, and feedback in the same reading order unless the concept requires another layout.
3. When using `prediction-lab`, preserve `artifactId`, `revision`, `action: 'shot.completed'`, and the payload fields `angle`, `predictedHit`, and `actualHit`, or update the replay fixture and contract together.
4. Do not paste credentials, provider keys, local file paths, or user data into an Artifact. Templates and generated demos must use synthetic values.
5. Check the final source for remote URLs, forms, navigation, and imports. If the design depends on a remote resource, make it inline or remove it.

## Render, inspect, revise

1. Render the Artifact in a real browser at 1440×960 and 390×844, in light and dark mode.
2. Capture a screenshot after the main interaction, not only the initial frame. Check hierarchy, spacing, clipping, readable text, and whether the result is visually obvious.
3. Use `read_image` to inspect the screenshot. Ask whether it looks like a designed lab or a plain card with buttons. Revise the HTML and render again before delivering.
4. Exercise the primary flow with keyboard and pointer. Confirm that the result is understandable without motion and that no external request occurs.

See [Visual review](references/visual-review.md) for the concrete checklist and evidence files.

## Validation

- Rebuild templates after editing their sources.
- Run the design-template browser smoke for rendering, interaction, responsiveness, and network isolation.
- Run the real DSH Artifact replay when a template is used by a model-driven Session.
- Do not claim visual quality from DOM checks alone. Keep screenshots and record which views and interactions were inspected.
