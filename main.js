'use strict';

/*
 * Dynamic Graphs — a zero-dependency Obsidian plugin.
 * One view, four metadata-driven animation modes:
 *   - Timeline sweep
 *   - Group growth
 *   - Graph timelapse
 *   - Cumulative line
 *
 * What drives each axis is configurable in settings (gear): the date property,
 * the label property, and whether grouping/color comes from Obsidian tags or a
 * named frontmatter property. Edges come from links (optionally only those under
 * a "References"-style heading). Renders on a <canvas>; no build step, no npm.
 */

const obsidian = require('obsidian');
const { Plugin, ItemView, Notice, PluginSettingTab, Setting, getAllTags } = obsidian;

const VIEW_TYPE = 'dynamic-graphs-view';

const MODES = [
  { id: 'timeline', label: 'Timeline sweep' },
  { id: 'groups', label: 'Group growth' },
  { id: 'graph', label: 'Graph timelapse' },
  { id: 'cumulative', label: 'Cumulative line' },
];

const DEFAULT_SETTINGS = {
  defaultMode: 'timeline',
  dateProp: 'date_added', // frontmatter key parsed as the timeline date
  yearProp: 'year', // year property (e.g. publication year)
  timeAxis: 'date', // 'date' (use dateProp) | 'year' (use yearProp)
  labelProp: 'short_title', // node label; falls back to file basename
  hoverProp: '', // frontmatter key for hover-tooltip text (e.g. full title); '' = label
  groupSource: 'property', // 'tags' (Obsidian tags) | 'property' (a frontmatter list)
  groupProp: 'buckets', // frontmatter property used when groupSource === 'property'
  folderScope: '', // '' = whole vault; otherwise limit to this folder
  edgeSource: 'references', // 'references' (links under the heading) | 'all' (all outgoing links)
  refHeading: 'References', // heading whose section supplies edges
  showGroupNodes: true, // synthesize a hub node per group in the graph mode
  showNodeLabels: true, // draw note labels in the graph
  showGroupLabels: true, // draw group hub labels in the graph
  durationSec: 8, // seconds for one full sweep (toolbar slow↔fast slider, 2–15)
  axisFontSize: 14, // size (px) for axis & chart labels (timeline/groups/cumulative)
  tooltipFontSize: 14, // size (px) for the hover tooltip (graph + timeline)
  nodeFontSize: 14, // size (px) for note labels (graph + timeline)
  groupFontSize: 14, // size (px) for group hub labels in the graph
  colorScheme: 'tableau', // group color palette (key of PALETTES)
};

const FONT_MIN = 8;
const FONT_MAX = 32;

// Distinct, theme-agnostic palettes for group color.
const PALETTES = {
  tableau: [
    '#4e79a7', '#f28e2b', '#59a14f', '#e15759', '#b07aa1',
    '#76b7b2', '#edc948', '#ff9da7', '#9c755f', '#bab0ac',
    '#6a8cc7', '#d4a017', '#52b788', '#c44e52',
  ],
  set2: [
    '#66c2a5', '#fc8d62', '#8da0cb', '#e78ac3', '#a6d854',
    '#ffd92f', '#e5c494', '#b3b3b3',
  ],
  bold: [
    '#e41a1c', '#377eb8', '#4daf4a', '#984ea3', '#ff7f00',
    '#a65628', '#f781bf', '#999999', '#dede00',
  ],
  warm: [
    '#7f0000', '#b30000', '#d7301f', '#ef6548', '#fc8d59',
    '#fdbb84', '#fdd49e', '#fee8c8',
  ],
  cool: [
    '#084594', '#2171b5', '#4292c6', '#6baed6', '#9ecae1',
    '#756bb1', '#9e9ac8', '#bcbddc',
  ],
  viridis: [
    '#440154', '#472d7b', '#3b528b', '#2c728e', '#21918c',
    '#28ae80', '#5ec962', '#addc30', '#fde725',
  ],
  rainbow: [
    '#e6194b', '#f58231', '#ffe119', '#3cb44b', '#42d4f4',
    '#4363d8', '#911eb4', '#f032e6', '#469990', '#9a6324',
  ],
};

const PALETTE_LABELS = {
  tableau: 'Tableau (default)',
  set2: 'Soft / pastel',
  bold: 'Bold',
  warm: 'Warm',
  cool: 'Cool',
  viridis: 'Viridis',
  rainbow: 'Rainbow',
};

// ---------------------------------------------------------------------------
// Helpers (pure)
// ---------------------------------------------------------------------------

function parseDate(v) {
  if (v == null) return null;
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') {
    if (v > 1000 && v < 3000) return Date.UTC(v, 0, 1); // bare plausible year
    return v; // epoch ms
  }
  const s = String(v).trim();
  if (!s) return null;
  const t = Date.parse(s);
  return isNaN(t) ? null : t;
}

function parseYear(v) {
  if (v == null) return null;
  if (typeof v === 'number' && isFinite(v)) return Math.trunc(v);
  const n = parseInt(String(v), 10);
  return isNaN(n) ? null : n;
}

