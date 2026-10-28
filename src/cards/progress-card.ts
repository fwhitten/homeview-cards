import { css, html, nothing, svg, type PropertyValues } from 'lit';
import { state } from 'lit/decorators.js';
import { HomeViewCard, type BaseCardConfig } from '../core/base-card';
import type { GridOptions, HassEntity } from '../core/types';
import { duration, isUnavailable, numericState, time } from '../core/format';
import { eventFromAttributes, eventsInProgress, fetchCalendarEvents, nextEventAfter, parseEvents, type CalendarEvent } from '../core/calendar';
import { inkFor, parseHex } from '../core/color';
import { defineElement, registerCard } from '../core/register';

export interface Threshold {
  value: number;
  color: string;
}

export interface ProgressCardConfig extends BaseCardConfig {
  entity: string;
  attribute?: string;
  /** A: fill (the ink flips under it). B: ring. C: dots. */
  design?: 'fill' | 'ring' | 'dots';
  min?: number;
  max?: number;
  color?: string;
  /** The colour of the highest stop the value has reached wins. */
  thresholds?: Threshold[];
  /** Entities whose states show under the name, joined with a dot. */
  secondary_entities?: string[];
  /** Replaces the value with another entity's formatted state. */
  value_entity?: string;
  /** While pin_entity is in one of pin_states, the bar is forced to pin_value. */
  pin_entity?: string;
  pin_states?: string[];
  pin_value?: 'max' | 'min' | number;
  /** Calendars: when the card hides itself. */
  hide_when?: 'never' | 'no_events_today' | 'no_events';
  include_all_day?: boolean;
  look_ahead_days?: number;
  /** Seconds between events when several are in progress. */
  cycle_interval?: number;
}

interface Reading {
  fraction: number;
  value: string;
  name: string;
  sub: string;
  icon: string;
  hidden?: boolean;
}

const BLUE = '#4C8DFF';

/**
 * Progress (designs fill, ring and dots at every size): an appliance, a
 * battery, a timer, or the event in progress on a calendar.
 */
export class HomeViewProgressCard extends HomeViewCard<ProgressCardConfig> {
  @state() private events: CalendarEvent[] = [];
  @state() private now = Date.now();
  @state() private cycle = 0;
  private ticker?: number;
  private cycler?: number;
  private fetchedFor?: string;

  static getConfigForm() {
    return {
      schema: [
        { name: 'entity', required: true, selector: { entity: {} } },
        { name: 'design', default: 'fill', selector: { select: { options: [{ value: 'fill', label: 'A: fill' }, { value: 'ring', label: 'B: ring' }, { value: 'dots', label: 'C: dots' }] } } },
        {
          type: 'grid',
          name: '',
          schema: [
            { name: 'name', selector: { text: {} } },
            { name: 'icon', selector: { icon: {} }, context: { icon_entity: 'entity' } },
            { name: 'attribute', selector: { attribute: {} }, context: { filter_entity: 'entity' } },
            { name: 'color', selector: { text: {} } },
            { name: 'min', selector: { number: { mode: 'box' } } },
            { name: 'max', selector: { number: { mode: 'box' } } },
          ],
        },
        { name: 'secondary_entities', selector: { entity: { multiple: true } } },
        { name: 'value_entity', selector: { entity: {} } },
        {
          name: 'thresholds',
          selector: {
            object: {
              multiple: true,
              label_field: 'value',
              fields: {
                value: { label: 'From', required: true, selector: { number: { mode: 'box' } } },
                color: { label: 'Colour', required: true, selector: { text: {} } },
              },
            },
          },
        },
        {
          type: 'expandable',
          name: '',
          title: 'Pinning',
          schema: [
            { name: 'pin_entity', selector: { entity: {} } },
            { name: 'pin_states', selector: { text: { multiple: true } } },
            { name: 'pin_value', selector: { text: {} } },
          ],
        },
        {
          type: 'expandable',
          name: '',
          title: 'Calendars',
          schema: [
            { name: 'hide_when', default: 'never', selector: { select: { options: ['never', 'no_events_today', 'no_events'] } } },
            { name: 'include_all_day', default: false, selector: { boolean: {} } },
            { name: 'look_ahead_days', default: 7, selector: { number: { min: 1, max: 60 } } },
          ],
        },
        { name: 'tap_action', selector: { ui_action: {} } },
      ],
    };
  }

