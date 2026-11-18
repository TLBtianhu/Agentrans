---
name: artifact-design
description: Build a custom interactive HTML explanation when the user needs to vary parameters, move a probe, or observe live results. Use the bundled parameter explorer template.
---

# Design an interactive Artifact

Use `scene` directly when a native scene fits. Use this template when the explanation needs a custom interaction.

1. Adapt the included `parameter-explorer.html`. Keep its layout and its template, stage, controls, and readings markers. Replace the sample equation, drawing, labels, units, and ranges with values for this experiment.
2. Use the same state and calculation for pointer and keyboard changes. Keep a native labeled range input for each adjustable value and probe position. When a probe belongs on the visual, let the user drag the marker there and keep the range input synchronized. Calculate each readout from the current inputs and show its unit and sign when relevant.
3. Put the main reading near the top and use a short, wide stage. At phone widths, fit the reading, stage, and controls in the first 320 pixels of the inline preview. Let long labels wrap. Give the visual an accessible name and keep keyboard focus visible.
4. Submit the complete adapted HTML with `artifact` and `presentation: inline`. Keep CSS and JavaScript in the document. Call `window.artifactRuntime.ready` after the first render and report later changes with `reportState`. Use `artifact_runtime` when available to check the returned revision, then tell the user what to try.
