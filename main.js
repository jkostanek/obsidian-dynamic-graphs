'use strict';

/*
 * Dynamic Graphs — a zero-dependency Obsidian plugin.
 * One view, four frontmatter-driven animation modes:
 *   - Timeline sweep
 *   - Bucket growth
 *   - Graph timelapse
 *   - Cumulative line
 *
 * Reads per-note frontmatter (date_added, year, short_title, buckets) and the
 * links under a "## References" heading. Renders on a <canvas>; no build step,
 * no npm — drop main.js + manifest.json into a plugin folder.
 */

const obsidian = require('obsidian');
const { Plugin, ItemView, Notice } = obsidian;

const VIEW_TYPE = 'dynamic-graphs-view';

const MODES = [
  { id: 'timeline', label: 'Timeline sweep' },
  { id: 'buckets', label: 'Bucket growth' },
  { id: 'graph', label: 'Graph timelapse' },
  { id: 'cumulative', label: 'Cumulative line' },
];

// Distinct, theme-agnostic palette for buckets.
const PALETTE = [
  '#4e79a7', '#f28e2b', '#59a14f', '#e15759', '#b07aa1',
  '#76b7b2', '#edc948', '#ff9da7', '#9c755f', '#bab0ac',
  '#6a8cc7', '#d4a017', '#52b788', '#c44e52',
];

// ---------------------------------------------------------------------------
// Helpers (pure)
// ---------------------------------------------------------------------------