  static getStubConfig(_hass: unknown, entities: string[], fallback: string[]) {
    const pick = [...entities, ...fallback].find((e) => e.startsWith('timer.') || e.startsWith('sensor.'));
    return { entity: pick ?? '', design: 'fill' };
  }

  protected validate(config: ProgressCardConfig): void {
    if (!config.entity) throw new Error('Set an entity');
  }

  protected defaults(): Partial<ProgressCardConfig> {
    return { design: 'fill', hide_when: 'never', include_all_day: false, look_ahead_days: 7, cycle_interval: 8 };
  }

  protected watched() {
    return [this.config.entity, this.config.value_entity, this.config.pin_entity, ...(this.config.secondary_entities ?? [])];
  }

  private get isCalendar(): boolean {
    return this.config.entity.startsWith('calendar.');
  }

  private get isTimer(): boolean {
    return this.config.entity.startsWith('timer.');
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.ticker = window.setInterval(() => {
      if (this.isCalendar || (this.isTimer && this.stateObj()?.state === 'active')) this.now = Date.now();
    }, 1000);
    this.cycler = window.setInterval(() => this.cycle++, (this.config?.cycle_interval ?? 8) * 1000);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.clearInterval(this.ticker);
    window.clearInterval(this.cycler);
  }

  protected updated(changed: PropertyValues): void {
    super.updated(changed);
    if (!this.isCalendar || !this.hass) return;
    // Refetch when the calendar entity changes state (an event started or ended).
    const st = this.stateObj();
    const key = `${this.config.entity}|${st?.last_changed}`;
    if (key !== this.fetchedFor) {
      this.fetchedFor = key;
      fetchCalendarEvents(this.hass as never, this.config.entity, this.config.look_ahead_days ?? 7)
        .then((raw) => (this.events = parseEvents(raw, !!this.config.include_all_day)))
        .catch(() => {
          const ev = st ? eventFromAttributes(st.attributes, !!this.config.include_all_day) : undefined;
          this.events = ev ? [ev] : [];
        });
    }
  }

  private color(fraction: number, raw?: number): string {
    const c = this.config;
    const value = raw ?? fraction * 100;
    let color = c.color ?? BLUE;
    for (const t of [...(c.thresholds ?? [])].sort((a, b) => a.value - b.value)) if (value >= t.value) color = t.color;
    return color;
  }

  private secondary(): string {
    return (this.config.secondary_entities ?? [])
      .map((id) => this.stateObj(id))
      .filter((s): s is HassEntity => !!s && !isUnavailable(s))
      .map((s) => this.hass!.formatEntityState(s))
      .join(' · ');
  }

