import { css, html, nothing, svg, type PropertyValues } from 'lit';
import { state } from 'lit/decorators.js';
import { HomeViewCard, type BaseCardConfig } from '../core/base-card';
import type { ActionConfig, GridOptions, HassEntity } from '../core/types';
import { passes, type StateTest } from '../core/condition';
import { checkCondition } from '../notifications/conditions';
import { themeColor } from '../core/color';
import type { ConditionConfig } from '../notifications/types';
import { greeting, longDate } from '../core/format';
import { eventFromAttributes, fetchCalendarEvents, parseEvents, type CalendarEvent } from '../core/calendar';
import { isCalendar, isTimer, progressColor, progressReading, type ProgressReading, type ProgressSource } from '../core/progress';
import { runAction } from '../core/actions';
import { defineElement, registerCard } from '../core/register';
import { appearanceSection, choose, editorFor, layoutSection, type EditorSpec } from '../core/editor';
import './chips-editor';

/**
 * One chip. Accepts Home Assistant's own badge options (show_name, show_state,
 * show_icon, show_entity_picture, visibility), so badge YAML can be pasted in.
 */
export interface Chip extends Omit<ProgressSource, 'entity' | 'name' | 'icon' | 'color'> {
  /** `entity` (the default) or `progress`: a ring around the icon, with ha-progress-card's options. */
  type?: string;
  entity?: string;
  /** The name to show, or (with neither show_name nor show_state set) the whole label, where {state} is replaced. */
  name?: string;
  icon?: string;
  /** Icon colour: a Home Assistant colour name (amber, red, primary…), `state`, `none`, or any CSS colour. */
  color?: string;
  /** What the state line shows: state, name, last_changed, last_updated, or attribute names. */
  state_content?: string | string[];
  show_name?: boolean;
  show_state?: boolean;
  show_icon?: boolean;
  show_entity_picture?: boolean;
  /** Show the entity's numeric state as a badge in the compact style. */
  badge?: boolean;
  /** Home Assistant visibility conditions: state, numeric_state, screen, user, and, or, not. */
  visibility?: ConditionConfig[];
  show_when?: StateTest;
  attention_when?: StateTest;
  success_when?: StateTest;
  alert_when?: StateTest;
  tap_action?: ActionConfig;
  hold_action?: ActionConfig;
  double_tap_action?: ActionConfig;
  /** Progress chips on a calendar: count all-day events, and how far ahead to look. */
  include_all_day?: boolean;
  look_ahead_days?: number;
}

const isProgress = (c: Chip): boolean => c.type === 'progress';

export interface ChipsCardConfig extends BaseCardConfig {
  /** A: full chips. B: icons only with badges. C: big glance chips. */
  style?: 'full' | 'compact' | 'glance';
  /** Greeting and date on the left, for use as a dashboard header. */
  show_greeting?: boolean;
  align?: 'start' | 'end' | 'center';
  chips: Chip[];
}

type Level = 'calm' | 'attention' | 'success' | 'alert';

const LEVEL: Record<Exclude<Level, 'calm'>, { bg: string; ink: string; icon: string }> = {
  attention: { bg: 'rgba(255,179,64,.92)', ink: '#2a1a00', icon: '#FFB340' },
  success: { bg: 'rgba(76,208,125,.92)', ink: '#06240f', icon: '#4CD07D' },
  alert: { bg: '#E5484D', ink: '#fff', icon: '#E5484D' },
};

/** Icon colours for active states, like Home Assistant's state colours. */
const ACTIVE_COLOR: Record<string, string> = {
  light: '#FFC94D',
  switch: '#FFC94D',
  climate: '#FF8A3D',
  lock: '#4CD07D',
  alarm_control_panel: '#E5484D',
  binary_sensor: '#FFB340',
  vacuum: '#40C8C0',
  media_player: '#BF5AF2',
};
const ACTIVE_STATES = ['on', 'open', 'unlocked', 'heat', 'heating', 'cleaning', 'playing', 'triggered', 'armed_away', 'armed_home', 'armed_night'];

