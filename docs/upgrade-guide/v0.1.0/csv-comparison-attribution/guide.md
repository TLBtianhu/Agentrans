---
kind: upgrade-guide
description: "Imported CSV comparison facts record `attribution: 'user-imported'` instead of the retired field name."
---

# Record imported CSV comparisons with `attribution`

English | [中文](guide.zh.md)

## Change

A CSV comparison imported from a JSON file, and every reuse of it, now records `attribution: 'user-imported'` in the comparison facts of the sent question and of the Host draft. The same field already records `attribution: 'program-reported'` for HTML readings. The exported comparison HTML marks the imported notice with `data-csv-compare-attribution`, and the Web card uses `data-csv-comparison-attribution`.

Questions sent from `0.1.0-test.20261119.1` with an imported comparison carry the retired field name. The reader no longer recognizes those comparison blocks: the message stays in the transcript as text, without its comparison card, replay, download or reuse actions. Comparisons calculated in the same Session, and portable JSON comparison files, are unaffected. A comparison draft saved under the retired field is moved aside when the Host opens its draft store and is not restored to the composer.

## Migration

1. Import the original comparison JSON file again in a Session and attach the reviewed page to a new question. The new message records `attribution` and offers the card actions again.
2. Update scripts or selectors that read the exported HTML or the Web card to `data-csv-compare-attribution` and `data-csv-comparison-attribution`.
3. Confirm with **Replay attached comparison** on the new message: the replay shows the **User imported** notice.