  private reading(): Reading | undefined {
    const c = this.config;
    const st = this.stateObj();
    if (!st) return undefined;
    const name = c.name ?? st.attributes.friendly_name ?? c.entity;
    const icon = c.icon ?? st.attributes.icon ?? '';

    if (this.isCalendar) {
      const now = this.now;
      const live = eventsInProgress(this.events, now);
      const ev = live.length ? live[this.cycle % live.length] : undefined;
      if (!ev) {
        const next = nextEventAfter(this.events, now);
        const todayEnd = new Date().setHours(24, 0, 0, 0);
        const hidden =
          (c.hide_when === 'no_events' && !next) || (c.hide_when === 'no_events_today' && (!next || next.start >= todayEnd));
        return { fraction: 0, value: next ? duration(next.start - now) : '', name: next?.summary ?? name, sub: next ? `Starts ${time(this.hass, new Date(next.start))}` : 'Nothing on', icon: icon || 'mdi:calendar', hidden };
      }
      const fraction = Math.min(1, (now - ev.start) / (ev.end - ev.start));
      const after = nextEventAfter(this.events, ev.end - 1);
      const sub = after && after.start - ev.end < 3 * 3_600_000 ? `Then ${after.summary} in ${duration(after.start - now)}` : `Ends ${time(this.hass, new Date(ev.end))}`;
      return { fraction, value: duration(ev.end - now), name: ev.summary, sub, icon: icon || 'mdi:calendar' };
    }

    if (this.isTimer) {
      const dur = parseDuration(st.attributes.duration);
      let remaining = parseDuration(st.attributes.remaining);
      if (st.state === 'active' && st.attributes.finishes_at) remaining = (Date.parse(st.attributes.finishes_at) - this.now) / 1000;
      const fraction = st.state === 'idle' || !dur ? 0 : Math.min(1, Math.max(0, 1 - remaining / dur));
      return { fraction, value: st.state === 'idle' ? 'Idle' : duration(remaining * 1000), name, sub: st.state === 'paused' ? 'Paused' : this.secondary(), icon: icon || 'mdi:timer-outline' };
    }

    const raw = numericState(st, c.attribute);
    const min = c.min ?? (st.attributes.min as number | undefined) ?? 0;
    const max = c.max ?? (st.attributes.max as number | undefined) ?? 100;
    let fraction = raw == null ? 0 : (raw - min) / (max - min || 1);
    if (c.pin_entity && (c.pin_states ?? []).includes(this.stateObj(c.pin_entity)?.state ?? '')) {
      const pv = c.pin_value ?? 'max';
      fraction = pv === 'max' ? 1 : pv === 'min' ? 0 : (Number(pv) - min) / (max - min || 1);
    }
    fraction = Math.min(1, Math.max(0, fraction));
    const valueSt = this.stateObj(c.value_entity);
    const value = valueSt
      ? this.hass!.formatEntityState(valueSt)
      : raw == null
        ? '—'
        : max === 100 && min === 0
          ? `${Math.round(raw)}%`
          : c.attribute
            ? this.hass!.formatEntityAttributeValue(st, c.attribute)
            : this.hass!.formatEntityState(st);
    return { fraction, value, name, sub: this.secondary(), icon };
  }

  private iconEl(r: Reading, cls = '') {
    const st = this.stateObj();
    return r.icon
      ? html`<ha-icon class="ic ${cls}" .icon=${r.icon}></ha-icon>`
      : html`<ha-state-icon class="ic ${cls}" .hass=${this.hass} .stateObj=${st}></ha-state-icon>`;
  }

  private fillLayout(r: Reading, color: string) {
    const rgb = parseHex(color);
    const { ink, sub } = rgb ? inkFor(rgb) : { ink: '#fff', sub: 'rgba(255,255,255,.86)' };
    const pct = r.fraction * 100;
    const slim = this.size === 'slim';
    const big = this.size === 'l' || this.size === 'w';
    const content = (over: boolean) =>
      slim
        ? html`<div class="row">${this.iconEl(r)}<div class="mid"><div class="name">${r.name}</div><div class="sub" style=${over ? `color:${sub}` : ''}>${r.sub}</div></div><div class="val">${r.value}</div></div>`
        : html`<div class="in">
            <div class="head">${this.iconEl(r)}${big ? html`<div class="mid"><div class="name">${r.name}</div><div class="sub" style=${over ? `color:${sub}` : ''}>${r.sub}</div></div>` : nothing}</div>
            <div>
              <div class="big ${this.size === 'l' ? 'xl' : ''}">${r.value}</div>
              ${big ? nothing : html`<div class="name sm">${r.name}</div><div class="sub" style=${over ? `color:${sub}` : ''}>${r.sub}</div>`}
            </div>
          </div>`;
    const clip = slim ? `inset(0 ${100 - pct}% 0 0)` : `inset(${100 - pct}% 0 0 0)`;
    const ghost = big && !this.isCalendar ? String(Math.round(pct)) : '';
    return html`
      ${content(false)}
      ${pct > 0 ? html`<div class="ov" aria-hidden="true" style="background:${color};color:${ink};clip-path:${clip}">${content(true)}</div>` : nothing}
      ${ghost ? html`<div class="ghost ${this.size === 'l' ? 'xl' : ''}" aria-hidden="true">${ghost}</div>` : nothing}
    `;
  }

