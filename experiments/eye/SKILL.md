---
name: eye
description: UI vision specialist. Use when judging a screenshot, comparing a render to a design, checking pixel fidelity, tuning visual style, or choosing between two UI versions. Read its numbers instead of eyeballing an image.
---

# eye

Do not estimate spacing, alignment, or color from a screenshot yourself. Run this, then fix what it reports.

`python3 ~/.agents/skills/eye/eye.py <command>`

| Command | Use it for | Cost |
|---|---|---|
| `measure shot.png --ref design.png --tokens tokens.json --scale 2` | Every pass of the fix loop | Free, about 3s |
| `review shot.png --ref design.png --brief "dense, warm, quiet" --scale 2` | Style, hierarchy, and density, once `measure` is clean | Two paid model calls |
| `ab a.png b.png --brief "reads calmer at a glance"` | Choosing between two versions | Four paid model calls |
| `check http://localhost:3000/dashboard --focus ".filter-bar" --ref last.png --scale 2` | The whole fix loop in one command: opens the page, screenshots the region, measures, gates | Free; add `--review` for two paid calls |

`--scale` must equal the screenshot's device pixel ratio, or every distance is wrong. `--ref` and `--tokens` are optional, and `--ref` is the strongest input you can give it.

## Loop

1. Capture at a fixed viewport and a known scale. Trigger the state under review first: hover, open menu, focused field, empty list, longest string.
2. Run `measure`. Fix everything it reports. Repeat until clean. On a served page, `check` does steps 1-2 in one command (below).
3. Run `review`. Act on `confirmed: true` findings. Treat single-model findings as leads, and look before acting on them.
4. Run `ab` only for a real choice. `no_call` means the answer changed with image order or the models split, so treat it as a tie.

## check: one command per edit

`check` opens the page itself, so there is no screenshot step:

```bash
python3 ~/.agents/skills/eye/eye.py check http://localhost:3000/dashboard \
    --focus ".filter-bar" --ref eye_out/crop.png --scale 2
```

It writes `eye_out/crop.png` (the region), `eye_out/page.png` (the viewport), `eye_out/annotated.png` (the tagged crop), and `eye_out/report.json` (the table), then prints the report as JSON.

Exit codes are the Redline gate: `0` clean, `1` red rows exist (`gate.red` in the report), `2` the tool itself failed (page did not load, `--focus` matched nothing, Playwright missing). Do not call a change done while the exit code is 1.

- Trigger the state first: `--click .menu`, `--fill "#q" "the longest string"`, `--hover .card`, `--wait-for .results`, and `--wait 500` to settle. Without `--focus`, the whole viewport is checked.
- `--ref` is the previous run's `crop.png`, so `regions` show what this edit changed. Diff regions are context, not red rows. Red rows are the `layout.*` flags, `low_contrast`, `off_token_colors`, and with `--review` the `confirmed: true` findings.
- `--scale` is the capture's device pixel ratio (default 2), so `*_pt` stay in CSS px.
- `check` needs Playwright once: `pip install playwright && python3 -m playwright install chromium`.

## Reading the output

- `*_pt` values are CSS px or points. Change the code by these numbers.
- Boxes are `[x, y, w, h]` in image pixels.
- `eye_out/annotated.png` shows every flag. Open it.
- `layout.near_misses`: surfaces that nearly line up.
- `layout.uneven_gaps`: repeated components spaced unevenly.
- `layout.padding_drift`: a component whose padding disagrees with its twins. Text padding is read from glyph ink, so it runs within 1pt of the CSS value and includes the border.
- `layout.clipped_ink`: text flush against one edge of a padded surface.
- `regions` with `--ref`: `moved_pt`, `fill`, and `ink` say what changed in each region.

## Blind spots

- One frame shows one state. Motion, hover, and anything below the fold stay invisible unless captured.
- Cards separated only by soft shadows merge into one block, so the layout checks go quiet on them. `--ref` still catches changes.
- Gradient or photo backgrounds behind content can do the same.
- Overlapping elements fall to the models.
- A clean `measure` means nothing drifted. It does not mean the design is good.

## Setup

`pip install pillow numpy scipy`, plus `OPENAI_API_KEY` and `GEMINI_API_KEY` for `review` and `ab`. `measure` needs no keys. `check` additionally needs Playwright and one browser: `pip install playwright && python3 -m playwright install chromium`. Override models with `EYE_OPENAI_MODEL` and `EYE_GEMINI_MODEL`.