function normList(v) {
  if (v == null) return [];
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  return String(v)
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

function fmtTime(ms) {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x;
}

function smoothstep(edge0, edge1, x) {
  if (edge1 === edge0) return x >= edge1 ? 1 : 0;
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

const GROUP_PREFIX = 'group::';

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

module.exports = class DynamicGraphsPlugin extends Plugin {
  async onload() {
    await this.loadSettings();

    // Enlarge/bold the view-header title for our view type.
    const styleEl = document.createElement('style');
    styleEl.textContent =
      `.workspace-leaf-content[data-type="${VIEW_TYPE}"] .view-header-title { font-size: 22px; font-weight: 700; }`;
    document.head.appendChild(styleEl);
    this.register(() => styleEl.remove());

    this.registerView(VIEW_TYPE, (leaf) => new DynamicGraphsView(leaf, this));
    this.addRibbonIcon('line-chart', 'Open Dynamic Graphs', () => this.activateView());
    this.addCommand({
      id: 'open-dynamic-graphs',
      name: 'Open Dynamic Graphs view',
      callback: () => this.activateView(),
    });
    this.addSettingTab(new DynamicGraphsSettingTab(this.app, this));
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(reload) {
    await this.saveData(this.settings);
    if (reload) this.refreshViews();
  }

  refreshViews() {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      const v = leaf.view;
      if (v && typeof v.reloadData === 'function') v.reloadData();
    }
  }

  async activateView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getLeaf(true);
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    workspace.revealLeaf(leaf);
  }
};

// ---------------------------------------------------------------------------
// Settings tab (the gear)
// ---------------------------------------------------------------------------

class DynamicGraphsSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;
    const save = (reload) => this.plugin.saveSettings(reload);

    new Setting(containerEl).setName('Display').setHeading();

    new Setting(containerEl)
      .setName('Default mode')
      .setDesc('Which animation opens first. You can still switch modes in the toolbar.')
      .addDropdown((d) => {
        for (const m of MODES) d.addOption(m.id, m.label);
        d.setValue(s.defaultMode).onChange((v) => {
          s.defaultMode = v;
          save(false);
        });
      });

    new Setting(containerEl)
      .setName('Group color scheme')
      .setDesc('Palette used to color groups across all four modes.')
      .addDropdown((d) => {
        for (const key of Object.keys(PALETTE_LABELS)) d.addOption(key, PALETTE_LABELS[key]);
        d.setValue(s.colorScheme).onChange((v) => {
          s.colorScheme = v;
          save(true);
        });
      });

    new Setting(containerEl).setName('Data mapping').setHeading();

    new Setting(containerEl)
      .setName('Date property')
      .setDesc('Frontmatter key parsed as the timeline date (any date string, or a Date).')
      .addText((t) =>
        t.setPlaceholder('date_added').setValue(s.dateProp).onChange((v) => {
          s.dateProp = v.trim() || DEFAULT_SETTINGS.dateProp;
          save(true);
        })
      );

    new Setting(containerEl)
      .setName('Year property')
      .setDesc('Year metadata, e.g. publication year (mapped to Jan 1).')
      .addText((t) =>
        t.setPlaceholder('year').setValue(s.yearProp).onChange((v) => {
          s.yearProp = v.trim();
          save(true);
        })
      );

    new Setting(containerEl)
      .setName('Timeline x-axis')
      .setDesc('Which property positions notes in time (all modes). The other is used as a fallback when the chosen one is missing.')
      .addDropdown((d) => {
        d.addOption('date', 'Date property');
        d.addOption('year', 'Year property');
        d.setValue(s.timeAxis).onChange((v) => {
          s.timeAxis = v;
          save(true);
        });
      });

    new Setting(containerEl)
      .setName('Label property')
      .setDesc('Frontmatter key for a note’s label. Falls back to the file name.')
      .addText((t) =>
        t.setPlaceholder('short_title').setValue(s.labelProp).onChange((v) => {
          s.labelProp = v.trim();
          save(true);
        })
      );

    new Setting(containerEl)
      .setName('Hover text property')
      .setDesc('Frontmatter key shown in the hover tooltip (e.g. a full title). Falls back to the label.')
      .addText((t) =>
        t.setPlaceholder('(label)').setValue(s.hoverProp).onChange((v) => {
          s.hoverProp = v.trim();
          save(true);
        })
      );

    new Setting(containerEl)
      .setName('Group by')
      .setDesc('What drives grouping and color across all four modes.')
      .addDropdown((d) => {
        d.addOption('tags', 'Obsidian tags');
        d.addOption('property', 'Frontmatter property');
        d.setValue(s.groupSource).onChange((v) => {
          s.groupSource = v;
          save(true);
          this.display(); // toggle visibility of the property field
        });
      });

    if (s.groupSource === 'property') {
      new Setting(containerEl)
        .setName('Group property')
        .setDesc('Frontmatter list (or comma string) whose values are the groups.')
        .addText((t) =>
          t.setPlaceholder('buckets').setValue(s.groupProp).onChange((v) => {
            s.groupProp = v.trim() || DEFAULT_SETTINGS.groupProp;
            save(true);
          })
        );
    }

    new Setting(containerEl)
      .setName('Folder scope')
      .setDesc('Limit to a folder (e.g. Papers). Leave blank for the whole vault.')
      .addText((t) =>
        t.setPlaceholder('(whole vault)').setValue(s.folderScope).onChange((v) => {
          s.folderScope = v.trim().replace(/\/+$/, '');
          save(true);
        })
      );

    new Setting(containerEl).setName('Graph edges').setHeading();

    new Setting(containerEl)
      .setName('Edge source')
      .setDesc('Which outgoing links become edges.')
      .addDropdown((d) => {
        d.addOption('references', 'Only links under a heading');
        d.addOption('all', 'All outgoing links');
        d.setValue(s.edgeSource).onChange((v) => {
          s.edgeSource = v;
          save(true);
          this.display();
        });
      });

    if (s.edgeSource === 'references') {
      new Setting(containerEl)
        .setName('Edge heading')
        .setDesc('Edges come only from links at/after this heading (case-insensitive, substring).')
        .addText((t) =>
          t.setPlaceholder('References').setValue(s.refHeading).onChange((v) => {
            s.refHeading = v.trim() || DEFAULT_SETTINGS.refHeading;
            save(true);
          })
        );
    }

    new Setting(containerEl)
      .setName('Show group hub nodes')
      .setDesc('In the graph, add one labeled hub node per group and link its members to it.')
      .addToggle((t) =>
        t.setValue(s.showGroupNodes).onChange((v) => {
          s.showGroupNodes = v;
          save(true);
        })
      );
  }
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

