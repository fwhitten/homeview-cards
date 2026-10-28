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
  /** Grid size. The 13″ iPad layout is 6 × 4. */
  columns?: number;
  rows?: number;
  header?: { greeting?: boolean; style?: 'full' | 'compact'; chips?: Chip[] };
  ambient?: Omit<AmbientConfig, 'type'>;
  /** Same options as the HomeView notifications card. */
  notifications?: Record<string, unknown>;
}

interface Lovelace {
  editMode: boolean;
  config: unknown;
}

interface HuiCard extends LovelaceCard {
  config?: LovelaceCardConfig;
}

const WALLPAPER_DARK =
  'radial-gradient(900px 700px at 12% 8%,#35507f 0%,rgba(53,80,127,0) 62%),radial-gradient(800px 700px at 88% 22%,#6a3b66 0%,rgba(106,59,102,0) 60%),radial-gradient(1100px 800px at 55% 105%,#1d5050 0%,rgba(29,80,80,0) 60%),#0c0f17';
const WALLPAPER_LIGHT =
  'radial-gradient(900px 700px at 12% 8%,#c4d8f2 0%,rgba(196,216,242,0) 62%),radial-gradient(800px 700px at 88% 22%,#f1d3e2 0%,rgba(241,211,226,0) 60%),radial-gradient(1100px 800px at 55% 105%,#cde9dc 0%,rgba(205,233,220,0) 60%),#e8ecf2';

/**
 * HomeView's wall-panel view: a fixed grid sized to the screen (6 × 4 on a
 * 13″ iPad), the wallpaper behind glass cards, a greeting header with status
 * chips, and the ambient clock and notifications built in.
 *
 * Place cards with view_layout (column, row, column_span, row_span), or let
 * them flow using each card's own size.
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
  private header?: HTMLElement & { hass?: HomeAssistant; setConfig(c: unknown): void };
  private ambient?: HTMLElement & { hass?: HomeAssistant; setConfig(c: unknown): void };
  private notifier?: HTMLElement & { hass?: HomeAssistant; setConfig(c: unknown): void };

  setConfig(config: HomeViewViewConfig): void {
    this.config = { columns: 6, rows: 4, ...config };
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

  private place(card: HuiCard): string {
    const cols = this.config.columns ?? 6;
    const layout = (card.config?.view_layout ?? {}) as { column?: number; row?: number; column_span?: number; row_span?: number };
    let colSpan = layout.column_span;
    let rowSpan = layout.row_span;
    if (colSpan === undefined || rowSpan === undefined) {
      // Translate the card's sections size (12 columns, 56px rows) onto this grid.
      const opts = card.getGridOptions?.() ?? {};
      const c = opts.columns === 'full' ? 12 : opts.columns ?? 6;
      const r = typeof opts.rows === 'number' ? opts.rows : 3;
      colSpan ??= Math.min(cols, Math.max(1, Math.round(c / 6)));
      rowSpan ??= Math.max(1, Math.round(r / 3));
    }
    const col = layout.column ? `${layout.column} / span ${colSpan}` : `span ${colSpan}`;
    const row = layout.row ? `${layout.row} / span ${rowSpan}` : `span ${rowSpan}`;
    return `grid-column:${col};grid-row:${row}`;
  }

  private edit(index: number): void {
    fireEvent(this, 'll-edit-card', { path: [...this.path, 'cards', index] });
  }

  private add(): void {
    fireEvent(this, 'll-create-card', { path: [...this.path, 'cards'] });
  }

  protected updated(): void {
    const slots = this.renderRoot.querySelectorAll<HTMLElement>('.cell');
    slots.forEach((slot, i) => {
      const card = this.cards[i];
      if (card && card.parentElement !== slot) slot.replaceChildren(card);
      if (card) {
        card.hass = this.hass;
        (card as unknown as { editMode?: boolean }).editMode = !!this.lovelace?.editMode;
      }
    });
    const helpers = this.renderRoot.querySelector('.helpers');
    for (const el of [this.ambient, this.notifier]) if (el && helpers && el.parentElement !== helpers) helpers.appendChild(el);
    const head = this.renderRoot.querySelector('.head');
    if (this.header && head && this.header.parentElement !== head) head.replaceChildren(this.header);
  }

  render() {
    const editing = !!this.lovelace?.editMode;
    const cols = this.config.columns ?? 6;
    const rows = this.config.rows ?? 4;
    return html`
      <div class="wall" style="background:${this.wallpaper()}"></div>
      ${this.config.header ? html`<div class="head"></div>` : nothing}
      <div class="grid ${editing ? 'editing' : ''}" style="grid-template-columns:repeat(${cols},minmax(0,1fr));grid-template-rows:repeat(${rows},minmax(0,1fr))">
        ${this.cards.map(
          (card, i) => html`<div class="slot" style=${this.place(card)}>
            <div class="cell"></div>
            ${editing ? html`<button class="editbtn" aria-label="Edit card ${i + 1}" @click=${() => this.edit(i)}><ha-icon icon="mdi:pencil"></ha-icon></button>` : nothing}
          </div>`,
        )}
        ${editing ? html`<button class="addbtn" @click=${() => this.add()}><ha-icon icon="mdi:plus"></ha-icon>Add card</button>` : nothing}
      </div>
      <div class="helpers"></div>
    `;
  }

  static styles = css`
    :host {
      position: relative;
      display: flex;
      flex-direction: column;
      gap: 20px;
      box-sizing: border-box;
      min-height: calc(100vh - var(--header-height, 56px));
      min-height: calc(100dvh - var(--header-height, 56px));
      height: calc(100dvh - var(--header-height, 56px));
      padding: 28px;
      overflow: hidden;
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
    .head {
      flex: none;
    }
    .grid {
      flex: 1;
      min-height: 0;
      display: grid;
      gap: 20px;
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
    .editing .slot {
      outline: 2px dashed rgba(255, 255, 255, 0.35);
      outline-offset: 4px;
      border-radius: 30px;
    }
    .editbtn,
    .addbtn {
      border: 0;
      cursor: pointer;
      font: inherit;
      color: #fff;
      background: rgba(20, 18, 32, 0.7);
      -webkit-backdrop-filter: blur(10px);
      backdrop-filter: blur(10px);
    }
    .editbtn {
      position: absolute;
      top: 8px;
      right: 8px;
      z-index: 10;
      width: 44px;
      height: 44px;
      border-radius: 999px;
    }
    .addbtn {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      border-radius: 30px;
      font-size: 17px;
      font-weight: 600;
      min-height: 120px;
    }
    .helpers {
      display: none;
    }
    @media (max-width: 900px) {
      :host {
        height: auto;
        overflow: visible;
        padding: 16px;
      }
      .grid {
        grid-template-columns: repeat(2, minmax(0, 1fr)) !important;
        grid-template-rows: none !important;
        grid-auto-rows: 180px;
      }
      .slot {
        grid-column: span 2 !important;
        grid-row: auto !important;
      }
    }
  `;
}

defineElement('homeview-view', HomeViewView);