const EDITOR: EditorSpec = {
  schema: () => [
    { name: 'style', selector: choose([['full', 'A: chips'], ['compact', 'B: icons with badges'], ['glance', 'C: big glance chips']], 'list') },
    { type: 'grid', name: '', schema: [{ name: 'show_greeting', selector: { boolean: {} } }, { name: 'align', selector: choose([['start', 'Left'], ['center', 'Centre'], ['end', 'Right']]) }] },
    appearanceSection,
    layoutSection,
  ],
  labels: { style: 'Style', show_greeting: 'Show a greeting and the date', align: 'Align chips' },
  custom: (hass, config, set) =>
    html`<div class="hv-editor-head">Chips</div>
      <homeview-chips-editor .hass=${hass} .chips=${(config.chips as Chip[]) ?? []} @chips-changed=${(e: CustomEvent<Chip[]>) => set({ ...config, chips: e.detail })}></homeview-chips-editor>`,
};

/**
 * Status chips (styles A, B and C): glass while all is well, amber for
 * attention, green when something's done, red and pulsing for alarms.
 * With show_greeting it doubles as the dashboard header.
 */
export class HomeViewChipsCard extends HomeViewCard<ChipsCardConfig> {
  @state() private now = new Date();
  @state() private expanded?: number;
  /** Progress chips: the clock their countdowns run on, which overlapping event shows, and calendar events by entity. */
  @state() private tick = Date.now();
  @state() private cycle = 0;
  @state() private calendars: Record<string, CalendarEvent[]> = {};
  private fetched: Record<string, string> = {};
  private timer?: number;
  private ticker?: number;
  private cycler?: number;
  private holdTimer?: number;
  private tapTimer?: number;
  private held = false;

  static getConfigElement() {
    return editorFor(EDITOR);
  }

  static getStubConfig() {
    return { style: 'full', chips: [] };
  }

  protected validate(config: ChipsCardConfig): void {
    if (!Array.isArray(config.chips)) throw new Error('`chips` must be a list');
  }

  protected defaults(): Partial<ChipsCardConfig> {
    return { style: 'full', align: 'end' };
  }

  /** Every entity a chip, or one of its conditions, refers to. */
  protected watched() {
    const fromConditions = (list?: ConditionConfig[]): string[] =>
      (list ?? []).flatMap((c) => [c.entity ?? '', ...fromConditions(c.conditions)]);
    return this.config.chips.flatMap((c) => [
      c.entity,
      c.show_when?.entity,
      c.attention_when?.entity,
      c.success_when?.entity,
      c.alert_when?.entity,
      c.value_entity,
      c.pin_entity,
      ...fromConditions(c.visibility),
    ]);
  }

  protected defaultAction() {
    return { action: 'none' as const };
  }

  connectedCallback(): void {
    super.connectedCallback();
    if (this.config?.show_greeting) this.timer = window.setInterval(() => (this.now = new Date()), 60_000);
    // Calendar and timer progress counts down by the second; nothing else needs a clock.
    this.ticker = window.setInterval(() => {
      const live = this.config?.chips.some((c) => isProgress(c) && c.entity && (isCalendar(c.entity) || (isTimer(c.entity) && this.hass?.states[c.entity]?.state === 'active')));
      if (live) this.tick = Date.now();
    }, 1000);
    this.cycler = window.setInterval(() => this.cycle++, 8000);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.clearInterval(this.timer);
    window.clearInterval(this.ticker);
    window.clearInterval(this.cycler);
  }

  protected updated(changed: PropertyValues): void {
    super.updated(changed);
    if (!this.hass) return;
    // Calendar progress chips: refetch events whenever the calendar changes state.
    for (const c of this.config.chips) {
      if (!isProgress(c) || !c.entity || !isCalendar(c.entity)) continue;
      const st = this.hass.states[c.entity];
      const key = `${st?.last_changed}|${c.include_all_day ? 1 : 0}`;
      if (this.fetched[c.entity] === key) continue;
      this.fetched[c.entity] = key;
      const entity = c.entity;
      fetchCalendarEvents(this.hass as never, entity, c.look_ahead_days ?? 7)
        .then((raw) => (this.calendars = { ...this.calendars, [entity]: parseEvents(raw, !!c.include_all_day) }))
        .catch(() => {
          const ev = st ? eventFromAttributes(st.attributes, !!c.include_all_day) : undefined;
          this.calendars = { ...this.calendars, [entity]: ev ? [ev] : [] };
        });
    }
  }

  private progress(c: Chip): ProgressReading | undefined {
    if (!isProgress(c) || !c.entity) return undefined;
    return progressReading(this.hass!, c as ProgressSource, { now: this.tick, events: this.calendars[c.entity] ?? [], cycle: this.cycle });
  }