class DynamicGraphsView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.mode = plugin.settings.defaultMode;
    this.playing = false;
    this.durationSec = plugin.settings.durationSec;
    this.t = 0;
    this.tMin = 0;
    this.tMax = 1;
    this.range = 1;
    this.lastNow = 0;
    this.raf = null;
    this.data = null;
    this.drag = null; // {node, tx, ty, ox, oy, moved} while dragging a node
    this.frame = this.frame.bind(this);
  }

  getViewType() {
    return VIEW_TYPE;
  }
  getDisplayText() {
    return 'Dynamic Graphs';
  }
  getIcon() {
    return 'line-chart';
  }

  // Serialize state so the view can be restored (workspace reload, bookmarks).
  getState() {
    return { mode: this.mode };
  }

  async setState(state, result) {
    await super.setState(state, result);
    if (state && MODES.some((m) => m.id === state.mode)) {
      this.mode = state.mode;
      if (this.modeSel) this.modeSel.value = this.mode;
      this.applyModeVisibility();
    }
  }

  async onOpen() {
    const root = this.contentEl;
    root.empty();
    root.style.display = 'flex';
    root.style.flexDirection = 'column';
    root.style.height = '100%';
    root.style.padding = '0';

    this.buildControls(root);

    const canvasWrap = root.createDiv();
    canvasWrap.style.position = 'relative';
    canvasWrap.style.flex = '1 1 auto';
    canvasWrap.style.minHeight = '0';
    this.canvasWrap = canvasWrap;

    this.canvas = canvasWrap.createEl('canvas');
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    this.canvas.style.display = 'block';
    this.ctx = this.canvas.getContext('2d');

    this.tooltip = canvasWrap.createDiv();
    Object.assign(this.tooltip.style, {
      position: 'absolute',
      pointerEvents: 'none',
      background: 'var(--background-secondary)',
      border: '1px solid var(--background-modifier-border)',
      borderRadius: '4px',
      padding: '2px 6px',
      fontSize: this.plugin.settings.tooltipFontSize + 'px',
      color: 'var(--text-normal)',
      display: 'none',
      whiteSpace: 'nowrap',
      zIndex: '10',
    });

    this.registerDomEvent(this.canvas, 'mousedown', (e) => this.onMouseDown(e));
    this.registerDomEvent(this.canvas, 'mousemove', (e) => this.onMouseMove(e));
    this.registerDomEvent(this.canvas, 'mouseup', (e) => this.onMouseUp(e));
    this.registerDomEvent(this.canvas, 'mouseleave', () => {
      this.tooltip.style.display = 'none';
      this.drag = null;
    });

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvasWrap);

    this.registerEvent(
      this.plugin.app.metadataCache.on('resolved', () => this.scheduleReload())
    );

    this.loadData();
    this.resize();
    this.lastNow = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  async onClose() {
    if (this.raf != null) cancelAnimationFrame(this.raf);
    if (this.ro) this.ro.disconnect();
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
  }

  // Called by the plugin when settings change.
  reloadData() {
    this.durationSec = this.plugin.settings.durationSec;
    if (this.tooltip) this.tooltip.style.fontSize = this.plugin.settings.tooltipFontSize + 'px';
    if (this.schemeSel) this.schemeSel.value = this.plugin.settings.colorScheme;
    if (this.axisSel) this.axisSel.value = this.plugin.settings.timeAxis;
    this.loadData();
  }

  // --- Controls -----------------------------------------------------------

  buildControls(root) {
    const bar = root.createDiv();
    Object.assign(bar.style, {
      display: 'flex',
      alignItems: 'flex-start',
      gap: '10px',
      flexWrap: 'wrap',
      padding: '8px 12px',
      borderBottom: '1px solid var(--background-modifier-border)',
    });

    // --- small builders ---
    const mkGroup = (caption) => {
      const box = bar.createDiv();
      Object.assign(box.style, {
        display: 'flex', flexDirection: 'column', gap: '4px',
        border: '1px solid var(--background-modifier-border)',
        borderRadius: '6px', padding: '4px 8px',
      });
      const cap = box.createEl('div', { text: caption });
      Object.assign(cap.style, {
        fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.05em',
        fontWeight: '600', color: 'var(--text-muted)',
      });
      return box;
    };
    const mkRow = (parent) => {
      const row = parent.createDiv();
      Object.assign(row.style, { display: 'flex', alignItems: 'center', gap: '8px' });
      return row;
    };
    const addLabel = (parent, text) => {
      const sp = parent.createEl('span', { text });
      Object.assign(sp.style, { color: 'var(--text-muted)', minWidth: '70px' });
    };
    const addCheck = (parent, labelText, get, set, title) => {
      addLabel(parent, labelText);
      const cb = parent.createEl('input');
      cb.type = 'checkbox';
      cb.checked = get();
      cb.title = title;
      cb.onchange = () => {
        set(cb.checked);
        this.plugin.saveSettings(false);
      };
    };
    const addFontSlider = (parent, labelText, get, set, title) => {
      addLabel(parent, labelText);
      const inp = parent.createEl('input');
      inp.type = 'range';
      inp.min = String(FONT_MIN);
      inp.max = String(FONT_MAX);
      inp.step = '1';
      inp.value = String(get());
      inp.style.width = '80px';
      inp.title = title;
      const val = parent.createEl('span', { text: String(get()) });
      Object.assign(val.style, { color: 'var(--text-muted)', minWidth: '18px', fontVariantNumeric: 'tabular-nums' });
      inp.oninput = () => {
        let v = parseInt(inp.value, 10);
        if (isNaN(v)) return;
        v = clamp(v, FONT_MIN, FONT_MAX);
        set(v);
        val.setText(String(v));
        this.plugin.saveSettings(false);
      };
    };

    // Controls that only apply to some graph types; toggled on mode change.
    this.modeVis = [];
    const showIn = (el, modes, onDisplay) => {
      this.modeVis.push({ el, modes, onDisplay: onDisplay || 'flex' });
      return el;
    };

    // --- Playback group ---
    const playBox = mkGroup('Playback');
    const play = mkRow(playBox);

    const playBtn = play.createEl('button', { text: '▶' });
    playBtn.title = 'Play / pause';
    this.playBtn = playBtn;
    playBtn.onclick = () => this.togglePlay();

    const scrub = play.createEl('input');
    scrub.type = 'range';
    scrub.min = '0';
    scrub.max = '1000';
    scrub.value = '0';
    scrub.style.flex = '0 1 200px';
    this.scrub = scrub;
    scrub.oninput = () => {
      const f = parseInt(scrub.value, 10) / 1000;
      this.t = this.tMin + f * this.range;
    };

    const rewindBtn = play.createEl('button', { text: '⏮' });
    rewindBtn.title = 'Rewind to start';
    rewindBtn.onclick = () => {
      this.t = this.tMin;
      this.syncScrubber();
    };

    const resetBtn = play.createEl('button', { text: '↺' });
    resetBtn.title = 'Reset (stop and rewind to start)';
    resetBtn.onclick = () => {
      this.t = this.tMin;
      this.playing = false;
      this.playBtn.setText('▶');
      this.syncScrubber();
    };

    const dateLbl = play.createEl('span');
    dateLbl.style.fontVariantNumeric = 'tabular-nums';
    dateLbl.style.minWidth = '92px';
    dateLbl.style.color = 'var(--text-muted)';
    this.dateLbl = dateLbl;

    const speedWrap = play.createDiv();
    Object.assign(speedWrap.style, { display: 'flex', alignItems: 'center', gap: '4px' });
    speedWrap.createEl('span', { text: 'slow' }).style.color = 'var(--text-muted)';
    const speed = speedWrap.createEl('input');
    speed.type = 'range';
    speed.min = '2';
    speed.max = '15';
    speed.step = '1';
    // Runs slow→fast left-to-right; slider value maps to seconds as (17 - value).
    this.durationSec = clamp(this.durationSec, 2, 15);
    speed.value = String(17 - this.durationSec);
    speed.style.width = '100px';
    speed.title = 'Animation speed (2–15 s per sweep)';
    speed.oninput = () => {
      this.durationSec = 17 - parseInt(speed.value, 10);
      this.plugin.settings.durationSec = this.durationSec;
      this.plugin.saveSettings(false);
    };
    speedWrap.createEl('span', { text: 'fast' }).style.color = 'var(--text-muted)';

    // --- Graph group (graph type + color palette) ---
    const graphBox = mkGroup('Graph');
    const graph = mkRow(graphBox);

    const modeSel = graph.createEl('select');
    modeSel.addClass('dropdown');
    for (const m of MODES) {
      const opt = modeSel.createEl('option', { text: m.label });
      opt.value = m.id;
    }
    modeSel.value = this.mode;
    modeSel.title = 'Graph type';
    modeSel.onchange = () => {
      this.mode = modeSel.value;
      this.applyModeVisibility();
    };
    this.modeSel = modeSel;

    const schemeSel = graph.createEl('select');
    schemeSel.addClass('dropdown');
    for (const key of Object.keys(PALETTE_LABELS)) {
      const o = schemeSel.createEl('option', { text: PALETTE_LABELS[key] });
      o.value = key;
    }
    schemeSel.value = this.plugin.settings.colorScheme;
    schemeSel.title = 'Group color scheme';
    schemeSel.onchange = () => {
      this.plugin.settings.colorScheme = schemeSel.value;
      this.plugin.saveSettings(true);
    };
    this.schemeSel = schemeSel;
    showIn(schemeSel, ['timeline', 'groups', 'graph'], '');

    const axisWrap = graph.createDiv();
    Object.assign(axisWrap.style, { display: 'flex', alignItems: 'center', gap: '4px' });
    axisWrap.createEl('span', { text: 'time axis' }).style.color = 'var(--text-muted)';
    const axisSel = axisWrap.createEl('select');
    axisSel.addClass('dropdown');
    const optDate = axisSel.createEl('option', { text: 'Date' });
    optDate.value = 'date';
    const optYear = axisSel.createEl('option', { text: 'Year' });
    optYear.value = 'year';
    axisSel.value = this.plugin.settings.timeAxis;
    axisSel.title = 'Time x-axis: date or year';
    axisSel.onchange = () => {
      this.plugin.settings.timeAxis = axisSel.value;
      this.plugin.saveSettings(true);
    };
    this.axisSel = axisSel;
    showIn(axisWrap, ['timeline', 'groups', 'graph', 'cumulative'], 'flex');

    // --- trailing utility (top row, right) ---
    const util = bar.createDiv();
    Object.assign(util.style, { display: 'flex', alignItems: 'center', gap: '6px', marginLeft: 'auto' });

    const reloadBtn = util.createEl('button', { text: '⟳' });
    reloadBtn.title = 'Reload data from vault';
    reloadBtn.onclick = () => {
      this.loadData();
      new Notice(`Dynamic Graphs: ${this.data.nodes.length} notes, ${this.data.edges.length} links`);
    };

    const gear = util.createEl('button', { text: '⚙' });
    gear.title = 'Settings';
    gear.onclick = () => {
      const app = this.plugin.app;
      if (app.setting) {
        app.setting.open();
        app.setting.openTabById(this.plugin.manifest.id);
      }
    };

    // --- row break: label groups wrap to the next line ---
    const brk = bar.createDiv();
    Object.assign(brk.style, { flexBasis: '100%', height: '0' });

    // --- Node Labels group (graph only) ---
    const nodesBox = mkGroup('Node Labels');
    addCheck(mkRow(nodesBox), 'show', () => this.plugin.settings.showNodeLabels,
      (v) => (this.plugin.settings.showNodeLabels = v), 'Show note labels in the graph');
    addFontSlider(mkRow(nodesBox), 'label size', () => this.plugin.settings.nodeFontSize,
      (v) => (this.plugin.settings.nodeFontSize = v), 'Note label size (px)');
    addFontSlider(mkRow(nodesBox), 'hover size', () => this.plugin.settings.tooltipFontSize,
      (v) => {
        this.plugin.settings.tooltipFontSize = v;
        if (this.tooltip) this.tooltip.style.fontSize = v + 'px';
      }, 'Hover-tooltip text size (px)');
    showIn(nodesBox, ['graph', 'timeline'], 'flex');

    // --- Group Labels group (graph only) ---
    const groupsBox = mkGroup('Group Labels');
    addCheck(mkRow(groupsBox), 'show', () => this.plugin.settings.showGroupLabels,
      (v) => (this.plugin.settings.showGroupLabels = v), 'Show group hub labels in the graph');
    addFontSlider(mkRow(groupsBox), 'label size', () => this.plugin.settings.groupFontSize,
      (v) => (this.plugin.settings.groupFontSize = v), 'Group hub label size (px)');
    showIn(groupsBox, ['graph'], 'flex');

    // --- Text group (axis & chart text, non-graph modes) ---
    const textBox = mkGroup('Text');
    addFontSlider(mkRow(textBox), 'size', () => this.plugin.settings.axisFontSize,
      (v) => (this.plugin.settings.axisFontSize = v), 'Axis & chart text size (px)');
    showIn(textBox, ['timeline', 'groups', 'cumulative'], 'flex');

    this.applyModeVisibility();
  }

  applyModeVisibility() {
    if (!this.modeVis) return;
    for (const e of this.modeVis) {
      e.el.style.display = e.modes.includes(this.mode) ? e.onDisplay : 'none';
    }
  }

  togglePlay() {
    if (!this.data || this.range <= 0) return;
    if (!this.playing && this.t >= this.tMax) this.t = this.tMin;
    this.playing = !this.playing;
    this.playBtn.setText(this.playing ? '⏸' : '▶');
  }

  syncScrubber() {
    if (!this.scrub) return;
    const f = this.range > 0 ? (this.t - this.tMin) / this.range : 0;
    this.scrub.value = String(Math.round(clamp(f, 0, 1) * 1000));
  }

  scheduleReload() {
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => this.loadData(), 600);
  }

  // --- Data ---------------------------------------------------------------

  groupsFor(file, cache, fm) {
    const s = this.plugin.settings;
    if (s.groupSource === 'tags') {
      const tags = getAllTags(cache) || [];
      return Array.from(new Set(tags.map((t) => t.replace(/^#/, '')))).filter(Boolean);
    }
    return normList(fm[s.groupProp]);
  }

  loadData() {
    const s = this.plugin.settings;
    const app = this.plugin.app;
    const mc = app.metadataCache;

    let files = app.vault.getMarkdownFiles();
    if (s.folderScope) {
      const scope = s.folderScope;
      files = files.filter((f) => f.path === scope || f.path.startsWith(scope + '/'));
    }

    const fileNodes = [];
    const idx = new Map(); // path -> index into fileNodes
    const groupSet = new Set();

    for (const f of files) {
      const cache = mc.getFileCache(f) || {};
      const fm = cache.frontmatter || {};

      const year = s.yearProp ? parseYear(fm[s.yearProp]) : null;
      let date;
      if (s.timeAxis === 'year') {
        // Year is the axis; fall back to the date property if year is missing.
        date = year != null ? Date.UTC(year, 0, 1) : parseDate(fm[s.dateProp]);
      } else {
        // Date is the axis; fall back to the year (-> Jan 1) if the date is missing.
        date = parseDate(fm[s.dateProp]);
        if (date == null && year != null) date = Date.UTC(year, 0, 1);
      }
      if (date == null) continue; // can't place undated notes in time

      const groups = this.groupsFor(f, cache, fm);
      for (const g of groups) groupSet.add(g);

      const labelVal = s.labelProp && fm[s.labelProp];
      const label = (labelVal && String(labelVal)) || f.basename;
      const hoverVal = s.hoverProp && fm[s.hoverProp];
      idx.set(f.path, fileNodes.length);
      fileNodes.push({
        id: f.path,
        file: f,
        title: label,
        hover: (hoverVal && String(hoverVal)) || label,
        year,
        date,
        groups,
        isGroup: false,
        x: 0, y: 0, vx: 0, vy: 0,
      });
    }

    // Edges between file nodes.
    const edges = [];
    const seen = new Set();
    const addEdge = (a, b) => {
      if (a === b) return;
      const key = a < b ? a + '|' + b : b + '|' + a;
      if (seen.has(key)) return;
      seen.add(key);
      edges.push({ s: a, t: b });
    };

    for (const f of files) {
      if (!idx.has(f.path)) continue;
      const cache = mc.getFileCache(f);
      if (!cache) continue;
      const links = cache.links || [];
      let useLinks;
      if (s.edgeSource === 'all') {
        useLinks = links;
      } else {
        const headings = cache.headings || [];
        const needle = s.refHeading.toLowerCase();
        let refLine = -1;
        for (const h of headings) {
          if (h.heading.toLowerCase().includes(needle)) {
            refLine = h.position.start.line;
            break;
          }
        }
        useLinks = refLine < 0 ? [] : links.filter((l) => l.position.start.line >= refLine);
      }
      for (const lk of useLinks) {
        const target = lk.link.split('#')[0].split('|')[0];
        const dest = mc.getFirstLinkpathDest(target, f.path);
        if (dest && idx.has(dest.path)) addEdge(f.path, dest.path);
      }
    }

    // Time range over the file nodes.
    let gMin, gMax;
    if (fileNodes.length) {
      gMin = Math.min(...fileNodes.map((n) => n.date));
      gMax = Math.max(...fileNodes.map((n) => n.date));
    } else {
      gMin = Date.UTC(2000, 0, 1);
      gMax = Date.UTC(2001, 0, 1);
    }
    if (gMax <= gMin) gMax = gMin + 86400000;

    const groups = Array.from(groupSet).sort();
    const palette = PALETTES[s.colorScheme] || PALETTES.tableau;
    const groupColor = new Map();
    groups.forEach((g, i) => groupColor.set(g, palette[i % palette.length]));

    // Optional synthetic group hub nodes (graph mode).
    const groupNodes = [];
    if (s.showGroupNodes) {
      for (const g of groups) {
        const members = fileNodes.filter((n) => n.groups.includes(g));
        if (!members.length) continue;
        const date = Math.min(...members.map((n) => n.date));
        groupNodes.push({
          id: GROUP_PREFIX + g,
          file: null,
          title: g,
          year: null,
          date,
          groups: [g],
          isGroup: true,
          x: 0, y: 0, vx: 0, vy: 0,
        });
      }
    }

    const allNodes = fileNodes.concat(groupNodes);
    const allIdx = new Map(allNodes.map((n, i) => [n.id, i]));

    // Member -> hub edges.
    if (s.showGroupNodes) {
      for (const gn of groupNodes) {
        const g = gn.title;
        for (const n of fileNodes) {
          if (n.groups.includes(g)) addEdge(n.id, gn.id);
        }
      }
    }
    const keepEdges = edges.filter((e) => allIdx.has(e.s) && allIdx.has(e.t));

    // Preserve positions across reloads; seed only new nodes on a ring.
    const prevIdx = this.data ? this.data.idx : null;
    const prevNodes = this.data ? this.data.nodes : null;
    allNodes.forEach((n, i) => {
      const kept = prevIdx && prevIdx.has(n.id) ? prevNodes[prevIdx.get(n.id)] : null;
      if (kept) {
        n.x = kept.x;
        n.y = kept.y;
        n.vx = kept.vx;
        n.vy = kept.vy;
      } else {
        const a = (i / Math.max(1, allNodes.length)) * Math.PI * 2;
        n.x = Math.cos(a) * 140;
        n.y = Math.sin(a) * 140;
        n.vx = 0;
        n.vy = 0;
      }
    });

    const paperDates = fileNodes.map((n) => n.date).sort((a, b) => a - b);

    this.data = {
      nodes: allNodes,
      fileNodes,
      edges: keepEdges,
      idx: allIdx,
      groups,
      groupColor,
      paperDates,
    };

    this.tMin = gMin;
    this.tMax = gMax;
    this.range = gMax - gMin;
    if (this.t < this.tMin || this.t > this.tMax) this.t = this.tMin;
    this.syncScrubber();
  }

  // --- Sizing -------------------------------------------------------------

  resize() {
    if (!this.canvas) return;
    const rect = this.canvasWrap.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.W = Math.max(1, rect.width);
    this.H = Math.max(1, rect.height);
    this.canvas.width = Math.round(this.W * dpr);
    this.canvas.height = Math.round(this.H * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // --- Animation loop -----------------------------------------------------

  frame(now) {
    const dt = Math.min(0.05, (now - this.lastNow) / 1000);
    this.lastNow = now;

    if (this.playing && this.range > 0) {
      this.t += dt * (this.range / this.durationSec);
      if (this.t >= this.tMax) {
        this.t = this.tMax;
        this.playing = false;
        this.playBtn.setText('▶');
      }
      this.syncScrubber();
    }

    try {
      this.render();
    } catch (e) {
      console.error('Dynamic Graphs: render error', e);
    }
    this.raf = requestAnimationFrame(this.frame);
  }

  // --- Rendering ----------------------------------------------------------

  css(name, fallback) {
    const v = getComputedStyle(this.canvas).getPropertyValue(name).trim();
    return v || fallback;
  }

  fontFamily() {
    // Canvas ctx.font can't resolve CSS var(); use the resolved family or a literal.
    const f = this.css('--font-interface', '').trim();
    return f && !f.includes('var(') ? f : 'sans-serif';
  }

  font(delta) {
    const sz = this.plugin.settings.axisFontSize;
    return `${Math.max(8, sz + (delta || 0))}px ${this.fontFamily()}`;
  }

  nodeFont() {
    return `${Math.max(8, this.plugin.settings.nodeFontSize)}px ${this.fontFamily()}`;
  }

  groupFont() {
    return `${Math.max(8, this.plugin.settings.groupFontSize)}px ${this.fontFamily()}`;
  }

  colorOf(node) {
    const g = node.groups && node.groups[0];
    return (g && this.data.groupColor.get(g)) || this.css('--interactive-accent', '#5b8def');
  }

  render() {
    const ctx = this.ctx;
    const W = this.W;
    const H = this.H;
    ctx.clearRect(0, 0, W, H);

    if (this.dateLbl) this.dateLbl.setText(this.range > 0 ? fmtTime(this.t) : '—');

    if (!this.data || !this.data.fileNodes.length) {
      ctx.fillStyle = this.css('--text-muted', '#888');
      ctx.font = this.font(1);
      ctx.textAlign = 'center';
      ctx.fillText(
        'No dated notes found. Check the date/group mapping in settings (⚙), then reload (⟳).',
        W / 2,
        H / 2
      );
      return;
    }

    switch (this.mode) {
      case 'timeline':
        this.drawTimeline(ctx, W, H);
        break;
      case 'groups':
        this.drawGroups(ctx, W, H);
        break;
      case 'graph':
        this.drawGraph(ctx, W, H);
        break;
      case 'cumulative':
        this.drawCumulative(ctx, W, H);
        break;
    }
  }

  drawTimeline(ctx, W, H) {
    const padL = 40, padR = 20, padT = 30, padB = 36;
    const x0 = padL, x1 = W - padR, y0 = padT, y1 = H - padB;
    const accent = this.css('--interactive-accent', '#5b8def');
    const xOf = (ms) => x0 + ((ms - this.tMin) / this.range) * (x1 - x0);

    ctx.strokeStyle = this.css('--background-modifier-border', '#3a3a3a');
    ctx.fillStyle = this.css('--text-muted', '#888');
    ctx.font = this.font(-1);
    ctx.textAlign = 'center';
    const yStart = new Date(this.tMin).getUTCFullYear();
    const yEnd = new Date(this.tMax).getUTCFullYear();
    const yStep = Math.max(1, Math.ceil((yEnd - yStart) / 12));
    for (let y = yStart; y <= yEnd; y += yStep) {
      const xx = xOf(Date.UTC(y, 0, 1));
      ctx.globalAlpha = 0.35;
      ctx.beginPath();
      ctx.moveTo(xx, y0);
      ctx.lineTo(xx, y1);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillText(String(y), xx, H - 14);
    }

    const papers = this.data.fileNodes.slice().sort((a, b) => a.date - b.date);
    const lanes = Math.max(1, Math.floor((y1 - y0) / 26));
    const showLabels = this.plugin.settings.showNodeLabels;
    this._timelineHits = [];
    ctx.textAlign = 'left';
    ctx.font = this.nodeFont();
    papers.forEach((n, i) => {
      const reveal = smoothstep(n.date - this.range * 0.012, n.date, this.t);
      if (reveal <= 0.001) return;
      const xx = xOf(n.date);
      const lane = i % lanes;
      const yy = y0 + (lane + 0.5) * ((y1 - y0) / lanes);
      this._timelineHits.push({ node: n, x: xx, y: yy });
      ctx.globalAlpha = reveal;
      ctx.fillStyle = this.colorOf(n);
      ctx.beginPath();
      ctx.arc(xx, yy, 4, 0, Math.PI * 2);
      ctx.fill();
      if (showLabels) {
        ctx.globalAlpha = reveal * 0.9;
        ctx.fillStyle = this.css('--text-normal', '#ddd');
        ctx.fillText(n.title, xx + 7, yy + 3);
      }
    });
    ctx.globalAlpha = 1;

    const sx = xOf(this.t);
    ctx.strokeStyle = accent;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(sx, y0 - 6);
    ctx.lineTo(sx, y1 + 6);
    ctx.stroke();
    ctx.lineWidth = 1;
  }

  drawGroups(ctx, W, H) {
    const data = this.data;
    const groups = data.groups;
    if (!groups.length) {
      ctx.fillStyle = this.css('--text-muted', '#888');
      ctx.textAlign = 'center';
      ctx.font = this.font(1);
      ctx.fillText('No groups found. Check the "Group by" setting (⚙).', W / 2, H / 2);
      return;
    }

    const counts = groups.map(() => 0);
    const totals = groups.map(() => 0);
    for (const n of data.fileNodes) {
      for (const g of n.groups) {
        const gi = groups.indexOf(g);
        if (gi < 0) continue;
        totals[gi]++;
        if (n.date <= this.t) counts[gi]++;
      }
    }
    const maxPossible = Math.max(1, ...totals);

    const padT = 24, padR = 16, gap = 14;
    const n = groups.length;

    // Measure labels so the bottom/left margins scale with the font (rotated 45°).
    ctx.font = this.font();
    ctx.textAlign = 'center';
    const labels = groups.map((g) => (g.length > 28 ? g.slice(0, 27) + '…' : g));
    let maxLabelW = 0;
    for (const l of labels) maxLabelW = Math.max(maxLabelW, ctx.measureText(l).width);
    const diag = maxLabelW * Math.SQRT1_2;
    const padB = Math.ceil(diag) + this.plugin.settings.axisFontSize + 16;
    let padL = 16;
    let bw = Math.max(8, (W - padL - padR - gap * (n - 1)) / n);
    const overflowL = diag - (padL + bw / 2); // leftmost label extending past the edge
    if (overflowL > 0) {
      padL += Math.ceil(overflowL) + 8;
      bw = Math.max(8, (W - padL - padR - gap * (n - 1)) / n);
    }
    const x0 = padL, x1 = W - padR, y0 = padT, y1 = H - padB;

    for (let i = 0; i < n; i++) {
      const bx = x0 + i * (bw + gap);
      const bh = (counts[i] / maxPossible) * (y1 - y0);
      ctx.fillStyle = data.groupColor.get(groups[i]) || '#888';
      ctx.fillRect(bx, y1 - bh, bw, bh);
      if (counts[i] > 0) {
        ctx.fillStyle = this.css('--text-normal', '#ddd');
        ctx.fillText(String(counts[i]), bx + bw / 2, y1 - bh - 6);
      }
      ctx.save();
      ctx.translate(bx + bw / 2, y1 + 8);
      ctx.rotate(-Math.PI / 4);
      ctx.fillStyle = this.css('--text-muted', '#aaa');
      ctx.textAlign = 'right';
      ctx.fillText(labels[i], 0, 0);
      ctx.restore();
      ctx.textAlign = 'center';
    }

    ctx.strokeStyle = this.css('--background-modifier-border', '#3a3a3a');
    ctx.beginPath();
    ctx.moveTo(x0, y1);
    ctx.lineTo(x1, y1);
    ctx.stroke();
  }

  drawGraph(ctx, W, H) {
    const data = this.data;
    const cx = W / 2, cy = H / 2;

    const fade = this.range * 0.015;
    const active = data.nodes.filter((n) => n.date <= this.t + fade);
    const activeSet = new Set(active.map((n) => n.id));
    const activeEdges = data.edges.filter((e) => activeSet.has(e.s) && activeSet.has(e.t));

    const k = 0.02, rep = 1800, center = 0.012, damp = 0.88;
    // Safeguards against runaway physics on load / overlap / state changes.
    const MAXF = 40, MAXV = 40, BOUND = 4000;
    for (let i = 0; i < active.length; i++) {
      const a = active[i];
      for (let j = i + 1; j < active.length; j++) {
        const b = active[j];
        let dx = a.x - b.x, dy = a.y - b.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1) d2 = 1;
        const d = Math.sqrt(d2);
        let f = rep / d2;
        if (f > MAXF) f = MAXF; // cap repulsion when nodes overlap
        const fx = (dx / d) * f, fy = (dy / d) * f;
        a.vx += fx; a.vy += fy;
        b.vx -= fx; b.vy -= fy;
      }
    }
    for (const e of activeEdges) {
      const a = data.nodes[data.idx.get(e.s)];
      const b = data.nodes[data.idx.get(e.t)];
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      let f = (d - 85) * k;
      if (f > MAXF) f = MAXF; else if (f < -MAXF) f = -MAXF;
      const fx = (dx / d) * f, fy = (dy / d) * f;
      a.vx += fx; a.vy += fy;
      b.vx -= fx; b.vy -= fy;
    }
    for (const a of active) {
      a.vx += -a.x * center;
      a.vy += -a.y * center;
      a.vx *= damp;
      a.vy *= damp;
      const sp = Math.hypot(a.vx, a.vy);
      if (sp > MAXV) { const s = MAXV / sp; a.vx *= s; a.vy *= s; } // clamp speed
      a.x += a.vx;
      a.y += a.vy;
      if (!isFinite(a.x) || !isFinite(a.y)) { a.x = 0; a.y = 0; a.vx = 0; a.vy = 0; }
      else { a.x = clamp(a.x, -BOUND, BOUND); a.y = clamp(a.y, -BOUND, BOUND); }
    }

    // Pin the dragged node to the cursor so the network flows around it.
    if (this.drag && this.drag.moved && activeSet.has(this.drag.node.id)) {
      const dn = this.drag.node;
      dn.x = this.drag.tx;
      dn.y = this.drag.ty;
      dn.vx = 0;
      dn.vy = 0;
    }

    ctx.save();
    ctx.translate(cx, cy);

    ctx.strokeStyle = this.css('--background-modifier-border', '#555');
    ctx.globalAlpha = 0.5;
    ctx.beginPath();
    for (const e of activeEdges) {
      const a = data.nodes[data.idx.get(e.s)];
      const b = data.nodes[data.idx.get(e.t)];
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;

    ctx.textAlign = 'center';
    const textCol = this.css('--text-normal', '#eee');
    for (const n of active) {
      const appear = smoothstep(n.date - fade, n.date, this.t);
      const r = (n.isGroup ? 9 : 5) * (0.4 + 0.6 * appear);
      ctx.globalAlpha = appear;
      ctx.fillStyle = this.colorOf(n);
      ctx.beginPath();
      ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
      ctx.fill();
      // Label nodes; hubs above (full size), notes below (one step down).
      const showLabel = n.isGroup
        ? this.plugin.settings.showGroupLabels
        : this.plugin.settings.showNodeLabels;
      if (showLabel) {
        ctx.font = n.isGroup ? this.groupFont() : this.nodeFont();
        ctx.fillStyle = textCol;
        const sz = n.isGroup ? this.plugin.settings.groupFontSize : this.plugin.settings.nodeFontSize;
        const dy = n.isGroup ? -r - 4 : r + sz;
        ctx.fillText(n.title, n.x, n.y + dy);
      }
    }
    ctx.globalAlpha = 1;
    ctx.restore();

    this._graphOffset = { cx, cy };
  }

  drawCumulative(ctx, W, H) {
    const dates = this.data.paperDates;
    if (!dates.length) return;

    const padL = 44, padR = 20, padT = 24, padB = 36;
    const x0 = padL, x1 = W - padR, y0 = padT, y1 = H - padB;
    const total = dates.length;
    const accent = this.css('--interactive-accent', '#5b8def');
    const txt = this.css('--text-muted', '#888');
    const xOf = (ms) => x0 + ((ms - this.tMin) / this.range) * (x1 - x0);
    const yOf = (c) => y1 - (c / total) * (y1 - y0);

    ctx.strokeStyle = this.css('--background-modifier-border', '#3a3a3a');
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x0, y1);
    ctx.lineTo(x1, y1);
    ctx.stroke();

    ctx.fillStyle = txt;
    ctx.font = this.font(-1);
    ctx.textAlign = 'right';
    const yTicks = Math.min(total, 5);
    for (let i = 0; i <= yTicks; i++) {
      const c = Math.round((total * i) / yTicks);
      const yy = yOf(c);
      ctx.fillText(String(c), x0 - 6, yy + 3);
      ctx.globalAlpha = 0.25;
      ctx.beginPath();
      ctx.moveTo(x0, yy);
      ctx.lineTo(x1, yy);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    ctx.textAlign = 'center';
    const yStart = new Date(this.tMin).getUTCFullYear();
    const yEnd = new Date(this.tMax).getUTCFullYear();
    const yStep = Math.max(1, Math.ceil((yEnd - yStart) / 8));
    for (let y = yStart; y <= yEnd; y += yStep) {
      ctx.fillText(String(y), xOf(Date.UTC(y, 0, 1)), H - 12);
    }

    ctx.strokeStyle = accent;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x0, yOf(0));
    let count = 0;
    let lastY = yOf(0);
    for (const d of dates) {
      if (d > this.t) break;
      const xx = xOf(d);
      ctx.lineTo(xx, lastY);
      count++;
      lastY = yOf(count);
      ctx.lineTo(xx, lastY);
    }
    const tx = xOf(this.t);
    ctx.lineTo(tx, lastY);
    ctx.stroke();
    ctx.lineWidth = 1;

    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.arc(tx, lastY, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = this.css('--text-normal', '#ddd');
    ctx.textAlign = 'left';
    ctx.fillText(String(count), tx + 8, lastY - 6);
  }

  // --- Interaction --------------------------------------------------------

  pickGraphNode(mx, my) {
    if (!this.data || this.mode !== 'graph' || !this._graphOffset) return null;
    const { cx, cy } = this._graphOffset;
    const lx = mx - cx, ly = my - cy;
    let best = null;
    let bestD = 14 * 14;
    for (const n of this.data.nodes) {
      if (n.date > this.t) continue;
      const dx = n.x - lx, dy = n.y - ly;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD) {
        bestD = d2;
        best = n;
      }
    }
    return best;
  }

  pickTimelineNode(mx, my) {
    if (!this._timelineHits) return null;
    let best = null;
    let bestD = 12 * 12;
    for (const h of this._timelineHits) {
      const dx = h.x - mx, dy = h.y - my;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD) {
        bestD = d2;
        best = h.node;
      }
    }
    return best;
  }

  pickNode(mx, my) {
    if (this.mode === 'graph') return this.pickGraphNode(mx, my);
    if (this.mode === 'timeline') return this.pickTimelineNode(mx, my);
    return null;
  }

  localPoint(e) {
    const rect = this.canvas.getBoundingClientRect();
    return { mx: e.clientX - rect.left, my: e.clientY - rect.top };
  }

  onMouseDown(e) {
    if (e.button !== 0) return;
    const { mx, my } = this.localPoint(e);
    const node = this.pickNode(mx, my);
    if (!node) {
      this.drag = null;
      return;
    }
    if (this.mode === 'graph' && this._graphOffset) {
      const { cx, cy } = this._graphOffset;
      const lx = mx - cx, ly = my - cy;
      this.drag = { node, mode: 'graph', sx: mx, sy: my, ox: node.x - lx, oy: node.y - ly, tx: node.x, ty: node.y, moved: false };
    } else {
      // Timeline: press to click-open; no dragging.
      this.drag = { node, mode: this.mode, sx: mx, sy: my, moved: false };
    }
  }

  onMouseMove(e) {
    const { mx, my } = this.localPoint(e);

    // Graph node drag: pin to cursor.
    if (this.drag && this.drag.mode === 'graph' && this._graphOffset) {
      const { cx, cy } = this._graphOffset;
      this.drag.tx = mx - cx + this.drag.ox;
      this.drag.ty = my - cy + this.drag.oy;
      if (!this.drag.moved && Math.hypot(mx - this.drag.sx, my - this.drag.sy) > 4) {
        this.drag.moved = true;
      }
      this.tooltip.style.display = 'none';
      this.canvas.style.cursor = 'grabbing';
      return;
    }
    // Track movement so a moved press isn't treated as a click.
    if (this.drag && !this.drag.moved && Math.hypot(mx - this.drag.sx, my - this.drag.sy) > 4) {
      this.drag.moved = true;
    }

    // Hover tooltip (graph + timeline).
    const node = this.pickNode(mx, my);
    if (node) {
      this.tooltip.style.display = 'block';
      this.tooltip.style.left = mx + 12 + 'px';
      this.tooltip.style.top = my + 12 + 'px';
      this.tooltip.setText((node.hover || node.title) + (node.year ? ` (${node.year})` : ''));
      this.canvas.style.cursor = node.file ? 'pointer' : 'default';
    } else {
      this.tooltip.style.display = 'none';
      this.canvas.style.cursor = 'default';
    }
  }

  onMouseUp() {
    if (!this.drag) return;
    const wasClick = !this.drag.moved;
    const node = this.drag.node;
    this.drag = null;
    // A press without movement is a click → open the note.
    if (wasClick && node && node.file) {
      this.plugin.app.workspace.getLeaf(false).openFile(node.file);
    }
  }
}
