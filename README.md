# Dynamic Graphs

Zero-dependency Obsidian plugin: one view, four metadata-driven animations of your
notes over time. No npm, no build — just `main.js` + `manifest.json`.

## Modes

- **Timeline sweep** — notes plotted along a time axis; a sweep line reveals them.
- **Group growth** — one bar per group, height = notes assigned so far.
- **Graph timelapse** — force-directed canvas graph; nodes/edges fade in over time.
  Hover for a title, click to open the note. Optional group "hub" nodes.
- **Cumulative line** — running count of notes vs time.

The toolbar holds the live controls: mode, play/pause, restart, scrubber, a
slow↔fast speed slider (2–15 s per sweep), two font-size inputs (**label** = axis,
chart & tooltip; **node** = graph node labels; both 8–32), reload, and the gear (⚙).

## Settings (gear)

Everything below is configurable; defaults in parentheses.

- **Default mode** — which animation opens first.
- **Group color scheme** — palette for group colors (Tableau, pastel, bold, warm,
  cool, Viridis, rainbow).
- **Date property** — frontmatter key parsed as the timeline date (`date_added`).
  Accepts any `Date.parse`-able string or a Date.
- **Year property** — year metadata, e.g. publication year, mapped to Jan 1 (`year`).
- **Timeline x-axis** — position notes by the `Date property` or the `Year property`
  (the other is the fallback when the chosen one is missing).
- **Label property** — node label; falls back to the file name (`short_title`).
- **Group by** — `Obsidian tags` or a `Frontmatter property` (default: property
  named `buckets`). Drives grouping and color in every mode.
- **Folder scope** — limit to a folder, or blank for the whole vault.
- **Edge source** — `Only links under a heading` (default heading `References`) or
  `All outgoing links`.
- **Show group hub nodes** — in the graph, add one labeled hub per group and link
  its members to it.

Notes with no resolvable date are skipped. Edges connect notes whose link targets
also have a date and fall within scope.

## Example frontmatter

```yaml
---
date_added: 2022-02-18
year: 2022
short_title: Sample 08
buckets:
  - Cell Characterization
  - ROM Modeling
---
```

If you set **Group by → Obsidian tags**, drop the `buckets` property and just tag
notes normally (`#cell-characterization`, etc.).

## Enabling

1. Settings → Community plugins → turn off Restricted mode if needed.
2. Enable **Dynamic Graphs**.
3. Ribbon icon (line chart) or command palette → "Open Dynamic Graphs view".
4. Set the mapping in the gear (⚙) to match your vault, pick a mode, press ▶.