  private visible(c: Chip): boolean {
    const hass = this.hass!;
    if (isProgress(c) && this.progress(c)?.hidden) return false;
    if (c.show_when && !passes(hass, c.show_when, c.entity)) return false;
    if (!c.visibility?.length) return true;
    return c.visibility.every((cond) => checkCondition(cond, { hass: hass as never, template: () => undefined }));
  }

  private level(c: Chip): Level {
    const hass = this.hass!;
    if (passes(hass, c.alert_when, c.entity)) return 'alert';
    if (passes(hass, c.attention_when, c.entity)) return 'attention';
    if (passes(hass, c.success_when, c.entity)) return 'success';
    return 'calm';
  }

  private relative(iso?: string): string {
    const t = iso ? Date.parse(iso) : NaN;
    if (!Number.isFinite(t)) return '';
    const secs = Math.round((t - Date.now()) / 1000);
    const fmt = new Intl.RelativeTimeFormat(this.hass!.locale?.language, { numeric: 'auto' });
    const abs = Math.abs(secs);
    if (abs < 60) return fmt.format(secs, 'second');
    if (abs < 3600) return fmt.format(Math.round(secs / 60), 'minute');
    if (abs < 86400) return fmt.format(Math.round(secs / 3600), 'hour');
    return fmt.format(Math.round(secs / 86400), 'day');
  }

  /** The state line, following state_content like Home Assistant's badges and tiles. */
  private stateText(c: Chip, st: HassEntity | undefined, name: string): string {
    if (!st) return '';
    const content = c.state_content === undefined ? ['state'] : Array.isArray(c.state_content) ? c.state_content : [c.state_content];
    return content
      .map((key) => {
        if (key === 'state') return this.hass!.formatEntityState(st);
        if (key === 'name') return name;
        if (key === 'last_changed' || key === 'last_updated') return this.relative(st[key]);
        if (key === 'last-changed' || key === 'last-updated') return this.relative(st[key.replace('-', '_') as 'last_changed']);
        const value = st.attributes[key];
        return value === undefined || value === null || value === '' ? '' : this.hass!.formatEntityAttributeValue(st, key);
      })
      .filter(Boolean)
      .join(' · ');
  }

  /** [name line, state line]. Either can be empty. */
  private lines(c: Chip, st?: HassEntity): [string, string] {
    const name = (typeof c.name === 'string' ? c.name : undefined) ?? st?.attributes.friendly_name ?? '';
    // A plain label from earlier HomeView configs: "Bins {state}".
    if (c.show_name === undefined && c.show_state === undefined && c.state_content === undefined && typeof c.name === 'string' && c.name) {
      return ['', c.name.replace('{state}', st ? this.hass!.formatEntityState(st) : '')];
    }
    const showName = c.show_name ?? false;
    const showState = c.show_state ?? true;
    return [showName ? name : '', showState ? this.stateText(c, st, name) : ''];
  }

  private act(c: Chip, kind: 'tap' | 'hold' | 'double_tap') {
    if (!this.hass || this.preview) return;
    const fallback = c.entity && kind !== 'double_tap' ? { action: 'more-info' as const } : undefined;
    const action = (kind === 'tap' ? c.tap_action : kind === 'hold' ? c.hold_action : c.double_tap_action) ?? fallback;
    void runAction({ node: this, hass: this.hass, entity: c.entity }, action);
  }

  private down(c: Chip) {
    return () => {
      this.held = false;
      window.clearTimeout(this.holdTimer);
      this.holdTimer = window.setTimeout(() => {
        this.held = true;
        this.act(c, 'hold');
      }, 500);
    };
  }

  private onClick(c: Chip, i: number) {
    return (ev: Event) => {
      ev.stopPropagation();
      window.clearTimeout(this.holdTimer);
      if (this.held) return;
      if (this.config.style === 'compact' && this.expanded !== i) {
        this.expanded = i;
        window.setTimeout(() => this.expanded === i && (this.expanded = undefined), 4000);
        return;
      }
      if (c.double_tap_action && c.double_tap_action.action !== 'none') {
        // Wait briefly to tell a single tap from a double tap.
        if (this.tapTimer) {
          window.clearTimeout(this.tapTimer);
          this.tapTimer = undefined;
          this.act(c, 'double_tap');
          return;
        }
        this.tapTimer = window.setTimeout(() => {
          this.tapTimer = undefined;
          this.act(c, 'tap');
        }, 250);
        return;
      }
      this.act(c, 'tap');
    };
  }