function parseDate(v) {
  if (v == null) return null;
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') {
    // Bare number: treat as a year if plausible, else epoch ms.
    if (v > 1000 && v < 3000) return Date.UTC(v, 0, 1);
    return v;
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

function normBuckets(v) {
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

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

module.exports = class DynamicGraphsPlugin extends Plugin {
  async onload() {
    this.registerView(VIEW_TYPE, (leaf) => new DynamicGraphsView(leaf, this));

    this.addRibbonIcon('line-chart', 'Open Dynamic Graphs', () => this.activateView());

    this.addCommand({
      id: 'open-dynamic-graphs',
      name: 'Open Dynamic Graphs view',
      callback: () => this.activateView(),
    });
  }

  async onunload() {
    // Leaves are detached automatically; views clean up their own RAF in onClose.
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
// View
// ---------------------------------------------------------------------------

class DynamicGraphsView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.mode = 'timeline';
    this.playing = false;
    this.speed = 1;
    this.durationSec = 16; // base wall-clock seconds for one full sweep at 1x
    this.t = 0;
    this.tMin = 0;
    this.tMax = 1;
    this.range = 1;
    this.lastNow = 0;
    this.raf = null;
    this.data = null;
    this.hover = null; // {node, x, y} in graph mode
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

  async onOpen() {
    const root = this.contentEl;
    root.empty();
    root.style.display = 'flex';
    root.style.flexDirection = 'column';
    root.style.height = '100%';
    root.style.padding = '0';

    this.buildControls(root);

    // Canvas area
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
      fontSize: '12px',
      color: 'var(--text-normal)',
      display: 'none',
      whiteSpace: 'nowrap',
      zIndex: '10',
    });

    this.registerDomEvent(this.canvas, 'mousemove', (e) => this.onMouseMove(e));
    this.registerDomEvent(this.canvas, 'mouseleave', () => {
      this.hover = null;
      this.tooltip.style.display = 'none';
    });
    this.registerDomEvent(this.canvas, 'click', (e) => this.onClick(e));

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvasWrap);

    // Rebuild data when metadata changes (debounced).
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

  // --- Controls -----------------------------------------------------------

  buildControls(root) {
    const bar = root.createDiv();
    Object.assign(bar.style, {
      display: 'flex',
      alignItems: 'center',
      gap: '10px',
      flexWrap: 'wrap',
      padding: '8px 12px',
      borderBottom: '1px solid var(--background-modifier-border)',
    });

    // Mode selector
    const modeSel = bar.createEl('select');
    modeSel.addClass('dropdown');
    for (const m of MODES) {
      const opt = modeSel.createEl('option', { text: m.label });
      opt.value = m.id;
    }
    modeSel.value = this.mode;
    modeSel.onchange = () => {
      this.mode = modeSel.value;
    };

    // Restart
    const restartBtn = bar.createEl('button', { text: '⏮' });
    restartBtn.title = 'Restart';
    restartBtn.onclick = () => {
      this.t = this.tMin;
      this.syncScrubber();
    };

    // Play / pause
    const playBtn = bar.createEl('button', { text: '▶' });
    playBtn.title = 'Play / pause';
    this.playBtn = playBtn;
    playBtn.onclick = () => this.togglePlay();

    // Scrubber
    const scrub = bar.createEl('input');
    scrub.type = 'range';
    scrub.min = '0';
    scrub.max = '1000';
    scrub.value = '0';
    scrub.style.flex = '1 1 160px';
    this.scrub = scrub;
    scrub.oninput = () => {
      const f = parseInt(scrub.value, 10) / 1000;
      this.t = this.tMin + f * this.range;
    };

    // Date readout
    const dateLbl = bar.createEl('span');
    dateLbl.style.fontVariantNumeric = 'tabular-nums';
    dateLbl.style.minWidth = '92px';
    dateLbl.style.color = 'var(--text-muted)';
    this.dateLbl = dateLbl;

    // Speed
    const speedWrap = bar.createDiv();
    speedWrap.style.display = 'flex';
    speedWrap.style.alignItems = 'center';
    speedWrap.style.gap = '4px';
    speedWrap.createEl('span', { text: 'speed' }).style.color = 'var(--text-muted)';
    const speed = speedWrap.createEl('input');
    speed.type = 'range';
    speed.min = '0.25';
    speed.max = '4';
    speed.step = '0.25';
    speed.value = '1';
    speed.style.width = '90px';
    speed.oninput = () => {
      this.speed = parseFloat(speed.value);
    };

    // Reload
    const reloadBtn = bar.createEl('button', { text: '⟳' });
    reloadBtn.title = 'Reload data from vault';
    reloadBtn.onclick = () => {
      this.loadData();
      new Notice(`Dynamic Graphs: ${this.data.nodes.length} notes, ${this.data.edges.length} links`);
    };
  }

  togglePlay() {
    if (!this.data || this.range <= 0) return;
    if (!this.playing && this.t >= this.tMax) this.t = this.tMin; // replay from start
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

  loadData() {
    const app = this.plugin.app;
    const mc = app.metadataCache;
    const files = app.vault.getMarkdownFiles();

    const bucketSet = new Set();
    const bucketStubPath = new Map(); // bucket name -> file path
    for (const f of files) {
      if (f.path.startsWith('Buckets/')) {
        bucketSet.add(f.basename);
        bucketStubPath.set(f.basename, f.path);
      }
    }

    const nodes = [];
    const idx = new Map(); // path -> node index
    for (const f of files) {
      const cache = mc.getFileCache(f) || {};
      const fm = cache.frontmatter || {};
      const isBucket = f.path.startsWith('Buckets/');
      const buckets = normBuckets(fm.buckets);
      for (const b of buckets) bucketSet.add(b);

      let date = parseDate(fm.date_added);
      const year = parseYear(fm.year);
      if (date == null && year != null) date = Date.UTC(year, 0, 1);

      const node = {
        id: f.path,
        file: f,
        basename: f.basename,
        title: (fm.short_title && String(fm.short_title)) || f.basename,
        year,
        date, // may be null (resolved below for buckets / skipped for papers)
        buckets,
        isBucket,
        // layout state (graph mode)
        x: 0, y: 0, vx: 0, vy: 0, placed: false,
      };
      idx.set(f.path, nodes.length);
      nodes.push(node);
    }

    // Build edges: links under a "## References" heading (or all links if none),
    // plus paper -> bucket-stub edges from frontmatter.
    const edges = [];
    const seenEdge = new Set();
    const addEdge = (a, b) => {
      if (a === b) return;
      const key = a < b ? a + '|' + b : b + '|' + a;
      if (seenEdge.has(key)) return;
      seenEdge.add(key);
      edges.push({ s: a, t: b });
    };

    for (const f of files) {
      const cache = mc.getFileCache(f);
      if (!cache) continue;
      const links = cache.links || [];
      const headings = cache.headings || [];
      let refLine = -1;
      for (const h of headings) {
        if (/references/i.test(h.heading)) {
          refLine = h.position.start.line;
          break;
        }
      }
      for (const lk of links) {
        if (refLine >= 0 && lk.position.start.line < refLine) continue;
        const target = lk.link.split('#')[0].split('|')[0];
        const dest = mc.getFirstLinkpathDest(target, f.path);
        if (dest && idx.has(dest.path)) addEdge(f.path, dest.path);
      }
      // Frontmatter buckets -> stub nodes
      const fm = cache.frontmatter || {};
      for (const b of normBuckets(fm.buckets)) {
        const stub = bucketStubPath.get(b);
        if (stub) addEdge(f.path, stub);
      }
    }

    // Resolve bucket-stub appearance time: earliest connected paper.
    const dated = nodes.filter((n) => n.date != null);
    let gMin = dated.length ? Math.min(...dated.map((n) => n.date)) : Date.UTC(2000, 0, 1);
    let gMax = dated.length ? Math.max(...dated.map((n) => n.date)) : Date.UTC(2001, 0, 1);

    const earliestForStub = new Map();
    for (const e of edges) {
      const a = nodes[idx.get(e.s)];
      const b = nodes[idx.get(e.t)];
      for (const [stub, other] of [[a, b], [b, a]]) {
        if (stub.isBucket && other.date != null) {
          const cur = earliestForStub.get(stub.id);
          if (cur == null || other.date < cur) earliestForStub.set(stub.id, other.date);
        }
      }
    }
    for (const n of nodes) {
      if (n.isBucket && n.date == null) {
        n.date = earliestForStub.has(n.id) ? earliestForStub.get(n.id) : gMin;
      }
    }

    // Drop undated, non-bucket nodes (can't be placed in time).
    const keep = nodes.filter((n) => n.date != null);
    const keepIds = new Set(keep.map((n) => n.id));
    const keepEdges = edges.filter((e) => keepIds.has(e.s) && keepIds.has(e.t));

    // Recompute time range over kept nodes.
    if (keep.length) {
      gMin = Math.min(...keep.map((n) => n.date));
      gMax = Math.max(...keep.map((n) => n.date));
    }
    if (gMax <= gMin) gMax = gMin + 86400000; // avoid zero range

    // Bucket list + color map.
    const buckets = Array.from(bucketSet).sort();
    const bucketColor = new Map();
    buckets.forEach((b, i) => bucketColor.set(b, PALETTE[i % PALETTE.length]));

    // Seed graph layout deterministically on a circle.
    keep.forEach((n, i) => {
      const a = (i / Math.max(1, keep.length)) * Math.PI * 2;
      n.x = Math.cos(a) * 120;
      n.y = Math.sin(a) * 120;
      n.vx = 0;
      n.vy = 0;
    });

    // Precompute cumulative event times (papers only) for the cumulative mode.
    const paperDates = keep
      .filter((n) => !n.isBucket)
      .map((n) => n.date)
      .sort((a, b) => a - b);

    this.data = {
      nodes: keep,
      edges: keepEdges,
      idx: new Map(keep.map((n, i) => [n.id, i])),
      buckets,
      bucketColor,
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
      this.t += dt * (this.range / this.durationSec) * this.speed;
      if (this.t >= this.tMax) {
        this.t = this.tMax;
        this.playing = false;
        this.playBtn.setText('▶');
      }
      this.syncScrubber();
    }

    this.render();
    this.raf = requestAnimationFrame(this.frame);
  }

  // --- Rendering ----------------------------------------------------------

  css(name, fallback) {
    const v = getComputedStyle(this.canvas).getPropertyValue(name).trim();
    return v || fallback;
  }

  render() {
    const ctx = this.ctx;
    const W = this.W;
    const H = this.H;
    ctx.clearRect(0, 0, W, H);

    if (this.dateLbl) {
      this.dateLbl.setText(this.range > 0 ? fmtTime(this.t) : '—');
    }

    if (!this.data || !this.data.nodes.length) {
      ctx.fillStyle = this.css('--text-muted', '#888');
      ctx.font = '14px var(--font-interface, sans-serif)';
      ctx.textAlign = 'center';
      ctx.fillText('No dated notes found. Add date_added or year frontmatter, then reload (⟳).', W / 2, H / 2);
      return;
    }

    switch (this.mode) {
      case 'timeline':
        this.drawTimeline(ctx, W, H);
        break;
      case 'buckets':
        this.drawBuckets(ctx, W, H);
        break;
      case 'graph':
        this.drawGraph(ctx, W, H);
        break;
      case 'cumulative':
        this.drawCumulative(ctx, W, H);
        break;
    }
  }

  // Timeline sweep: notes plotted along an x=time axis, revealed by a sweep line.
  drawTimeline(ctx, W, H) {
    const padL = 40, padR = 20, padT = 30, padB = 36;
    const x0 = padL, x1 = W - padR;
    const y0 = padT, y1 = H - padB;
    const data = this.data;
    const txt = this.css('--text-muted', '#888');
    const accent = this.css('--interactive-accent', '#5b8def');

    const xOf = (ms) => x0 + ((ms - this.tMin) / this.range) * (x1 - x0);

    // Year gridlines.
    ctx.strokeStyle = this.css('--background-modifier-border', '#3a3a3a');
    ctx.fillStyle = txt;
    ctx.font = '11px var(--font-interface, sans-serif)';
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

    // Lay nodes into vertical lanes by index for separation.
    const papers = data.nodes.filter((n) => !n.isBucket);
    papers.sort((a, b) => a.date - b.date);
    const lanes = Math.max(1, Math.floor((y1 - y0) / 26));
    ctx.textAlign = 'left';
    papers.forEach((n, i) => {
      const reveal = smoothstep(n.date, n.date + this.range * 0.01, this.t);
      if (reveal <= 0.001) return;
      const xx = xOf(n.date);
      const lane = i % lanes;
      const yy = y0 + (lane + 0.5) * ((y1 - y0) / lanes);
      const col = data.bucketColor.get(n.buckets[0]) || accent;
      ctx.globalAlpha = reveal;
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.arc(xx, yy, 4, 0, Math.PI * 2);
      ctx.fill();
      // Label fades in slightly after the dot.
      const lab = smoothstep(n.date + this.range * 0.005, n.date + this.range * 0.03, this.t);
      ctx.globalAlpha = reveal * lab * 0.9;
      ctx.fillStyle = this.css('--text-normal', '#ddd');
      ctx.fillText(n.title, xx + 7, yy + 3);
    });
    ctx.globalAlpha = 1;

    // Sweep line.
    const sx = xOf(this.t);
    ctx.strokeStyle = accent;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(sx, y0 - 6);
    ctx.lineTo(sx, y1 + 6);
    ctx.stroke();
    ctx.lineWidth = 1;
  }

  // Bucket growth: a bar per bucket, height = #papers assigned with date <= t.
  drawBuckets(ctx, W, H) {
    const data = this.data;
    const buckets = data.buckets;
    if (!buckets.length) {
      ctx.fillStyle = this.css('--text-muted', '#888');
      ctx.textAlign = 'center';
      ctx.font = '14px var(--font-interface, sans-serif)';
      ctx.fillText('No buckets defined. Add a buckets: list to frontmatter.', W / 2, H / 2);
      return;
    }

    const counts = buckets.map(() => 0);
    let maxPossible = 1;
    const tally = buckets.map(() => 0);
    for (const n of data.nodes) {
      if (n.isBucket) continue;
      for (const b of n.buckets) {
        const bi = buckets.indexOf(b);
        if (bi < 0) continue;
        tally[bi]++;
        if (n.date <= this.t) counts[bi]++;
      }
    }
    maxPossible = Math.max(1, ...tally);

    const padL = 16, padR = 16, padT = 24, padB = 70;
    const x0 = padL, x1 = W - padR, y0 = padT, y1 = H - padB;
    const n = buckets.length;
    const gap = 14;
    const bw = Math.max(8, (x1 - x0 - gap * (n - 1)) / n);

    ctx.textAlign = 'center';
    ctx.font = '11px var(--font-interface, sans-serif)';
    for (let i = 0; i < n; i++) {
      const bx = x0 + i * (bw + gap);
      const frac = counts[i] / maxPossible;
      const bh = frac * (y1 - y0);
      const col = data.bucketColor.get(buckets[i]) || '#888';
      ctx.fillStyle = col;
      ctx.fillRect(bx, y1 - bh, bw, bh);

      // Count above bar.
      if (counts[i] > 0) {
        ctx.fillStyle = this.css('--text-normal', '#ddd');
        ctx.fillText(String(counts[i]), bx + bw / 2, y1 - bh - 5);
      }

      // Rotated label below.
      ctx.save();
      ctx.translate(bx + bw / 2, y1 + 8);
      ctx.rotate(-Math.PI / 4);
      ctx.fillStyle = this.css('--text-muted', '#aaa');
      ctx.textAlign = 'right';
      const label = buckets[i].length > 22 ? buckets[i].slice(0, 21) + '…' : buckets[i];
      ctx.fillText(label, 0, 0);
      ctx.restore();
      ctx.textAlign = 'center';
    }

    // Baseline.
    ctx.strokeStyle = this.css('--background-modifier-border', '#3a3a3a');
    ctx.beginPath();
    ctx.moveTo(x0, y1);
    ctx.lineTo(x1, y1);
    ctx.stroke();
  }

  // Graph timelapse: force-directed layout; nodes/edges fade in over time.
  drawGraph(ctx, W, H) {
    const data = this.data;
    const cx = W / 2, cy = H / 2;

    // Active nodes/edges at time t.
    const active = data.nodes.filter((n) => n.date <= this.t);
    const activeSet = new Set(active.map((n) => n.id));
    const activeEdges = data.edges.filter((e) => activeSet.has(e.s) && activeSet.has(e.t));

    // --- Force simulation step (only on active nodes) ---
    const k = 0.02; // spring
    const rep = 1400; // repulsion
    const center = 0.012;
    const damp = 0.86;

    for (let i = 0; i < active.length; i++) {
      const a = active[i];
      for (let j = i + 1; j < active.length; j++) {
        const b = active[j];
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1) d2 = 1;
        const f = rep / d2;
        const d = Math.sqrt(d2);
        const fx = (dx / d) * f;
        const fy = (dy / d) * f;
        a.vx += fx; a.vy += fy;
        b.vx -= fx; b.vy -= fy;
      }
    }
    for (const e of activeEdges) {
      const a = data.nodes[data.idx.get(e.s)];
      const b = data.nodes[data.idx.get(e.t)];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const target = 70;
      const f = (d - target) * k;
      const fx = (dx / d) * f;
      const fy = (dy / d) * f;
      a.vx += fx; a.vy += fy;
      b.vx -= fx; b.vy -= fy;
    }
    for (const a of active) {
      a.vx += -a.x * center;
      a.vy += -a.y * center;
      a.vx *= damp;
      a.vy *= damp;
      a.x += a.vx;
      a.y += a.vy;
    }

    // --- Draw ---
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
    ctx.font = '10px var(--font-interface, sans-serif)';
    for (const n of active) {
      const appear = smoothstep(n.date, n.date + this.range * 0.015, this.t);
      const r = (n.isBucket ? 9 : 5) * (0.4 + 0.6 * appear);
      const col = n.isBucket
        ? data.bucketColor.get(n.basename || n.title) || '#bbb'
        : data.bucketColor.get(n.buckets[0]) || this.css('--interactive-accent', '#5b8def');
      ctx.globalAlpha = appear;
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
      ctx.fill();
      if (n.isBucket) {
        ctx.fillStyle = this.css('--text-normal', '#eee');
        ctx.fillText(n.title, n.x, n.y - r - 3);
      }
    }
    ctx.globalAlpha = 1;
    ctx.restore();

    // Stash transform-adjusted positions for hit testing.
    this._graphOffset = { cx, cy };
  }

  // Cumulative line: running count of papers vs time, drawn up to t.
  drawCumulative(ctx, W, H) {
    const data = this.data;
    const dates = data.paperDates;
    if (!dates.length) {
      ctx.fillStyle = this.css('--text-muted', '#888');
      ctx.textAlign = 'center';
      ctx.font = '14px var(--font-interface, sans-serif)';
      ctx.fillText('No dated papers to count.', W / 2, H / 2);
      return;
    }

    const padL = 44, padR = 20, padT = 24, padB = 36;
    const x0 = padL, x1 = W - padR, y0 = padT, y1 = H - padB;
    const total = dates.length;
    const accent = this.css('--interactive-accent', '#5b8def');
    const txt = this.css('--text-muted', '#888');

    const xOf = (ms) => x0 + ((ms - this.tMin) / this.range) * (x1 - x0);
    const yOf = (c) => y1 - (c / total) * (y1 - y0);

    // Axes.
    ctx.strokeStyle = this.css('--background-modifier-border', '#3a3a3a');
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x0, y1);
    ctx.lineTo(x1, y1);
    ctx.stroke();

    // Y ticks.
    ctx.fillStyle = txt;
    ctx.font = '11px var(--font-interface, sans-serif)';
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

    // X (year) ticks.
    ctx.textAlign = 'center';
    const yStart = new Date(this.tMin).getUTCFullYear();
    const yEnd = new Date(this.tMax).getUTCFullYear();
    const yStep = Math.max(1, Math.ceil((yEnd - yStart) / 8));
    for (let y = yStart; y <= yEnd; y += yStep) {
      const xx = xOf(Date.UTC(y, 0, 1));
      ctx.fillText(String(y), xx, H - 12);
    }

    // Cumulative step path up to current t.
    ctx.strokeStyle = accent;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x0, yOf(0));
    let count = 0;
    let lastX = x0, lastY = yOf(0);
    for (const d of dates) {
      if (d > this.t) break;
      const xx = xOf(d);
      ctx.lineTo(xx, lastY); // horizontal to event
      count++;
      const yy = yOf(count);
      ctx.lineTo(xx, yy); // vertical step
      lastX = xx;
      lastY = yy;
    }
    // Extend flat to the current time marker.
    const tx = xOf(this.t);
    ctx.lineTo(tx, lastY);
    ctx.stroke();
    ctx.lineWidth = 1;

    // Marker.
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.arc(tx, lastY, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = this.css('--text-normal', '#ddd');
    ctx.textAlign = 'left';
    ctx.fillText(String(count), tx + 8, lastY - 6);
  }

  // --- Interaction (graph + timeline hit testing) -------------------------

  pickGraphNode(mx, my) {
    if (!this.data || this.mode !== 'graph' || !this._graphOffset) return null;
    const { cx, cy } = this._graphOffset;
    const lx = mx - cx;
    const ly = my - cy;
    let best = null;
    let bestD = 14 * 14;
    for (const n of this.data.nodes) {
      if (n.date > this.t) continue;
      const dx = n.x - lx;
      const dy = n.y - ly;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD) {
        bestD = d2;
        best = n;
      }
    }
    return best;
  }

  onMouseMove(e) {
    const rect = this.canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const node = this.pickGraphNode(mx, my);
    if (node) {
      this.tooltip.style.display = 'block';
      this.tooltip.style.left = mx + 12 + 'px';
      this.tooltip.style.top = my + 12 + 'px';
      this.tooltip.setText(node.title + (node.year ? ` (${node.year})` : ''));
      this.canvas.style.cursor = 'pointer';
    } else {
      this.tooltip.style.display = 'none';
      this.canvas.style.cursor = 'default';
    }
  }

  onClick(e) {
    const rect = this.canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const node = this.pickGraphNode(mx, my);
    if (node && node.file) {
      this.plugin.app.workspace.getLeaf(false).openFile(node.file);
    }
  }
}
