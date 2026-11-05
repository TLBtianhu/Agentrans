# Artifact style reference

Curated visual idioms for Agentrans Artifacts, distilled from the 341-style code-animation library. Choose the idiom that matches the content's explanatory job, then keep its palette, typography, layout, and motion discipline. These are design patterns, not prompts: apply them to the SceneSpec or HTML you produce, and keep the Agentrans instrument restraint (direct labels, tabular numerals, one accent system, purposeful motion).

## Math proof lecture — function plots, comparisons, quantitative arguments

Use for function-plot, derivative/integral analysis, and control-vs-variant comparisons.

- **Palette**: near-black navy `#0a0b0f` with a faint off-center glow; off-white primary text `#c7c7c9`; gold `#fed74b` for the subject being argued for; cyan `#5ac4dc` for the baseline/reference; sage `#8ab679` for positive deltas; dusty coral `#ca6f74` for cost/negative values. Apply the accent system consistently across curves, charts, and callouts.
- **Typography**: serif display for the big title and large numerals; geometric sans for labels, axis ticks, and body text, stepped down in brightness for lower hierarchy.
- **Layout**: small series title top-left, one colored subtitle acting as a step label ("Lemma N"), main content centered, a tiny dim source line pinned bottom-left. Stage the argument as numbered claims, ending with a "therefore" statement and a QED mark.
- **Motion**: elements draw on or grow in a fixed frame; equations build left-to-right in color runs, with the final result boxed in the highlight color. No camera movement, no particles.
- **Data visuals**: thin-outline bars/lines on faint gridlines, value labels above marks, dashed guides, and a directional arrow from old to new value.

## Transit map — flowcharts, paths, processes

Use for flowchart primitives and any "how we get from A to B" explanation.

- **Palette**: cream map paper `#f4f0e6`, ink `#1d1d22`, muted `#6f6a60`; route lines in two line colors (terracotta `#d9774f`, navy `#23408e`) with white-ringed station dots and 45° bends; navy station signs `#1f2a44` with white text.
- **Layout**: stations light up one by one along a route; a train runs the line from station to station; numbers appear in badges in the line color; the ending is the terminus sign. Open with a station sign board, then a title with a line drawn across the frame.
- **Motion**: the route line draws itself, stations light up in order, and a train moves between stations. Keep the map stable; only the train and station states animate.
- **When to prefer it**: causal chains, step-by-step processes, state transitions, and any path that should read as a journey rather than a diagram.

## Blueprint — structure, architecture, specifications

Use for system structure, component relationships, and "how it is built" explanations.

- **Palette**: blueprint blue `#17508c` with a faint grid and a thin border; near-white linework; construction lines faint; yellow `#ffd166` for highlights.
- **Typography**: IBM Plex Mono in capitals, like drafting lettering.
- **Layout**: dimension lines, numbered balloons on process boxes, a title block in the lower right with drawing number, sheet name, and date. Open with NOTE lines with dashed underlines.
- **Motion**: process boxes join by arrows, each tagged with a numbered balloon; a huge value is dimensioned by its label.
- **When to prefer it**: architecture, API relationships, data flow, and anything that should read as a specification rather than a narrative.

## Particles — atmosphere, simulation, motion

Use for particle-system primitives and any "drawn in code" simulation.

- **Palette**: near-black `#05060b`; particles in cyan, violet, white, and pink with brand colors among them; bloom on everything.
- **Layout**: thousands of short glowing streaks drift on a smooth flow field, gather into words, logos, and numbers, then scatter and re-form. Keep particle text at 150–260 px so it reads as letters.
- **Motion**: morph from one shape straight into the next, a burst that scatters everything before the next idea, a crisp caption under each formed shape.
- **When to prefer it**: physical simulation, flow fields, and any scene where the motion itself is the explanation.

## Brand motion graphics — narrative explainers

Use for HTML Artifacts that tell a story rather than expose a parameter space.

- **Palette**: one dark field `#0c0b1d` for the whole piece, ink `#f2f1f7`, dim `#8f8da8`, pain `#ff5d5d`, and a single brand accent (read it from the content, not from a theme toggle).
- **Typography**: bold geometric sans headlines that pop in word by word, the key word in the accent; IBM Plex Mono for tiny labels.
- **Layout**: thin white hand-drawn line illustrations that draw themselves on; hand-drawn emphasis (a scribbled oval around a key word, a swoosh under a phrase); a thin "frustration" gauge that climbs across pain beats; proof drawn as line art (hatched bars, a big accent number, outline pill tags with one filled).
- **Motion**: a persuasion arc from pain to call to action, ending with the wordmark, an accent full stop and swoosh, and a glowing pill CTA.

## Editorial instrument — the Agentrans default

Use when none of the above fits, and always as the baseline for controls and readouts.

- Neutral surface, thin rules, compact titles, tabular measurements, one primary action, and color only for data or status. Avoid large gradients, pill-heavy controls, oversized heroes, and nested cards. Keep the main stage stable and animate only the object being explained.