  private iconColor(c: Chip, st?: HassEntity): string | undefined {
    if (c.color === 'none') return undefined;
    if (c.color && c.color !== 'state') return themeColor(c.color);
    if (!st) return undefined;
    const domain = st.entity_id.split('.')[0];
    return ACTIVE_STATES.includes(st.state) ? ACTIVE_COLOR[domain] : undefined;
  }

  /** The icon inside a ring that fills clockwise from the top, in the progress colour. */
  private ringVisual(c: Chip, st: HassEntity | undefined, r: ProgressReading) {
    const color = progressColor(c as ProgressSource, r);
    const icon = c.icon || r.icon;
    const R = 16.5;
    const C = 2 * Math.PI * R;
    return html`<i class="ring" style="color:${color}">
      ${svg`<svg viewBox="0 0 36 36" aria-hidden="true">
        <circle cx="18" cy="18" r=${R} class="track"></circle>
        <circle cx="18" cy="18" r=${R} class="arc" style="stroke:${color}" stroke-dasharray="${(r.fraction * C).toFixed(2)} ${C.toFixed(2)}" transform="rotate(-90 18 18)"></circle>
      </svg>`}
      ${icon ? html`<ha-icon .icon=${icon}></ha-icon>` : st ? html`<ha-state-icon .hass=${this.hass} .stateObj=${st}></ha-state-icon>` : nothing}
    </i>`;
  }

  private visual(c: Chip, st: HassEntity | undefined, level: Level) {
    const filled = level !== 'calm' ? LEVEL[level] : undefined;
    const r = this.progress(c);
    if (r) return this.ringVisual(c, st, r);
    const picture = c.show_entity_picture && st?.attributes.entity_picture ? this.hass!.hassUrl(st.attributes.entity_picture) : undefined;
    if (picture) return html`<i class="pic" style="background-image:url('${picture}')"></i>`;
    if (c.show_icon === false) return nothing;
    const icon = c.icon
      ? html`<ha-icon .icon=${c.icon}></ha-icon>`
      : st
        ? html`<ha-state-icon .hass=${this.hass} .stateObj=${st}></ha-state-icon>`
        : html`<ha-icon icon="mdi:information-outline"></ha-icon>`;
    const color = filled ? filled.ink : this.iconColor(c, st);
    return html`<i style="color:${color ?? 'var(--_ink)'}">${icon}</i>`;
  }

  private chip(c: Chip, i: number) {
    const st = c.entity ? this.hass!.states[c.entity] : undefined;
    const level = this.level(c);
    const style = this.config.style ?? 'full';
    const filled = level !== 'calm' ? LEVEL[level] : undefined;
    const r = this.progress(c);
    const [nameLine, stateLine] = r
      ? [c.show_name === false ? '' : r.name, c.show_state === false ? '' : r.done ? 'Done' : r.value]
      : this.lines(c, st);
    const label = [nameLine, stateLine, r && !r.done ? `${Math.round(r.fraction * 100)}%` : ''].filter(Boolean).join(' · ');
    const handlers = { down: this.down(c), click: this.onClick(c, i) };
    if (style === 'compact' && this.expanded !== i) {
      const n = c.badge && st ? Number(st.state) : NaN;
      return html`<button class="dotc ${filled ? '' : 'gl'} ${level === 'alert' ? 'pulse' : ''}" aria-label=${label} style=${filled ? `background:${filled.bg};color:${filled.ink}` : ''} @pointerdown=${handlers.down} @click=${handlers.click}>
        ${this.visual(c, st, level)}${Number.isFinite(n) && n > 0 ? html`<em style="background:${filled ? filled.ink : this.iconColor(c, st) ?? 'var(--hv-c-progress)'};color:${filled ? filled.bg : '#fff'}">${n}</em>` : nothing}
      </button>`;
    }
    const two = !!nameLine && !!stateLine;
    return html`<button class="chip ${style === 'glance' ? 'big' : ''} ${filled ? '' : 'gl'} ${level === 'alert' ? 'pulse' : ''} ${two ? 'two' : ''}" aria-label=${label} style=${filled ? `background:${filled.bg};color:${filled.ink}` : ''} @pointerdown=${handlers.down} @click=${handlers.click}>
      ${this.visual(c, st, level)}
      ${two
        ? html`<span class="lines"><small>${nameLine}</small><b>${stateLine}</b></span>`
        : html`<b>${nameLine || stateLine}</b>`}
    </button>`;
  }

