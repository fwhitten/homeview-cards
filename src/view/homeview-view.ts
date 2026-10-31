import { LitElement, css, html, nothing, type PropertyValues } from 'lit';
import { property, state } from 'lit/decorators.js';
import type { HomeAssistant, LovelaceCard, LovelaceCardConfig } from '../core/types';
import { resolveMode, store, type Appearance, type Mode } from '../core/store';
import { defineElement } from '../core/register';
import { fireEvent } from '../core/events';
import type { Chip } from '../cards/chips-card';
import type { AmbientConfig } from '../cards/ambient-card';
import '../cards/chips-editor';

type Wallpaper = string | { light?: string; dark?: string; night?: string };

export interface HomeViewViewConfig {
  type?: string;
  title?: string;
  appearance?: Appearance;
  night_entity?: string;
  /** One image for every mode, or one per mode. */
  wallpaper?: Wallpaper;
  /** Grid size. `auto` (the default) fits ~200px tiles to the screen: 6 × 4 on a landscape iPad Pro. */
  columns?: number | 'auto';
  rows?: number | 'auto';
  /** How many screens to swipe between, at least. Cards that don't fit add more. */
  screens?: number;
  header?: { greeting?: boolean; style?: 'full' | 'compact'; chips?: Chip[] };
  ambient?: Omit<AmbientConfig, 'type'>;
  /** Same options as the HomeView notifications card. */
  notifications?: Record<string, unknown>;
}

/** Where a card sits on one grid size. */
interface GridPos {
  screen?: number;
  column: number;
  row: number;
}

interface ViewLayout {
  column_span?: number;
  row_span?: number;
  /** Positions per grid size, keyed "6x4". A grid without an entry packs the card automatically. */
  grids?: Record<string, GridPos>;
  /** Earlier single positions, from before grids: used until the card is arranged, when they fit. */
  screen?: number;
  column?: number;
  row?: number;
}

interface Lovelace {
  editMode: boolean;
  config: { views: Array<Record<string, any>> };
  rawConfig?: { views: Array<Record<string, any>> };
  saveConfig?: (config: unknown) => Promise<void>;
}

interface HuiCard extends LovelaceCard {
  config?: LovelaceCardConfig;
}

interface Box {
  screen: number;
  column: number;
  row: number;
  colSpan: number;
  rowSpan: number;
}

interface Placed extends Box {
  index: number;
}

interface Drag {
  index: number;
  mode: 'move' | 'resize';
  page: HTMLElement;
  startX: number;
  startY: number;
  placed: Placed;
  moved: boolean;
  target?: Box;
}

type Sheet = 'position' | 'wallpaper' | 'header';

const TILE = 200;
const GAP = 20;
const PAD = 28;

const WALLPAPER_DARK =
  'radial-gradient(900px 700px at 12% 8%,#35507f 0%,rgba(53,80,127,0) 62%),radial-gradient(800px 700px at 88% 22%,#6a3b66 0%,rgba(106,59,102,0) 60%),radial-gradient(1100px 800px at 55% 105%,#1d5050 0%,rgba(29,80,80,0) 60%),#0c0f17';
const WALLPAPER_LIGHT =
  'radial-gradient(900px 700px at 12% 8%,#c4d8f2 0%,rgba(196,216,242,0) 62%),radial-gradient(800px 700px at 88% 22%,#f1d3e2 0%,rgba(241,211,226,0) 60%),radial-gradient(1100px 800px at 55% 105%,#cde9dc 0%,rgba(205,233,220,0) 60%),#e8ecf2';

/** Wallpapers that ship with homeview-theme (copied to /config/www/homeview/). */
const PRESETS: Array<{ label: string; url: string }> = [
  { label: 'Dusk', url: '/local/homeview/wall-dusk.jpg' },
  { label: 'Day', url: '/local/homeview/wall-day.jpg' },
];

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const overlaps = (a: Box, b: Box) =>
  a.screen === b.screen && a.column < b.column + b.colSpan && b.column < a.column + a.colSpan && a.row < b.row + b.rowSpan && b.row < a.row + a.rowSpan;
const cssUrl = (url: string) => `url("${url.replace(/"/g, '%22')}")`;

/** The nearest scrolling container above an element, crossing shadow roots. */
const scrollerAbove = (el: Element): Element => {
  let node: Node | null = el;
  while (node) {
    const parent: Node | null = (node as Element).parentElement ?? ((node.getRootNode() as ShadowRoot).host as Node | undefined) ?? null;
    if (parent instanceof HTMLElement) {
      const oy = getComputedStyle(parent).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && parent.scrollHeight > parent.clientHeight + 1) return parent;
    }
    node = parent;
  }
  return document.scrollingElement ?? document.documentElement;
};

/**
 * HomeView's wall-panel view: grids sized to the screen (6 × 4 on a landscape
 * iPad Pro), one or more screens to swipe between, the wallpaper behind glass
 * cards, a greeting header with status chips, and the ambient clock and
 * notifications built in.
 *
 * Positions are kept per grid size, so arranging the view on a phone never
 * disturbs the wall panel. On a grid you haven't arranged, cards pack in the
 * order of your most-arranged grid, spilling onto extra screens.
 */
export class HomeViewView extends LitElement {
  @property({ attribute: false }) hass?: HomeAssistant;
  @property({ attribute: false }) lovelace?: Lovelace;
  @property({ type: Boolean }) narrow = false;
  /** This view's position in the dashboard; Home Assistant sets it on every view layout. */
  @property({ type: Number }) index?: number;
  @property({ attribute: false }) path: Array<string | number> = [];
  @property({ attribute: false }) cards: HuiCard[] = [];
  @property({ attribute: false }) badges: HTMLElement[] = [];
  @property({ reflect: true }) mode: Mode = 'dark';
  @state() private config: HomeViewViewConfig = {};
  @state() private cols = 6;
  @state() private rows = 4;
  @state() private page = 0;
  @state() private drag?: Drag;
  @state() private sheet?: Sheet;
  @state() private pos?: Placed;
  @state() private draft: Record<string, any> = {};
  @state() private busy = '';
  private header?: HTMLElement & { hass?: HomeAssistant; setConfig(c: unknown): void };
  private ambient?: HTMLElement & { hass?: HomeAssistant; setConfig(c: unknown): void };
  private notifier?: HTMLElement & { hass?: HomeAssistant; setConfig(c: unknown): void };
  /** Height added so the cards end PAD above the bottom of the screen. */
  private stretch = 0;
  /** Negative bottom margin cancelling whatever Home Assistant puts below the view. */
  private pull = 0;
  private fitTries = 0;
  private resizer?: ResizeObserver;
  private placed: Placed[] = [];

