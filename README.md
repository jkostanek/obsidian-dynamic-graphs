# Dynamic Graphs

Zero-dependency Obsidian plugin: one view, four frontmatter-driven animations of
your notes over time. No npm, no build — just `main.js` + `manifest.json`.

## Modes

- **Timeline sweep** — notes plotted along a time axis; a sweep line reveals them.
- **Bucket growth** — one bar per bucket, height = papers assigned so far.
- **Graph timelapse** — force-directed canvas graph; nodes/edges fade in over time.
  Hover for title, click to open the note.
- **Cumulative line** — running count of papers vs time.

## Frontmatter contract

```yaml
---
date_added: 2022-02-18   # preferred time axis (any Date.parse-able string / Date)
year: 2022               # fallback when date_added is absent (-> Jan 1)
short_title: Sample 08   # node label; falls back to file basename
buckets:                 # list or comma string; categories for bucket/color
  - Cell Characterization
  - ROM Modeling
---
```

- **Edges** come from links under a `## References` heading (matched case-insensitively;
  if no such heading exists, all outgoing links are used), plus automatic
  paper → bucket-stub links for each `buckets:` entry that matches a file in `Buckets/`.
- **Bucket stubs** live in `Buckets/` (filename = bucket name). They appear as larger,
  labeled nodes in the graph and inherit the earliest date of any note linked to them.

## Enabling

1. Open this vault in Obsidian.
2. Settings → Community plugins → turn off Restricted mode if needed.
3. Enable **Dynamic Graphs**.
4. Ribbon icon (line chart) or command palette → "Open Dynamic Graphs view".
5. Pick a mode, press ▶. Scrub/speed controls are in the toolbar; ⟳ reloads from the vault.

## Sample data

`Papers/` and `Buckets/` hold obviously-synthetic samples (`Sample 01`…) so the four
modes run immediately. Delete both folders once you point the plugin at real notes —
nothing in the plugin depends on them.