  render() {
    if (!this.hass) return nothing;
    const chips = this.config.chips.map((c, i) => ({ c, i })).filter(({ c }) => this.visible(c));
    const row = html`<div class="row ${this.config.align}">${chips.map(({ c, i }) => this.chip(c, i))}</div>`;
    if (!this.config.show_greeting) return row;
    return html`<div class="header">
      <div class="greet"><h1>${greeting(this.now)}</h1><span>${longDate(this.hass, this.now)}</span></div>
      ${row}
    </div>`;
  }

  getGridOptions(): GridOptions {
    return { columns: 'full', rows: 1, min_rows: 1 };
  }

  getCardSize(): number {
    return 1;
  }

  static styles = [
    ...HomeViewCard.styles,
    css`
      :host {
        height: auto;
      }
      .header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        min-height: 64px;
        flex-wrap: wrap;
      }
      .greet {
        display: flex;
        align-items: baseline;
        gap: 18px;
        min-width: 0;
      }
      h1 {
        margin: 0;
        font-size: 36px;
        font-weight: 700;
        letter-spacing: -0.02em;
      }
      .greet span {
        font-size: 21px;
        font-weight: 500;
        color: var(--_ink2);
      }
      .row {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        align-items: center;
      }
      .row.end {
        justify-content: flex-end;
      }
      .row.center {
        justify-content: center;
      }
      .chip,
      .dotc {
        position: relative;
        display: inline-flex;
        align-items: center;
        border: 0;
        font: inherit;
        color: var(--_ink);
        cursor: pointer;
        white-space: nowrap;
        -webkit-tap-highlight-color: transparent;
      }
      .chip {
        gap: 10px;
        height: 52px;
        padding: 0 20px 0 8px;
        border-radius: 999px;
        font-size: 17px;
      }
      .chip b {
        font-weight: 600;
      }
      .chip i,
      .dotc i {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 36px;
        height: 36px;
        border-radius: 999px;
        font-style: normal;
        background: rgba(255, 255, 255, 0.12);
        --mdc-icon-size: 21px;
        flex: none;
      }
      :host([mode='light']) .chip i {
        background: rgba(15, 17, 21, 0.06);
      }
      .chip i.pic,
      .dotc i.pic {
        background: center / cover no-repeat;
      }
      /* Progress: the ring replaces the icon's disc, with the icon a little smaller inside it. */
      .chip i.ring,
      .dotc i.ring {
        position: relative;
        background: none;
        --mdc-icon-size: 18px;
      }
      .chip.big i.ring {
        --mdc-icon-size: 21px;
      }
      i.ring svg {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
      }
      i.ring circle {
        fill: none;
        stroke-width: 3;
      }
      i.ring .track {
        stroke: var(--_track);
      }
      i.ring .arc {
        stroke-linecap: round;
        transition: stroke-dasharray 0.6s ease;
      }
      .lines {
        display: flex;
        flex-direction: column;
        line-height: 1.1;
        text-align: left;
      }
      .lines small {
        font-size: 14px;
        font-weight: 600;
        color: var(--_ink2);
      }
      .lines b {
        font-size: 17px;
      }
      .chip.big {
        height: 60px;
        gap: 12px;
        padding: 0 24px 0 9px;
        font-size: 21px;
      }
      .chip.big i {
        width: 42px;
        height: 42px;
        --mdc-icon-size: 24px;
      }
      .dotc {
        justify-content: center;
        width: 56px;
        height: 56px;
        border-radius: 999px;
      }
      .dotc i {
        background: none;
      }
      .dotc em {
        position: absolute;
        right: -4px;
        top: -4px;
        min-width: 22px;
        height: 22px;
        padding: 0 6px;
        box-sizing: border-box;
        border-radius: 999px;
        font-style: normal;
        font-size: 13px;
        font-weight: 700;
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 6;
      }
      .pulse {
        animation: pulse 1.4s ease-in-out infinite;
      }
      @keyframes pulse {
        50% {
          opacity: 0.55;
        }
      }
      @media (prefers-reduced-motion: reduce) {
        .pulse {
          animation: none;
        }
      }
    `,
  ];
}

defineElement('homeview-chips-card', HomeViewChipsCard);
registerCard({
  type: 'homeview-chips-card',
  name: 'HomeView Status chips',
  description: 'Status chips with entity pictures and visibility conditions that turn amber, green or red when something needs you. Can show a greeting as a header.',
  docs: 'chips',
});