  setConfig(config: HomeViewViewConfig): void {
    this.config = { ...config };
    store.setSettings({ appearance: config.appearance, night_entity: config.night_entity });
    this.header = this.helper('homeview-chips-card', config.header ? { style: config.header.style ?? 'full', show_greeting: config.header.greeting ?? true, chips: config.header.chips ?? [] } : undefined, this.header);
    this.ambient = this.helper('homeview-ambient-card', config.ambient, this.ambient);
    this.notifier = this.helper('homeview-notification-card', config.notifications, this.notifier);
  }

  private helper<T extends HTMLElement & { setConfig(c: unknown): void }>(tag: string, cfg: object | undefined, existing?: T): T | undefined {
    if (!cfg) return undefined;
    const el = existing ?? (document.createElement(tag) as T);
    el.setConfig({ type: `custom:${tag}`, ...cfg });
    return el;
  }

  // ---------------------------------------------------------------- sizing

  /**
   * Fill the screen below the view's top edge, then work out how many columns
   * and rows fit. Home Assistant can add space above (a header kiosk tools
   * hide) or below (safe-area padding) the view, so measure the result and
   * correct it: the cards should end exactly PAD above the bottom, with
   * nothing left to scroll.
   */
  private fit = (): void => {
    if (window.matchMedia('(max-width: 900px)').matches) {
      this.style.removeProperty('--hv-view-height');
      this.style.removeProperty('margin-bottom');
      return;
    }
    const scroller = scrollerAbove(this);
    const viewport = window.visualViewport?.height ?? window.innerHeight;
    const top = Math.max(0, this.getBoundingClientRect().top + (scroller.scrollTop || 0));
    const height = Math.max(320, Math.floor(viewport - top + this.stretch));
    this.style.setProperty('--hv-view-height', `${height}px`);
    this.style.marginBottom = this.pull ? `${-this.pull}px` : '';

    const width = this.getBoundingClientRect().width - PAD * 2;
    const headH = this.config.header ? (this.renderRoot.querySelector('.head') as HTMLElement | null)?.offsetHeight ?? 64 : 0;
    const gridH = height - PAD * 2 - (headH ? headH + GAP : 0);
    const autoCols = clamp(Math.round((width + GAP) / (TILE + GAP)), 2, 8);
    const autoRows = clamp(Math.round((gridH + GAP) / (TILE + GAP)), 2, 8);
    const cols = typeof this.config.columns === 'number' ? this.config.columns : autoCols;
    const rows = typeof this.config.rows === 'number' ? this.config.rows : autoRows;
    if (cols !== this.cols) this.cols = cols;
    if (rows !== this.rows) this.rows = rows;

    requestAnimationFrame(() => {
      if (this.fitTries >= 6) return;
      const pages = this.renderRoot.querySelector('.pages') as HTMLElement | null;
      if (!pages) return;
      const sc = scrollerAbove(this);
      // How far the cards' bottom edge is from where it should be, and anything left to scroll.
      const gap = viewport - (pages.getBoundingClientRect().bottom + (sc.scrollTop || 0));
      const miss = Math.round(gap - PAD);
      const over = Math.round(sc.scrollHeight - sc.clientHeight);
      if (Math.abs(miss) <= 1 && over <= 0) return;
      this.fitTries++;
      if (Math.abs(miss) > 1) this.stretch = clamp(this.stretch + miss, -200, 200);
      if (over > 0) this.pull = clamp(this.pull + over, 0, 200);
      this.fit();
    });
  };