  private ring(r: Reading, color: string, px: number, stroke: number) {
    const R = 50 - stroke / 2 - 1;
    const C = 2 * Math.PI * R;
    return svg`<svg class="ring" viewBox="0 0 100 100" style="width:${px}px;height:${px}px" aria-hidden="true">
      <circle cx="50" cy="50" r=${R} fill="none" stroke="var(--_track)" stroke-width=${stroke}></circle>
      <circle cx="50" cy="50" r=${R} fill="none" stroke=${color} stroke-width=${stroke} stroke-linecap="round" stroke-dasharray="${(r.fraction * C).toFixed(1)} ${C.toFixed(1)}" transform="rotate(-90 50 50)"></circle>
    </svg>`;
  }

  private ringLayout(r: Reading, color: string) {
    const size = this.size;
    if (size === 'slim') {
      return html`<div class="row ringrow"><div class="rw">${this.ring(r, color, 70, 10)}<div class="rc small">${Math.round(r.fraction * 100)}</div></div><div class="mid"><div class="name">${r.name}</div><div class="sub">${r.sub}</div></div><div class="val">${r.value}</div></div>`;
    }
    if (size === 'w') {
      return html`<div class="ringwide"><div class="rw">${this.ring(r, color, 164, 9)}<div class="rc"><span class="rv">${r.value}</span>${this.iconEl(r, 'mute')}</div></div><div class="mid"><div class="name lg">${r.name}</div><div class="sub">${r.sub}</div></div></div>`;
    }
    const px = size === 'l' ? 310 : 118;
    return html`<div class="ringcol ${size}">
      <div class="rw">${this.ring(r, color, px, size === 'l' ? 7 : 9)}<div class="rc">${this.iconEl(r, 'mute')}<span class="rv ${size === 'l' ? 'xl' : ''}">${r.value}</span></div></div>
      <div class="cap2"><div class="name ${size === 'l' ? 'lg' : 'sm'}">${r.name}</div><div class="sub">${r.sub}</div></div>
    </div>`;
  }

  private dotsLayout(r: Reading, color: string) {
    const size = this.size;
    const [cols, count] = size === 'l' ? [20, 240] : size === 'w' ? [24, 144] : size === 'slim' ? [12, 36] : [8, 40];
    const on = Math.round(count * r.fraction);
    const dots = html`<div class="dots" style="grid-template-columns:repeat(${cols},minmax(0,1fr))">${Array.from(
      { length: count },
      (_, i) => html`<span style="background:${i < on ? color : 'var(--_track)'}"></span>`,
    )}</div>`;
    if (size === 'slim') {
      return html`<div class="row">${this.iconEl(r)}<div class="mid fixed"><div class="name">${r.name}</div><div class="sub">${r.sub}</div></div>${dots}</div>`;
    }
    if (size === 's' || size === 't') {
      return html`<div class="in"><div class="head between">${this.iconEl(r)}<span class="val">${r.value}</span></div>${dots}<div><div class="name sm">${r.name}</div><div class="sub">${r.sub}</div></div></div>`;
    }
    return html`<div class="in">
      <div class="head">${this.iconEl(r)}<div class="mid"><div class="name">${r.name}</div><div class="sub">${r.sub}</div></div>${size === 'w' ? html`<span class="val lg">${r.value}</span>` : nothing}</div>
      ${dots}
      ${size === 'l' ? html`<div class="head between"><span class="big">${r.value}</span></div>` : nothing}
    </div>`;
  }

  render() {
    if (!this.hass) return nothing;
    const r = this.reading();
    if (!r) return html`<ha-card class="tile"><div class="warn">Entity not found: ${this.config.entity}</div></ha-card>`;
    this.style.display = r.hidden && !this.preview ? 'none' : '';
    const color = this.color(r.fraction, numericState(this.stateObj(), this.config.attribute));
    const design = this.config.design ?? 'fill';
    return html`<ha-card class="tile ${this.clickable ? 'clickable' : ''} ${this.size === 'slim' ? 'slimcard' : ''}" tabindex="0" role="progressbar" aria-label=${r.name} aria-valuenow=${Math.round(r.fraction * 100)} aria-valuemin="0" aria-valuemax="100" aria-valuetext="${r.value} ${r.sub}">
      ${design === 'ring' ? this.ringLayout(r, color) : design === 'dots' ? this.dotsLayout(r, color) : this.fillLayout(r, color)}
    </ha-card>`;
  }

