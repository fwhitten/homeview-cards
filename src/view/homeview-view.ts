import { LitElement, css, html, nothing, type PropertyValues } from 'lit';
import { property, state } from 'lit/decorators.js';
import type { HomeAssistant, LovelaceCard, LovelaceCardConfig } from '../core/types';
import { resolveMode, store, type Appearance, type Mode } from '../core/store';
import { defineElement } from '../core/register';
import { fireEvent } from '../core/events';
import type { Chip } from '../cards/chips-card';
import type { AmbientConfig } from '../cards/ambient-card';

export interface HomeViewViewConfig {
  type?: string;
  title?: string;
  appearance?: Appearance;
  night_entity?: string;
  /** One image for every mode, or one per mode. */
  wallpaper?: string | { light?: string; dark?: string; night?: string };
  /** Grid size. `auto` (the default) fits ~200px tiles to the screen: 6 × 4 on a landscape iPad Pro. */
  columns?: number | 'auto';
  rows?: number | 'auto';
  /** How many screens to swipe between. Cards pick theirs with view_layout.screen. */
  screens?: number;
  header?: { greeting?: boolean; style?: 'full' | 'compact'; chips?: Chip[] };
  ambient?: Omit<AmbientConfig, 'type'>;
  /** Same options as the HomeView notifications card. */
  notifications?: Record<string, unknown>;
}