  private onResize = (): void => {
    this.stretch = 0;
    this.pull = 0;
    this.fitTries = 0;
    this.fit();
  };

  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener('resize', this.onResize);
    window.visualViewport?.addEventListener('resize', this.onResize);
    // The header can appear or disappear (kiosk mode, edit mode) without a window resize.
    this.resizer = new ResizeObserver(() => {
      this.fitTries = 0;
      this.fit();
    });
    this.resizer.observe(document.body);
    requestAnimationFrame(this.fit);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener('resize', this.onResize);
    window.visualViewport?.removeEventListener('resize', this.onResize);
    this.resizer?.disconnect();
  }

  protected willUpdate(changed: PropertyValues): void {
    if (changed.has('hass') && this.hass) {
      store.setHass(this.hass);
      this.mode = resolveMode(this.hass, this.config.appearance, this.config.night_entity);
      for (const el of [this.header, this.ambient, this.notifier]) if (el) el.hass = this.hass;
    }
  }

  private wallpaperUrl(w: Wallpaper | undefined, mode: Mode): string | undefined {
    return typeof w === 'string' ? w : w?.[mode] ?? (mode === 'night' ? w?.dark : undefined);
  }

  private wallpaper(): string {
    const url = this.wallpaperUrl(this.config.wallpaper, this.mode);
    if (url) return `center / cover no-repeat ${cssUrl(url)}`;
    return this.mode === 'light' ? WALLPAPER_LIGHT : WALLPAPER_DARK;
  }

  // ---------------------------------------------------------------- placement

  private get gridKey(): string {
    return `${this.cols}x${this.rows}`;
  }

  private layoutOf(card: HuiCard): ViewLayout {
    return (card.config?.view_layout ?? {}) as ViewLayout;
  }

  private spans(card: HuiCard): { colSpan: number; rowSpan: number } {
    const layout = this.layoutOf(card);
    let colSpan = layout.column_span;
    let rowSpan = layout.row_span;
    if (colSpan === undefined || rowSpan === undefined) {
      // Translate the card's sections size (12 columns, 56px rows) onto this grid.
      const opts = card.getGridOptions?.() ?? {};
      const c = opts.columns === 'full' ? 12 : opts.columns ?? 6;
      const r = typeof opts.rows === 'number' ? opts.rows : 3;
      colSpan ??= Math.max(1, Math.round(c / 6));
      rowSpan ??= Math.max(1, Math.round(r / 3));
    }
    return { colSpan: clamp(colSpan, 1, this.cols), rowSpan: clamp(rowSpan, 1, this.rows) };
  }

  /**
   * Resolve every card's spot on the current grid: its saved position for
   * this grid size first, then an earlier single position if it still fits,
   * then the first free space, in the order of the grid you've arranged most.
   * Nothing overlaps; whatever doesn't fit spills onto the next screen.
   */
  private arrange(): Placed[] {
    const key = this.gridKey;
    const cols = this.cols;
    const rows = this.rows;
    const items = this.cards.map((card, index) => ({ index, layout: this.layoutOf(card), ...this.spans(card) }));
    const taken: Box[] = [];
    const out: Placed[] = [];
    const free = (b: Box) =>
      b.column >= 1 && b.row >= 1 && b.column + b.colSpan - 1 <= cols && b.row + b.rowSpan - 1 <= rows && !taken.some((t) => overlaps(t, b));
    const put = (index: number, b: Box) => {
      taken.push(b);
      out[index] = { index, ...b };
    };

    for (const it of items) {
      const g = it.layout.grids?.[key];
      const b = g && { screen: Math.max(1, g.screen ?? 1), column: g.column, row: g.row, colSpan: it.colSpan, rowSpan: it.rowSpan };
      if (b && free(b)) put(it.index, b);
    }
    // Earlier single positions pin a card only until it's been arranged on some grid; after that they just set its order.
    for (const it of items) {
      const l = it.layout;
      if (out[it.index] || Object.keys(l.grids ?? {}).length || l.column === undefined || l.row === undefined) continue;
      const b = { screen: Math.max(1, l.screen ?? 1), column: l.column, row: l.row, colSpan: it.colSpan, rowSpan: it.rowSpan };
      if (free(b)) put(it.index, b);
    }

    // Order the rest as they sit on the grid size arranged most, so a phone keeps the wall panel's reading order.
    const counts = new Map<string, number>();
    for (const it of items) for (const k of Object.keys(it.layout.grids ?? {})) if (k !== key) counts.set(k, (counts.get(k) ?? 0) + 1);
    const area = (k: string) => k.split('x').reduce((a, n) => a * (Number(n) || 1), 1);
    const ref = [...counts.entries()].sort((a, b) => b[1] - a[1] || area(b[0]) - area(a[0]))[0]?.[0];
    const refPos = (l: ViewLayout): GridPos | undefined =>
      (ref ? l.grids?.[ref] : undefined) ?? (l.column !== undefined && l.row !== undefined ? { screen: l.screen, column: l.column, row: l.row } : undefined);
    const rest = items
      .filter((it) => !out[it.index])
      .map((it) => ({ it, p: refPos(it.layout) }))
      .sort(
        (a, b) =>
          (a.p?.screen ?? 1) - (b.p?.screen ?? 1) || (a.p?.row ?? 99) - (b.p?.row ?? 99) || (a.p?.column ?? 99) - (b.p?.column ?? 99) || a.it.index - b.it.index,
      );

    for (const { it, p } of rest) {
      let done = false;
      for (let screen = Math.max(1, p?.screen ?? it.layout.screen ?? 1); !done && screen < 60; screen++) {
        for (let row = 1; row <= rows - it.rowSpan + 1 && !done; row++) {
          for (let column = 1; column <= cols - it.colSpan + 1 && !done; column++) {
            const b = { screen, column, row, colSpan: it.colSpan, rowSpan: it.rowSpan };
            if (free(b)) {
              put(it.index, b);
              done = true;
            }
          }
        }
      }
    }
    return out;
  }

  private gridArea(p: Box): string {
    return `grid-column:${p.column} / span ${p.colSpan};grid-row:${p.row} / span ${p.rowSpan}`;
  }

  private get screenCount(): number {
    return Math.max(this.config.screens ?? 1, 1, ...this.placed.filter(Boolean).map((p) => p.screen));
  }

  // ---------------------------------------------------------------- paging

  private onScroll = (ev: Event): void => {
    const el = ev.currentTarget as HTMLElement;
    const page = Math.round(el.scrollLeft / Math.max(1, el.clientWidth));
    if (page !== this.page) this.page = page;
  };

  private goTo(page: number): void {
    const pages = this.renderRoot.querySelector('.pages') as HTMLElement | null;
    pages?.scrollTo({ left: page * pages.clientWidth, behavior: 'smooth' });
  }

  // ---------------------------------------------------------------- editing

  private get viewIndex(): number {
    if (typeof this.index === 'number') return this.index;
    const nums = this.path.filter((p): p is number => typeof p === 'number');
    return nums.length ? nums[nums.length - 1] : 0;
  }

  /**
   * A card's address in the events Home Assistant's view listens for:
   * [view, card]. Current releases need exactly this; newer ones address
   * cards by name but still accept it from custom views.
   */
  private cardPath(index: number): [number, number] {
    return [this.viewIndex, index];
  }

  /** Change this view's config and save the dashboard. */
  private async save(mutate: (view: Record<string, any>) => void): Promise<void> {
    const lovelace = this.lovelace;
    if (!lovelace?.saveConfig) return;
    const raw = structuredClone(lovelace.rawConfig ?? lovelace.config);
    const view = raw.views?.[this.viewIndex];
    if (!view) return;
    mutate(view);
    await lovelace.saveConfig(raw);
  }

  /**
   * Put one card somewhere on this grid size. Every other card's current spot
   * is saved for this size too, so nothing else shifts; cards in the way lose
   * theirs and flow into the nearest free space.
   */
  private commit(index: number, target: Box): void {
    const key = this.gridKey;
    const placed = this.placed;
    void this.save((view) => {
      (view.cards ?? []).forEach((card: Record<string, any>, i: number) => {
        const p = placed[i];
        if (!p) return;
        // Single positions from before per-grid layouts are superseded once the card is arranged.
        const { column: _c, row: _r, screen: _s, ...layout }: Record<string, any> = card.view_layout ?? {};
        const grids: Record<string, GridPos> = { ...(layout.grids ?? {}) };
        if (i === index) {
          grids[key] = { screen: target.screen, column: target.column, row: target.row };
          layout.column_span = target.colSpan;
          layout.row_span = target.rowSpan;
        } else if (overlaps(p, target)) {
          delete grids[key];
        } else {
          grids[key] = { screen: p.screen, column: p.column, row: p.row };
        }
        if (Object.keys(grids).length) layout.grids = grids;
        else delete layout.grids;
        card.view_layout = layout;
      });
      if (target.screen > (view.screens ?? 1)) view.screens = target.screen;
    });
  }

  private edit(index: number): void {
    fireEvent(this, 'll-edit-card', { path: this.cardPath(index) });
  }

  private deleteCard(index: number): void {
    fireEvent(this, 'll-delete-card', { path: this.cardPath(index), silent: false });
  }

  private add(): void {
    // No path: Home Assistant adds the card to this view, in every release.
    fireEvent(this, 'll-create-card');
  }

  private addScreen(): void {
    void this.save((view) => (view.screens = this.screenCount + 1));
  }

  private removeScreen(): void {
    void this.save((view) => (view.screens = Math.max(1, this.screenCount - 1)));
  }

  /** The grid cell under a point on a page. */
  private cellAt(page: HTMLElement, x: number, y: number): { column: number; row: number } {
    const r = page.getBoundingClientRect();
    const cw = (r.width + GAP) / this.cols;
    const rh = (r.height + GAP) / this.rows;
    return { column: clamp(Math.floor((x - r.left) / cw) + 1, 1, this.cols), row: clamp(Math.floor((y - r.top) / rh) + 1, 1, this.rows) };
  }

  private startDrag(ev: PointerEvent, p: Placed, mode: 'move' | 'resize'): void {
    if (ev.button !== 0) return;
    ev.preventDefault();
    ev.stopPropagation();
    const page = (ev.currentTarget as HTMLElement).closest('.page') as HTMLElement;
    this.drag = { index: p.index, mode, page, startX: ev.clientX, startY: ev.clientY, placed: p, moved: false };
    window.addEventListener('pointermove', this.onDragMove);
    window.addEventListener('pointerup', this.onDragEnd);
    window.addEventListener('pointercancel', this.onDragCancel);
  }

  private onDragMove = (ev: PointerEvent): void => {
    const d = this.drag;
    if (!d) return;
    if (!d.moved && Math.hypot(ev.clientX - d.startX, ev.clientY - d.startY) < 8) return;
    const p = d.placed;
    let target: Box;
    if (d.mode === 'move') {
      const r = d.page.getBoundingClientRect();
      const cw = (r.width + GAP) / this.cols;
      const rh = (r.height + GAP) / this.rows;
      const column = clamp(p.column + Math.round((ev.clientX - d.startX) / cw), 1, this.cols - p.colSpan + 1);
      const row = clamp(p.row + Math.round((ev.clientY - d.startY) / rh), 1, this.rows - p.rowSpan + 1);
      target = { ...p, column, row };
    } else {
      const cell = this.cellAt(d.page, ev.clientX, ev.clientY);
      target = { ...p, colSpan: clamp(cell.column - p.column + 1, 1, this.cols - p.column + 1), rowSpan: clamp(cell.row - p.row + 1, 1, this.rows - p.row + 1) };
    }
    this.drag = { ...d, moved: true, target };
  };

  private stopDrag(): Drag | undefined {
    window.removeEventListener('pointermove', this.onDragMove);
    window.removeEventListener('pointerup', this.onDragEnd);
    window.removeEventListener('pointercancel', this.onDragCancel);
    const d = this.drag;
    this.drag = undefined;
    return d;
  }

  private onDragCancel = (): void => {
    this.stopDrag();
  };

  private onDragEnd = (): void => {
    const d = this.stopDrag();
    if (!d) return;
    // A tap on the handle, with no drag, opens the position panel instead.
    if (!d.moved) {
      if (d.mode === 'move') this.openPosition(d.placed);
      return;
    }
    const t = d.target!;
    const p = d.placed;
    if (t.column === p.column && t.row === p.row && t.colSpan === p.colSpan && t.rowSpan === p.rowSpan) return;
    this.commit(d.index, t);
  };

  // ---------------------------------------------------------------- sheets

  private openPosition(p: Placed): void {
    this.pos = { ...p };
    this.sheet = 'position';
  }

  /** The first spot on a screen with room for a card of this size, ignoring the card itself. */
  private firstFree(screen: number, index: number, colSpan: number, rowSpan: number): { column: number; row: number } | undefined {
    const others = this.placed.filter((p) => p && p.index !== index);
    for (let row = 1; row <= this.rows - rowSpan + 1; row++) {
      for (let column = 1; column <= this.cols - colSpan + 1; column++) {
        const b = { screen, column, row, colSpan, rowSpan };
        if (!others.some((o) => overlaps(o, b))) return { column, row };
      }
    }
    return undefined;
  }

  private setPos(patch: Partial<Box>): void {
    const p = this.pos;
    if (!p) return;
    const next = { ...p, ...patch };
    next.colSpan = clamp(Math.round(next.colSpan) || 1, 1, this.cols);
    next.rowSpan = clamp(Math.round(next.rowSpan) || 1, 1, this.rows);
    next.column = clamp(Math.round(next.column) || 1, 1, this.cols - next.colSpan + 1);
    next.row = clamp(Math.round(next.row) || 1, 1, this.rows - next.rowSpan + 1);
    if (patch.screen !== undefined && patch.screen !== p.screen) {
      const spot = this.firstFree(next.screen, p.index, next.colSpan, next.rowSpan);
      if (spot) Object.assign(next, spot);
    }
    this.pos = next;
  }

  private openWallpaper(): void {
    const w = this.config.wallpaper;
    this.draft = {
      split: typeof w === 'object' && w !== null,
      light: this.wallpaperUrl(w, 'light') ?? '',
      dark: this.wallpaperUrl(w, 'dark') ?? '',
      night: typeof w === 'object' && w?.night ? w.night : '',
    };
    this.busy = '';
    this.sheet = 'wallpaper';
  }

  private openHeader(): void {
    const h = this.config.header;
    this.draft = { enabled: !!h, greeting: h?.greeting ?? true, style: h?.style ?? 'full', chips: h?.chips ?? [] };
    this.sheet = 'header';
  }

  private closeSheet = (): void => {
    this.sheet = undefined;
    this.pos = undefined;
    this.busy = '';
  };

  private applySheet(): void {
    const sheet = this.sheet;
    const d = this.draft;
    if (sheet === 'position' && this.pos) {
      const { index, ...box } = this.pos;
      this.commit(index, box);
    } else if (sheet === 'wallpaper') {
      void this.save((view) => {
        const value: Wallpaper | undefined = d.split
          ? Object.fromEntries((['light', 'dark', 'night'] as const).filter((m) => d[m]).map((m) => [m, d[m]]))
          : d.dark || d.light || undefined;
        if (!value || (typeof value === 'object' && !Object.keys(value).length)) delete view.wallpaper;
        else view.wallpaper = value;
      });
    } else if (sheet === 'header') {
      void this.save((view) => {
        if (!d.enabled) delete view.header;
        else view.header = { greeting: d.greeting, style: d.style, chips: d.chips };
      });
    }
    this.closeSheet();
  }

  /** Upload through Home Assistant's image upload, as the picture card's editor does. */
  private async upload(slot: string, ev: Event): Promise<void> {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file || !this.hass?.fetchWithAuth) return;
    this.busy = `Uploading ${file.name}…`;
    try {
      const body = new FormData();
      body.append('file', file);
      const res = await this.hass.fetchWithAuth('/api/image/upload', { method: 'POST', body });
      if (!res.ok) throw new Error(String(res.status));
      const { id } = (await res.json()) as { id: string };
      this.draft = { ...this.draft, [slot]: `/api/image/serve/${id}/original` };
      this.busy = '';
    } catch {
      this.busy = "Couldn't upload. Check the Image upload integration is set up (it's part of default_config).";
    }
  }

  private renderPosition() {
    const p = this.pos!;
    const screens = this.screenCount;
    const others = this.placed.filter((o) => o && o.index !== p.index && o.screen === p.screen);
    const inWay = others.filter((o) => overlaps(o, p)).length;
    const num = (label: string, key: keyof Box, min: number, max: number) => html`<label class="num">
      <span>${label}</span>
      <span class="stepper">
        <button aria-label="Less" ?disabled=${p[key] <= min} @click=${() => this.setPos({ [key]: p[key] - 1 })}><ha-icon icon="mdi:minus"></ha-icon></button>
        <input type="number" inputmode="numeric" min=${min} max=${max} .value=${String(p[key])} @change=${(e: Event) => this.setPos({ [key]: Number((e.target as HTMLInputElement).value) })} />
        <button aria-label="More" ?disabled=${p[key] >= max} @click=${() => this.setPos({ [key]: p[key] + 1 })}><ha-icon icon="mdi:plus"></ha-icon></button>
      </span>
    </label>`;
    return html`
      <h2>Position</h2>
      <p class="hint">On the ${this.cols} × ${this.rows} grid this display uses. Other screen sizes keep their own arrangement.</p>
      <div class="field">
        <span>Screen</span>
        <div class="seg">
          ${Array.from({ length: screens }, (_, i) => html`<button aria-pressed=${p.screen === i + 1} @click=${() => this.setPos({ screen: i + 1 })}>${i + 1}</button>`)}
          <button aria-pressed=${p.screen > screens} @click=${() => this.setPos({ screen: screens + 1 })}><ha-icon icon="mdi:plus"></ha-icon>New</button>
        </div>
      </div>
      <div class="map" style="grid-template-columns:repeat(${this.cols},1fr);grid-template-rows:repeat(${this.rows},1fr);aspect-ratio:${this.cols * 1.15} / ${this.rows}">
        ${Array.from({ length: this.cols * this.rows }, (_, i) => {
          const column = (i % this.cols) + 1;
          const row = Math.floor(i / this.cols) + 1;
          return html`<button class="cell-btn" style="grid-column:${column};grid-row:${row}" aria-label="Column ${column}, row ${row}" @click=${() => this.setPos({ column, row })}></button>`;
        })}
        ${others.map((o) => html`<i class="other" style=${this.gridArea(o)}></i>`)}
        <i class="me" style=${this.gridArea(p)}></i>
      </div>
      <div class="nums">
        ${num('Column', 'column', 1, this.cols - p.colSpan + 1)} ${num('Row', 'row', 1, this.rows - p.rowSpan + 1)}
        ${num('Width', 'colSpan', 1, this.cols)} ${num('Height', 'rowSpan', 1, this.rows)}
      </div>
      ${inWay ? html`<p class="hint">${inWay === 1 ? 'The card in the way moves' : `The ${inWay} cards in the way move`} to the nearest free space.</p>` : nothing}
    `;
  }

  private renderWallpaperSlot(slot: 'light' | 'dark' | 'night', label: string) {
    const url: string = this.draft[slot] ?? '';
    const set = (v: string) => (this.draft = { ...this.draft, [slot]: v });
    const fallback = slot === 'light' ? WALLPAPER_LIGHT : WALLPAPER_DARK;
    return html`<div class="wp">
      ${label ? html`<div class="wp-label">${label}</div>` : nothing}
      <div class="wp-row">
        <button class="thumb ${!url ? 'on' : ''}" style="background:${fallback}" @click=${() => set('')}><span>HomeView</span></button>
        ${PRESETS.map((p) => html`<button class="thumb ${url === p.url ? 'on' : ''}" style="background:center/cover ${cssUrl(p.url)},#333" @click=${() => set(p.url)}><span>${p.label}</span></button>`)}
        ${url && !PRESETS.some((p) => p.url === url) ? html`<button class="thumb on" style="background:center/cover ${cssUrl(url)},#333"><span>Yours</span></button>` : nothing}
        <label class="thumb upload">
          <ha-icon icon="mdi:upload"></ha-icon><span>Upload</span>
          <input type="file" accept="image/*" hidden @change=${(e: Event) => this.upload(slot, e)} />
        </label>
      </div>
      <input class="url" type="text" placeholder="Or an image URL, such as /local/my-wallpaper.jpg" .value=${url} @change=${(e: Event) => set((e.target as HTMLInputElement).value.trim())} />
    </div>`;
  }

  private renderWallpaper() {
    const d = this.draft;
    return html`
      <h2>Wallpaper</h2>
      <p class="hint">Sits behind the glass cards. The Dusk and Day photos come with homeview-theme: copy them to /config/www/homeview/.</p>
      <label class="switch-row">
        <input type="checkbox" .checked=${!!d.split} @change=${(e: Event) => (this.draft = { ...d, split: (e.target as HTMLInputElement).checked })} />
        <span>Different wallpapers for light, dark and night</span>
      </label>
      ${d.split
        ? html`${this.renderWallpaperSlot('light', 'Light')}${this.renderWallpaperSlot('dark', 'Dark')}${this.renderWallpaperSlot('night', 'Night (the dark one, dimmed, if left on HomeView)')}`
        : this.renderWallpaperSlot('dark', '')}
      ${this.busy ? html`<p class="hint">${this.busy}</p>` : nothing}
    `;
  }

  private renderHeader() {
    const d = this.draft;
    const set = (patch: Record<string, unknown>) => (this.draft = { ...this.draft, ...patch });
    return html`
      <h2>Header</h2>
      <label class="switch-row">
        <input type="checkbox" .checked=${!!d.enabled} @change=${(e: Event) => set({ enabled: (e.target as HTMLInputElement).checked })} />
        <span>Show the header</span>
      </label>
      ${d.enabled
        ? html`<label class="switch-row">
              <input type="checkbox" .checked=${!!d.greeting} @change=${(e: Event) => set({ greeting: (e.target as HTMLInputElement).checked })} />
              <span>Greeting and date</span>
            </label>
            <div class="field">
              <span>Chips</span>
              <div class="seg">
                <button aria-pressed=${d.style === 'full'} @click=${() => set({ style: 'full' })}>With labels</button>
                <button aria-pressed=${d.style === 'compact'} @click=${() => set({ style: 'compact' })}>Icons only</button>
              </div>
            </div>
            <homeview-chips-editor .hass=${this.hass} .chips=${d.chips ?? []} @chips-changed=${(e: CustomEvent<Chip[]>) => set({ chips: e.detail })}></homeview-chips-editor>`
        : nothing}
    `;
  }

  private renderSheet() {
    if (!this.sheet) return nothing;
    const body = this.sheet === 'position' ? this.renderPosition() : this.sheet === 'wallpaper' ? this.renderWallpaper() : this.renderHeader();
    return html`<div class="backdrop" @click=${this.closeSheet}>
      <div class="sheet" role="dialog" aria-modal="true" @click=${(e: Event) => e.stopPropagation()}>
        <div class="sheet-body">${body}</div>
        <div class="sheet-actions">
          <button class="btn" @click=${this.closeSheet}>Cancel</button>
          <button class="btn primary" ?disabled=${this.busy.startsWith('Uploading')} @click=${() => this.applySheet()}>${this.sheet === 'position' ? 'Move' : 'Save'}</button>
        </div>
      </div>
    </div>`;
  }

  // ---------------------------------------------------------------- render

  protected updated(): void {
    requestAnimationFrame(this.fit);
    this.renderRoot.querySelectorAll<HTMLElement>('.cell').forEach((slot) => {
      const card = this.cards[Number(slot.dataset.index)];
      if (!card) return;
      if (card.parentElement !== slot) slot.replaceChildren(card);
      card.hass = this.hass;
      (card as unknown as { editMode?: boolean }).editMode = !!this.lovelace?.editMode;
    });
    const helpers = this.renderRoot.querySelector('.helpers');
    for (const el of [this.ambient, this.notifier]) if (el && helpers && el.parentElement !== helpers) helpers.appendChild(el);
    const head = this.renderRoot.querySelector('.head-slot');
    if (this.header && head && this.header.parentElement !== head) head.replaceChildren(this.header);
  }

  private renderSlot(p: Placed, editing: boolean) {
    const dragging = this.drag?.moved && this.drag.index === p.index;
    return html`<div class="slot ${dragging ? 'dragging' : ''}" style=${this.gridArea(p)}>
      <div class="cell" data-index=${p.index}></div>
      ${editing
        ? html`<div class="edit">
            <button class="handle" aria-label="Drag to move, or tap to set the position and screen" title="Drag to move · tap for position and screen" @pointerdown=${(e: PointerEvent) => this.startDrag(e, p, 'move')}>
              <ha-icon icon="mdi:drag"></ha-icon>
            </button>
            <div class="tools">
              <button aria-label="Edit card" @click=${() => this.edit(p.index)}><ha-icon icon="mdi:pencil"></ha-icon></button>
              <button aria-label="Delete card" @click=${() => this.deleteCard(p.index)}><ha-icon icon="mdi:delete-outline"></ha-icon></button>
            </div>
            <div class="sizer" title="Drag to resize" @pointerdown=${(e: PointerEvent) => this.startDrag(e, p, 'resize')}><ha-icon icon="mdi:resize-bottom-right"></ha-icon></div>
          </div>`
        : nothing}
    </div>`;
  }

  render() {
    const editing = !!this.lovelace?.editMode;
    this.placed = this.arrange();
    const placed = this.placed;
    const screens = this.screenCount;
    const gridStyle = `grid-template-columns:repeat(${this.cols},minmax(0,1fr));grid-template-rows:repeat(${this.rows},minmax(0,1fr))`;
    const d = this.drag;
    return html`
      <div class="wall" style="background:${this.wallpaper()}"></div>
      <div class="frame">
        ${this.config.header || editing
          ? html`<div class="head ${editing ? 'editing' : ''}">
              <div class="head-slot">${this.config.header ? nothing : html`<div class="head-empty">No header</div>`}</div>
              ${editing ? html`<button class="head-edit" @click=${() => this.openHeader()}><ha-icon icon="mdi:pencil"></ha-icon>Header</button>` : nothing}
            </div>`
          : nothing}
        <div class="pages ${editing ? 'editing' : ''}" @scroll=${this.onScroll}>
          ${Array.from({ length: screens }, (_, s) => {
            // Reading order in the DOM too: phones stack cards in it, and screen readers follow it.
            const here = placed.filter((p) => p && p.screen === s + 1).sort((a, b) => a.row - b.row || a.column - b.column);
            return html`<div class="page" aria-label="Screen ${s + 1} of ${screens}">
              ${editing ? html`<div class="ghosts" style=${gridStyle}>${Array.from({ length: this.cols * this.rows }, () => html`<i></i>`)}</div>` : nothing}
              <div class="grid" style=${gridStyle}>
                ${here.map((p) => this.renderSlot(p, editing))}
                ${d?.target && d.moved && d.placed.screen === s + 1 ? html`<div class="drop" style=${this.gridArea(d.target)}></div>` : nothing}
              </div>
            </div>`;
          })}
        </div>
      </div>
      ${editing
        ? html`<div class="editbar">
            <button @click=${() => this.add()}><ha-icon icon="mdi:plus"></ha-icon>Card</button>
            <button @click=${() => this.addScreen()}><ha-icon icon="mdi:plus-box-multiple-outline"></ha-icon>Screen</button>
            ${screens > 1 && !placed.some((p) => p && p.screen >= screens)
              ? html`<button @click=${() => this.removeScreen()}><ha-icon icon="mdi:minus-box-multiple-outline"></ha-icon>Last screen</button>`
              : nothing}
            <button @click=${() => this.openWallpaper()}><ha-icon icon="mdi:image-outline"></ha-icon>Wallpaper</button>
          </div>`
        : nothing}
      ${screens > 1
        ? html`<div class="dots" role="tablist" aria-label="Screens">
            ${Array.from({ length: screens }, (_, i) => html`<button role="tab" aria-selected=${i === this.page} aria-label="Screen ${i + 1}" @click=${() => this.goTo(i)}></button>`)}
          </div>`
        : nothing}
      ${this.renderSheet()}
      <div class="helpers"></div>
    `;
  }

  static styles = css`
    /* Layout lives on .frame: the dashboard may set display on the view element itself. */
    :host {
      position: relative;
      display: block;
      height: var(--hv-view-height, calc(100dvh - var(--header-height, 56px)));
      overflow: hidden;
      -webkit-tap-highlight-color: transparent;
    }
    .wall {
      position: fixed;
      inset: 0;
      z-index: -1;
      pointer-events: none;
    }
    :host([mode='night']) .wall {
      filter: brightness(0.22) saturate(0.6);
    }
    .frame {
      box-sizing: border-box;
      height: 100%;
      display: flex;
      flex-direction: column;
      gap: 20px;
      padding: 28px;
    }
    .head {
      position: relative;
      flex: none;
    }
    .head.editing {
      border-radius: 24px;
      outline: 2px dashed rgba(255, 255, 255, 0.5);
      outline-offset: 6px;
    }
    .head-empty {
      height: 44px;
      display: flex;
      align-items: center;
      font-size: 17px;
      font-weight: 600;
      color: rgba(255, 255, 255, 0.55);
    }
    /* Screens sit side by side; native scroll snapping gives the swipe. */
    .pages {
      flex: 1;
      min-height: 0;
      display: flex;
      gap: 56px;
      margin: 0 -28px;
      padding: 0 28px;
      overflow-x: auto;
      overflow-y: hidden;
      scroll-snap-type: x mandatory;
      scroll-padding: 0 28px;
      overscroll-behavior-x: contain;
      scrollbar-width: none;
    }
    .pages::-webkit-scrollbar {
      display: none;
    }
    .page {
      position: relative;
      flex: 0 0 100%;
      min-width: 0;
      height: 100%;
      scroll-snap-align: start;
      scroll-snap-stop: always;
    }
    .grid,
    .ghosts {
      position: absolute;
      inset: 0;
      display: grid;
      gap: 20px;
    }
    .slot {
      position: relative;
      min-width: 0;
      min-height: 0;
    }
    .cell {
      height: 100%;
    }
    .cell > * {
      display: block;
      height: 100%;
    }
    /* The dots sit inside the bottom border, so the cards keep an even margin all round. */
    .dots {
      position: absolute;
      left: 0;
      right: 0;
      bottom: 3px;
      display: flex;
      justify-content: center;
      gap: 4px;
      pointer-events: none;
    }
    .dots button {
      width: 22px;
      height: 22px;
      padding: 0;
      border: 0;
      background: none;
      cursor: pointer;
      display: grid;
      place-items: center;
      pointer-events: auto;
    }
    .dots button::before {
      content: '';
      width: 8px;
      height: 8px;
      border-radius: 4px;
      background: rgba(255, 255, 255, 0.35);
      transition: background 0.2s ease, width 0.2s ease;
    }
    :host([mode='light']) .dots button::before {
      background: rgba(15, 17, 21, 0.25);
    }
    .dots button[aria-selected='true']::before {
      width: 20px;
      background: rgba(255, 255, 255, 0.9);
    }
    :host([mode='light']) .dots button[aria-selected='true']::before {
      background: rgba(15, 17, 21, 0.75);
    }

    /* ---------- edit mode ---------- */
    .editing .page {
      scroll-snap-stop: normal;
    }
    .ghosts {
      pointer-events: none;
    }
    .ghosts i {
      border-radius: 24px;
      border: 2px dashed rgba(255, 255, 255, 0.18);
    }
    .slot.dragging {
      opacity: 0.45;
    }
    /* Only the controls take touches: the card itself stays usable in edit mode. */
    .edit {
      position: absolute;
      inset: 0;
      z-index: 10;
      border-radius: 30px;
      outline: 2px dashed rgba(255, 255, 255, 0.5);
      outline-offset: 3px;
      pointer-events: none;
    }
    .edit > * {
      pointer-events: auto;
    }
    .handle,
    .tools button,
    .sizer,
    .editbar button,
    .head-edit {
      border: 0;
      font: inherit;
      color: #fff;
      background: rgba(20, 18, 32, 0.78);
      -webkit-backdrop-filter: blur(10px);
      backdrop-filter: blur(10px);
      cursor: pointer;
    }
    .handle {
      position: absolute;
      top: 8px;
      left: 50%;
      transform: translateX(-50%);
      width: 60px;
      height: 34px;
      padding: 0;
      border-radius: 999px;
      display: grid;
      place-items: center;
      cursor: grab;
      touch-action: none;
      --mdc-icon-size: 24px;
    }
    .handle:active {
      cursor: grabbing;
    }
    .tools {
      position: absolute;
      top: 8px;
      right: 8px;
      display: flex;
      gap: 6px;
    }
    .tools button {
      width: 40px;
      height: 40px;
      border-radius: 999px;
      display: grid;
      place-items: center;
      --mdc-icon-size: 20px;
    }
    .sizer {
      position: absolute;
      right: 4px;
      bottom: 4px;
      width: 40px;
      height: 40px;
      border-radius: 999px;
      display: grid;
      place-items: center;
      cursor: nwse-resize;
      touch-action: none;
      --mdc-icon-size: 20px;
    }
    .drop {
      z-index: 20;
      border-radius: 30px;
      background: rgba(255, 201, 77, 0.2);
      outline: 3px solid #ffc94d;
      pointer-events: none;
    }
    /* Edit controls live in the bottom border, beside the dots, clear of the cards. */
    .editbar {
      position: absolute;
      right: 28px;
      bottom: 1px;
      z-index: 30;
      display: flex;
      gap: 6px;
    }
    .editbar button,
    .head-edit {
      display: flex;
      align-items: center;
      gap: 4px;
      height: 26px;
      padding: 0 12px 0 8px;
      border-radius: 999px;
      font-size: 14px;
      font-weight: 600;
      --mdc-icon-size: 16px;
    }
    .head-edit {
      position: absolute;
      left: 50%;
      top: 50%;
      transform: translate(-50%, -50%);
      z-index: 5;
      height: 36px;
      padding: 0 16px 0 12px;
      font-size: 16px;
      --mdc-icon-size: 18px;
    }

    /* ---------- sheets: position, wallpaper, header ---------- */
    .backdrop {
      position: fixed;
      inset: 0;
      z-index: 100;
      display: grid;
      place-items: center;
      padding: 24px;
      background: rgba(0, 0, 0, 0.5);
    }
    .sheet {
      box-sizing: border-box;
      width: min(560px, 100%);
      max-height: calc(100dvh - 48px);
      display: flex;
      flex-direction: column;
      border-radius: 28px;
      background: var(--primary-background-color, #14121f);
      color: var(--primary-text-color, #fff);
      box-shadow: 0 30px 80px rgba(0, 0, 0, 0.45);
      font-family: var(--hv-font, -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Inter', system-ui, sans-serif);
    }
    .sheet-body {
      overflow: auto;
      padding: 24px 24px 8px;
    }
    .sheet h2 {
      margin: 0 0 4px;
      font-size: 24px;
      font-weight: 700;
    }
    .hint {
      margin: 4px 0 12px;
      font-size: 15px;
      color: var(--secondary-text-color, rgba(255, 255, 255, 0.6));
    }
    .sheet-actions {
      display: flex;
      justify-content: flex-end;
      gap: 10px;
      padding: 12px 20px 20px;
    }
    .btn {
      height: 44px;
      padding: 0 22px;
      border: 0;
      border-radius: 999px;
      font: inherit;
      font-size: 17px;
      font-weight: 600;
      color: var(--primary-text-color, #fff);
      background: var(--secondary-background-color, rgba(127, 127, 127, 0.2));
      cursor: pointer;
    }
    .btn.primary {
      color: var(--text-primary-color, #fff);
      background: var(--primary-color, #4c8dff);
    }
    .btn:disabled {
      opacity: 0.5;
    }
    .field {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin: 14px 0;
      font-size: 17px;
      font-weight: 600;
    }
    .seg {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      padding: 4px;
      border-radius: 999px;
      background: var(--secondary-background-color, rgba(127, 127, 127, 0.15));
    }
    .seg button {
      display: flex;
      align-items: center;
      gap: 2px;
      min-width: 44px;
      height: 36px;
      padding: 0 14px;
      border: 0;
      border-radius: 999px;
      justify-content: center;
      font: inherit;
      font-size: 16px;
      font-weight: 600;
      color: inherit;
      background: none;
      cursor: pointer;
      --mdc-icon-size: 16px;
    }
    .seg button[aria-pressed='true'] {
      color: var(--text-primary-color, #fff);
      background: var(--primary-color, #4c8dff);
    }
    .map {
      position: relative;
      display: grid;
      gap: 4px;
      width: 100%;
      margin: 8px 0 14px;
    }
    .cell-btn {
      border: 1.5px dashed rgba(127, 127, 127, 0.45);
      border-radius: 8px;
      background: none;
      cursor: pointer;
    }
    .map i {
      border-radius: 8px;
      pointer-events: none;
    }
    .map .other {
      background: rgba(127, 127, 127, 0.55);
    }
    .map .me {
      background: rgba(255, 201, 77, 0.35);
      outline: 3px solid #ffc94d;
      outline-offset: -1px;
    }
    .nums {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px 20px;
    }
    .num {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      font-size: 16px;
      font-weight: 600;
    }
    .stepper {
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .stepper button {
      width: 34px;
      height: 34px;
      padding: 0;
      border: 0;
      border-radius: 50%;
      display: grid;
      place-items: center;
      color: inherit;
      background: var(--secondary-background-color, rgba(127, 127, 127, 0.15));
      cursor: pointer;
      --mdc-icon-size: 18px;
    }
    .stepper button:disabled {
      opacity: 0.35;
    }
    .stepper input {
      width: 44px;
      height: 34px;
      box-sizing: border-box;
      text-align: center;
      font: inherit;
      font-size: 17px;
      border: 1px solid var(--divider-color, rgba(127, 127, 127, 0.4));
      border-radius: 8px;
      color: inherit;
      background: none;
      -moz-appearance: textfield;
    }
    .stepper input::-webkit-inner-spin-button {
      -webkit-appearance: none;
    }
    .switch-row {
      display: flex;
      align-items: center;
      gap: 10px;
      margin: 12px 0;
      font-size: 17px;
      cursor: pointer;
    }
    .switch-row input {
      width: 20px;
      height: 20px;
      accent-color: var(--primary-color, #4c8dff);
    }
    .wp {
      margin: 12px 0 16px;
    }
    .wp-label {
      font-size: 16px;
      font-weight: 600;
      margin-bottom: 8px;
    }
    .wp-row {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
    }
    .thumb {
      position: relative;
      width: 112px;
      height: 76px;
      border: 0;
      border-radius: 14px;
      overflow: hidden;
      cursor: pointer;
      color: #fff;
      font: inherit;
      outline: 2px solid transparent;
      outline-offset: 2px;
    }
    .thumb.on {
      outline-color: var(--primary-color, #4c8dff);
    }
    .thumb span {
      position: absolute;
      left: 8px;
      bottom: 6px;
      font-size: 13px;
      font-weight: 700;
      text-shadow: 0 1px 3px rgba(0, 0, 0, 0.6);
    }
    .thumb.upload {
      display: grid;
      place-items: center;
      background: var(--secondary-background-color, rgba(127, 127, 127, 0.2));
      color: var(--primary-text-color);
      --mdc-icon-size: 24px;
    }
    .thumb.upload span {
      text-shadow: none;
    }
    .url {
      box-sizing: border-box;
      width: 100%;
      margin-top: 10px;
      padding: 10px 12px;
      font: inherit;
      font-size: 15px;
      border: 1px solid var(--divider-color, rgba(127, 127, 127, 0.4));
      border-radius: 10px;
      color: inherit;
      background: none;
    }
    .helpers {
      display: none;
    }
    @media (max-width: 900px) {
      :host {
        height: auto;
        overflow: visible;
      }
      .frame {
        height: auto;
        padding: 16px;
      }
      .pages {
        display: block;
        overflow: visible;
        margin: 0;
        padding: 0;
      }
      .page {
        height: auto;
        margin-bottom: 16px;
      }
      .grid {
        position: static;
        grid-template-columns: repeat(2, minmax(0, 1fr)) !important;
        grid-template-rows: none !important;
        grid-auto-rows: 180px;
      }
      .slot {
        grid-column: span 2 !important;
        grid-row: auto !important;
      }
      .ghosts,
      .dots {
        display: none;
      }
    }
  `;
}

defineElement('homeview-view', HomeViewView);