  getGridOptions(): GridOptions {
    return { columns: 12, rows: 2, min_columns: 6, min_rows: 1 };
  }

  getCardSize(): number {
    return 2;
  }

  static styles = [
    ...HomeViewCard.styles,
    css`
      .slimcard {
        border-radius: 26px;
      }
      .ic {
        --mdc-icon-size: 30px;
        flex: none;
      }
      .ic.mute {
        color: var(--_ink2);
        --mdc-icon-size: 24px;
      }
      .row {
        position: absolute;
        inset: 0;
        padding: 0 22px;
        display: flex;
        align-items: center;
        gap: 14px;
      }
      .ov .row,
      .ov .in {
        position: absolute;
        inset: 0;
      }
      .mid {
        flex: 1;
        min-width: 0;
      }
      .mid.fixed {
        flex: none;
        width: 132px;
      }
      .val {
        font-size: 28px;
        font-weight: 600;
        letter-spacing: -0.02em;
        white-space: nowrap;
      }
      .val.lg {
        font-size: 36px;
      }
      .head {
        display: flex;
        align-items: center;
        gap: 14px;
        min-width: 0;
      }
      .between {
        justify-content: space-between;
      }
      .big {
        font-size: 46px;
        font-weight: 600;
        letter-spacing: -0.035em;
        line-height: 1;
      }
      .big.xl {
        font-size: 96px;
        letter-spacing: -0.05em;
        line-height: 0.9;
      }
      .name.sm {
        font-size: 19px;
        margin-top: 6px;
      }
      .name.lg {
        font-size: 22px;
      }
      .ghost {
        position: absolute;
        right: 18px;
        bottom: -22px;
        font-size: 168px;
        font-weight: 700;
        letter-spacing: -0.06em;
        line-height: 1;
        color: rgba(255, 255, 255, 0.2);
        pointer-events: none;
      }
      .ghost.xl {
        right: 14px;
        bottom: -44px;
        font-size: 280px;
        color: rgba(255, 255, 255, 0.14);
      }
      .rw {
        position: relative;
        flex: none;
        display: grid;
        place-items: center;
      }
      .rc {
        position: absolute;
        inset: 0;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 2px;
      }
      .rc.small {
        font-size: 19px;
        font-weight: 700;
      }
      .rv {
        font-size: 32px;
        font-weight: 600;
        letter-spacing: -0.03em;
        line-height: 1;
      }
      .rv.xl {
        font-size: 100px;
        letter-spacing: -0.045em;
      }
      .ringrow {
        padding-left: 16px;
      }
      .ringwide {
        height: 100%;
        box-sizing: border-box;
        display: flex;
        align-items: center;
        gap: 22px;
        padding: 0 24px 0 20px;
      }
      .ringwide .rv {
        font-size: 46px;
      }
      .ringcol {
        height: 100%;
        box-sizing: border-box;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 10px;
        text-align: center;
        padding: 12px;
      }
      .ringcol.l {
        justify-content: space-between;
        padding: 22px 24px 20px;
      }
      .cap2 {
        min-width: 0;
        max-width: 100%;
      }
      .dots {
        display: grid;
        gap: 5px;
        flex: 1;
        align-content: center;
      }
      .dots span {
        border-radius: 50%;
        aspect-ratio: 1;
      }
      .in > .dots {
        flex: none;
      }
    `,
  ];
}

/** "1:30:00" or a number of seconds, to seconds. */
const parseDuration = (v: unknown): number => {
  if (typeof v === 'number') return v;
  if (typeof v !== 'string') return 0;
  const parts = v.split(':').map(Number);
  return parts.reduce((n, p) => n * 60 + (Number.isFinite(p) ? p : 0), 0);
};

defineElement('homeview-progress-card', HomeViewProgressCard);
registerCard({
  type: 'homeview-progress-card',
  name: 'HomeView Progress',
  description: 'Progress as a fill, ring or dots: appliances, batteries, timers and calendar events.',
  docs: 'progress',
});