interface ViewLayout {
  screen?: number;
  column?: number;
  row?: number;
  column_span?: number;
  row_span?: number;
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

interface Placed {
  index: number;
  screen: number;
  column?: number;
  row?: number;
  colSpan: number;
  rowSpan: number;
}

interface Drag {
  index: number;
  mode: 'move' | 'resize';
  page: HTMLElement;
  startX: number;
  startY: number;
  placed: Placed;
  target?: { column: number; row: number; colSpan: number; rowSpan: number };
}

const TILE = 200;
const GAP = 20;
const PAD = 28;

const WALLPAPER_DARK =
  'radial-gradient(900px 700px at 12% 8%,#35507f 0%,rgba(53,80,127,0) 62%),radial-gradient(800px 700px at 88% 22%,#6a3b66 0%,rgba(106,59,102,0) 60%),radial-gradient(1100px 800px at 55% 105%,#1d5050 0%,rgba(29,80,80,0) 60%),#0c0f17';
const WALLPAPER_LIGHT =
  'radial-gradient(900px 700px at 12% 8%,#c4d8f2 0%,rgba(196,216,242,0) 62%),radial-gradient(800px 700px at 88% 22%,#f1d3e2 0%,rgba(241,211,226,0) 60%),radial-gradient(1100px 800px at 55% 105%,#cde9dc 0%,rgba(205,233,220,0) 60%),#e8ecf2';

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

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
 * notifications built in. In edit mode cards can be moved and resized by
 * dragging, sent to another screen, edited or deleted.
 */
export class HomeViewView extends LitElement {
  @property({ attribute: false }) hass?: HomeAssistant;
  @property({ attribute: false }) lovelace?: Lovelace;
  @property({ type: Boolean }) narrow = false;
  @property({ attribute: false }) path: Array<string | number> = [];
  @property({ attribute: false }) cards: HuiCard[] = [];
  @property({ attribute: false }) badges: HTMLElement[] = [];
  @property({ reflect: true }) mode: Mode = 'dark';
  @state() private config: HomeViewViewConfig = {};
  @state() private cols = 6;
  @state() private rows = 4;
  @state() private page = 0;
  @state() private drag?: Drag;
  private header?: HTMLElement & { hass?: HomeAssistant; setConfig(c: unknown): void };
  private ambient?: HTMLElement & { hass?: HomeAssistant; setConfig(c: unknown): void };
  private notifier?: HTMLElement & { hass?: HomeAssistant; setConfig(c: unknown): void };
  private trim = 0;
  private trimTries = 0;
  private resizer?: ResizeObserver;

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
   * Fill exactly the space below the view's top edge, then work out how many
   * columns and rows fit. HA's --header-height stays set when kiosk tools hide
   * the header, so measure instead, and trim anything that still overflows.
   */
  private fit = (): void => {
    if (window.matchMedia('(max-width: 900px)').matches) {
      this.style.removeProperty('--hv-view-height');
      return;
    }
    const top = Math.max(0, this.getBoundingClientRect().top + (document.scrollingElement?.scrollTop ?? 0));
    const viewport = window.visualViewport?.height ?? window.innerHeight;
    const height = Math.max(320, Math.floor(viewport - top - this.trim));
    this.style.setProperty('--hv-view-height', `${height}px`);

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
      const scroller = scrollerAbove(this);
      const over = scroller.scrollHeight - scroller.clientHeight;
      if (over > 0 && over < 160 && this.trimTries < 4) {
        this.trim += over;
        this.trimTries++;
        this.fit();
      }
    });
  };

  private onResize = (): void => {
    this.trim = 0;
    this.trimTries = 0;
    this.fit();
  };

  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener('resize', this.onResize);
    window.visualViewport?.addEventListener('resize', this.onResize);
    // The header can appear or disappear (kiosk mode, edit mode) without a window resize.
    this.resizer = new ResizeObserver(() => this.fit());
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

  private wallpaper(): string {
    const w = this.config.wallpaper;
    const url = typeof w === 'string' ? w : w?.[this.mode] ?? (this.mode === 'night' ? w?.dark : undefined);
    if (url) return `center / cover no-repeat url("${url.replace(/"/g, '%22')}")`;
    return this.mode === 'light' ? WALLPAPER_LIGHT : WALLPAPER_DARK;
  }

  // ---------------------------------------------------------------- placement

  private layoutOf(card: HuiCard): ViewLayout {
    return (card.config?.view_layout ?? {}) as ViewLayout;
  }

  private place(card: HuiCard, index: number): Placed {
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
    return {
      index,
      screen: Math.max(1, layout.screen ?? 1),
      column: layout.column,
      row: layout.row,
      colSpan: Math.min(this.cols, colSpan),
      rowSpan: Math.min(this.rows, rowSpan),
    };
  }

  private gridArea(p: Placed): string {
    const col = p.column ? `${Math.min(p.column, this.cols)} / span ${p.colSpan}` : `span ${p.colSpan}`;
    const row = p.row ? `${Math.min(p.row, this.rows)} / span ${p.rowSpan}` : `span ${p.rowSpan}`;
    return `grid-column:${col};grid-row:${row}`;
  }

  private get screenCount(): number {
    const used = this.cards.reduce((n, c) => Math.max(n, this.layoutOf(c).screen ?? 1), 1);
    return Math.max(this.config.screens ?? 1, used);
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
    const nums = this.path.filter((p): p is number => typeof p === 'number');
    return nums.length ? nums[nums.length - 1] : 0;
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

  private setLayout(index: number, patch: ViewLayout): void {
    void this.save((view) => {
      const card = view.cards?.[index];
      if (!card) return;
      const next: Record<string, unknown> = { ...(card.view_layout ?? {}), ...patch };
      for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
      card.view_layout = next;
    });
  }

  private edit(index: number): void {
    fireEvent(this, 'll-edit-card', { path: [...this.path, 'cards', index] });
  }

  private deleteCard(index: number): void {
    fireEvent(this, 'll-delete-card', { path: [...this.path, 'cards', index], silent: false });
  }

  private add(): void {
    fireEvent(this, 'll-create-card', { path: [...this.path, 'cards'] });
  }

  private moveScreen(p: Placed, dir: -1 | 1): void {
    const screen = clamp(p.screen + dir, 1, this.screenCount + 1);
    const grow = screen > this.screenCount;
    // A new screen means a new spot: let the card flow into the first free cells.
    void this.save((view) => {
      const card = view.cards?.[p.index];
      if (!card) return;
      const { column: _c, row: _r, ...rest } = card.view_layout ?? {};
      card.view_layout = { ...rest, screen };
      if (grow) view.screens = screen;
    });
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
    const slot = (ev.currentTarget as HTMLElement).closest('.slot') as HTMLElement;
    const page = slot.closest('.page') as HTMLElement;
    // Resolve where the card actually sits, even when it was placed automatically.
    const rect = slot.getBoundingClientRect();
    const origin = this.cellAt(page, rect.left + 4, rect.top + 4);
    this.drag = { index: p.index, mode, page, startX: ev.clientX, startY: ev.clientY, placed: { ...p, column: origin.column, row: origin.row } };
    window.addEventListener('pointermove', this.onDragMove);
    window.addEventListener('pointerup', this.onDragEnd, { once: true });
    window.addEventListener('pointercancel', this.onDragEnd, { once: true });
  }

  private onDragMove = (ev: PointerEvent): void => {
    const d = this.drag;
    if (!d) return;
    const p = d.placed;
    if (d.mode === 'move') {
      const r = d.page.getBoundingClientRect();
      const cw = (r.width + GAP) / this.cols;
      const rh = (r.height + GAP) / this.rows;
      const column = clamp(p.column! + Math.round((ev.clientX - d.startX) / cw), 1, this.cols - p.colSpan + 1);
      const row = clamp(p.row! + Math.round((ev.clientY - d.startY) / rh), 1, this.rows - p.rowSpan + 1);
      this.drag = { ...d, target: { column, row, colSpan: p.colSpan, rowSpan: p.rowSpan } };
    } else {
      const cell = this.cellAt(d.page, ev.clientX, ev.clientY);
      const colSpan = clamp(cell.column - p.column! + 1, 1, this.cols - p.column! + 1);
      const rowSpan = clamp(cell.row - p.row! + 1, 1, this.rows - p.row! + 1);
      this.drag = { ...d, target: { column: p.column!, row: p.row!, colSpan, rowSpan } };
    }
  };

  private onDragEnd = (): void => {
    window.removeEventListener('pointermove', this.onDragMove);
    const d = this.drag;
    this.drag = undefined;
    if (!d?.target) return;
    const t = d.target;
    const p = d.placed;
    if (t.column === p.column && t.row === p.row && t.colSpan === p.colSpan && t.rowSpan === p.rowSpan) return;
    this.setLayout(d.index, { column: t.column, row: t.row, column_span: t.colSpan, row_span: t.rowSpan });
  };

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
    const head = this.renderRoot.querySelector('.head');
    if (this.header && head && this.header.parentElement !== head) head.replaceChildren(this.header);
  }

  private renderSlot(p: Placed, editing: boolean) {
    const dragging = this.drag?.index === p.index;
    return html`<div class="slot ${dragging ? 'dragging' : ''}" style=${this.gridArea(p)}>
      <div class="cell" data-index=${p.index}></div>
      ${editing
        ? html`<div class="edit">
            <div class="mover" title="Drag to move" @pointerdown=${(e: PointerEvent) => this.startDrag(e, p, 'move')}></div>
            <div class="tools">
              ${p.screen > 1
                ? html`<button aria-label="Move to the previous screen" @click=${() => this.moveScreen(p, -1)}><ha-icon icon="mdi:chevron-left"></ha-icon></button>`
                : nothing}
              <button aria-label="Move to the next screen" @click=${() => this.moveScreen(p, 1)}><ha-icon icon="mdi:chevron-right"></ha-icon></button>
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
    const screens = this.screenCount;
    const placed = this.cards.map((card, i) => this.place(card, i));
    const gridStyle = `grid-template-columns:repeat(${this.cols},minmax(0,1fr));grid-template-rows:repeat(${this.rows},minmax(0,1fr))`;
    const d = this.drag;
    return html`
      <div class="wall" style="background:${this.wallpaper()}"></div>
      <div class="frame">
        ${this.config.header ? html`<div class="head"></div>` : nothing}
        <div class="pages ${editing ? 'editing' : ''}" @scroll=${this.onScroll}>
          ${Array.from({ length: screens }, (_, s) => {
            const here = placed.filter((p) => Math.min(p.screen, screens) === s + 1);
            return html`<div class="page" aria-label="Screen ${s + 1} of ${screens}">
              ${editing ? html`<div class="ghosts" style=${gridStyle}>${Array.from({ length: this.cols * this.rows }, () => html`<i></i>`)}</div>` : nothing}
              <div class="grid" style=${gridStyle}>
                ${here.map((p) => this.renderSlot(p, editing))}
                ${d?.target && placed[d.index]?.screen === s + 1
                  ? html`<div class="drop" style="grid-column:${d.target.column} / span ${d.target.colSpan};grid-row:${d.target.row} / span ${d.target.rowSpan}"></div>`
                  : nothing}
              </div>
            </div>`;
          })}
        </div>
      </div>
      ${editing
        ? html`<div class="editbar">
            <button @click=${() => this.add()}><ha-icon icon="mdi:plus"></ha-icon>Card</button>
            <button @click=${() => this.addScreen()}><ha-icon icon="mdi:plus-box-multiple-outline"></ha-icon>Screen</button>
            ${screens > 1 && !placed.some((p) => p.screen >= screens)
              ? html`<button @click=${() => this.removeScreen()}><ha-icon icon="mdi:minus-box-multiple-outline"></ha-icon>Last screen</button>`
              : nothing}
          </div>`
        : nothing}
      ${screens > 1
        ? html`<div class="dots" role="tablist" aria-label="Screens">
            ${Array.from({ length: screens }, (_, i) => html`<button role="tab" aria-selected=${i === this.page} aria-label="Screen ${i + 1}" @click=${() => this.goTo(i)}></button>`)}
          </div>`
        : nothing}
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
      flex: none;
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
    .grid {
      grid-auto-flow: dense;
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
    .dots {
      position: absolute;
      left: 0;
      right: 0;
      bottom: 3px;
      display: flex;
      justify-content: center;
      gap: 4px;
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
    .edit {
      position: absolute;
      inset: 0;
      z-index: 10;
      border-radius: 30px;
      outline: 2px dashed rgba(255, 255, 255, 0.5);
      outline-offset: 3px;
    }
    .mover {
      position: absolute;
      inset: 0;
      cursor: grab;
      touch-action: none;
    }
    .tools {
      position: absolute;
      top: 8px;
      right: 8px;
      display: flex;
      gap: 6px;
    }
    .tools button {
      border: 0;
      cursor: pointer;
      font: inherit;
      color: #fff;
      background: rgba(20, 18, 32, 0.75);
      -webkit-backdrop-filter: blur(10px);
      backdrop-filter: blur(10px);
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
      color: #fff;
      background: rgba(20, 18, 32, 0.75);
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
    .editbar button {
      display: flex;
      align-items: center;
      gap: 4px;
      height: 26px;
      padding: 0 12px 0 8px;
      border: 0;
      border-radius: 999px;
      font: inherit;
      font-size: 14px;
      font-weight: 600;
      color: #fff;
      background: rgba(20, 18, 32, 0.75);
      cursor: pointer;
      --mdc-icon-size: 16px;
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
