import { css, html, nothing, type PropertyValues } from 'lit';
import { state } from 'lit/decorators.js';
import { HomeViewCard, type BaseCardConfig } from '../core/base-card';
import type { GridOptions } from '../core/types';
import { fetchCalendarEvents, parseEvents, type CalendarEvent } from '../core/calendar';
import { time, weekday } from '../core/format';
import { defineElement, registerCard } from '../core/register';

export interface AgendaCalendar {
  entity: string;
  color?: string;
}

export interface AgendaCardConfig extends BaseCardConfig {
  calendars: Array<string | AgendaCalendar>;
  /** B: today as a list with a now line. C: today's date with what's left. */
  style?: 'today' | 'date';
  include_all_day?: boolean;
  /** Show the first events of tomorrow under today. */
  show_tomorrow?: boolean;
  max_events?: number;
}

const PALETTE = ['#FF8A3D', '#7D6BFF', '#4CD07D', '#FFB340', '#4C8DFF', '#BF5AF2', '#40C8C0', '#FF6FB1'];

/** Agenda (styles B and C): calendars merged, each in its own colour. */
export class HomeViewAgendaCard extends HomeViewCard<AgendaCardConfig> {
  @state() private events: CalendarEvent[] = [];
  @state() private now = Date.now();
  private ticker?: number;
  private loadedKey?: string;

  static getConfigForm() {
    return {
      schema: [
        { name: 'calendars', required: true, selector: { entity: { domain: 'calendar', multiple: true } } },
        { name: 'name', selector: { text: {} } },
        { name: 'style', default: 'today', selector: { select: { options: [{ value: 'today', label: 'B: today with a now line' }, { value: 'date', label: "C: today's date and what's left" }] } } },
        {
          type: 'grid',
          name: '',
          schema: [
            { name: 'include_all_day', default: true, selector: { boolean: {} } },
            { name: 'show_tomorrow', default: true, selector: { boolean: {} } },
          ],
        },
        { name: 'max_events', default: 6, selector: { number: { min: 1, max: 12 } } },
        { name: 'tap_action', selector: { ui_action: {} } },
      ],
      computeHelper: (s: { name: string }) =>
        s.name === 'calendars' ? 'Colours follow the order. In YAML, use {entity, color} to choose one.' : undefined,
    };
  }

  static getStubConfig(_hass: unknown, entities: string[], fallback: string[]) {
    return { calendars: [...entities, ...fallback].filter((e) => e.startsWith('calendar.')).slice(0, 3) };
  }

  protected validate(config: AgendaCardConfig): void {
    if (!config.calendars?.length) throw new Error('Add at least one calendar');
  }

  protected defaults(): Partial<AgendaCardConfig> {
    return { style: 'today', include_all_day: true, show_tomorrow: true, max_events: 6 };
  }

  private get calendars(): Required<AgendaCalendar>[] {
    return this.config.calendars.map((c, i) =>
      typeof c === 'string' ? { entity: c, color: PALETTE[i % PALETTE.length] } : { entity: c.entity, color: c.color ?? PALETTE[i % PALETTE.length] },
    );
  }

  protected watched() {
    return this.calendars.map((c) => c.entity);
  }

  protected defaultAction(kind: 'tap' | 'hold' | 'double_tap') {
    if (kind === 'tap') return { action: 'navigate' as const, navigation_path: '/calendar' };
    return super.defaultAction(kind);
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.ticker = window.setInterval(() => (this.now = Date.now()), 60_000);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.clearInterval(this.ticker);
  }

  protected updated(changed: PropertyValues): void {
    super.updated(changed);
    if (!this.hass) return;
    // Reload when any calendar's state flips (an event starts or ends) or the day changes.
    const key = [new Date().toDateString(), ...this.calendars.map((c) => `${c.entity}:${this.hass!.states[c.entity]?.last_changed}`)].join('|');
    if (key === this.loadedKey) return;
    this.loadedKey = key;
    void Promise.all(
      this.calendars.map((c) =>
        fetchCalendarEvents(this.hass!, c.entity, 2)
          .then((raw) => parseEvents(raw, !!this.config.include_all_day).map((e) => ({ ...e, calendar: c.entity })))
          .catch(() => [] as CalendarEvent[]),
      ),
    ).then((lists) => (this.events = lists.flat().sort((a, b) => a.start - b.start || a.end - b.end)));
  }

  private color(ev: CalendarEvent): string {
    return this.calendars.find((c) => c.entity === ev.calendar)?.color ?? PALETTE[0];
  }

  private split() {
    const dayStart = new Date(this.now);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = dayStart.getTime() + 86_400_000;
    const today = this.events.filter((e) => e.start < dayEnd && e.end > dayStart.getTime());
    const tomorrow = this.events.filter((e) => e.start >= dayEnd && e.start < dayEnd + 86_400_000);
    return { today, tomorrow };
  }

  private when(e: CalendarEvent): string {
    return e.allDay ? 'All day' : time(this.hass, new Date(e.start));
  }

  render() {
    if (!this.hass) return nothing;
    const { today, tomorrow } = this.split();
    const now = this.now;
    const left = today.filter((e) => e.end > now);
    const date = new Date(now);
    const lang = this.hass.locale.language;

    if (this.config.style === 'date') {
      const shown = left.slice(0, this.size === 'l' ? 6 : 2);
      return html`<ha-card class="tile clickable" tabindex="0" role="button" aria-label="Today, ${shown.length} events left">
        <div class="date">
          <div class="dcol">
            <div class="dow">${weekday(this.hass, date)}</div>
            <div class="dnum">${date.getDate()}</div>
            <div class="sub mon">${new Intl.DateTimeFormat(lang, { month: 'long' }).format(date)}</div>
          </div>
          <div class="evs">
            ${shown.length
              ? shown.map(
                  (e) => html`<div class="ev2"><span class="dot" style="background:${this.color(e)}"></span><div class="et"><div class="t">${e.summary}</div><div class="sub p">${e.allDay ? 'All day' : `${time(this.hass, new Date(e.start))} – ${time(this.hass, new Date(e.end))}`}</div></div></div>`,
                )
              : html`<div class="sub">Nothing else today${tomorrow[0] ? ` · tomorrow ${this.when(tomorrow[0])} ${tomorrow[0].summary}` : ''}</div>`}
          </div>
        </div>
      </ha-card>`;
    }

    const max = this.config.max_events ?? 6;
    const past = today.filter((e) => e.end <= now);
    const keepPast = Math.max(0, max - left.length);
    const rows = [...past.slice(-keepPast || past.length), ...left].slice(0, max);
    // The now line sits before the first event that hasn't started yet.
    const firstAhead = rows.findIndex((e) => !e.allDay && e.start > now);
    const nowIndex = firstAhead >= 0 ? firstAhead : rows.length;
    return html`<ha-card class="tile clickable" tabindex="0" role="button" aria-label="Today, ${left.length} events left">
      <div class="in list">
        <div class="lhead"><span class="name">${this.config.name ?? 'Today'}</span><span class="sub small">${weekday(this.hass, date)} ${date.getDate()} · ${left.length} left</span></div>
        <div class="rows">
          ${rows.length
            ? rows.map(
                (e, i) => html`
                  ${i === nowIndex ? this.nowLine() : nothing}
                  <div class="ev ${e.end <= now ? 'past' : ''}">
                    <b>${this.when(e)}</b><span class="dot" style="background:${this.color(e)}"></span>
                    <div class="et"><div class="t">${e.summary}</div>${e.location && e.end > now ? html`<div class="p">${e.location}</div>` : nothing}</div>
                  </div>`,
              )
            : html`<div class="sub">Nothing today</div>`}
          ${rows.length && nowIndex === rows.length ? this.nowLine() : nothing}
        </div>
        ${this.config.show_tomorrow && tomorrow.length
          ? html`<div class="tom"><span>Tomorrow</span><span>${tomorrow.slice(0, 2).map((e) => `${e.summary} ${e.allDay ? '' : time(this.hass, new Date(e.start))}`.trim()).join(' · ')}</span></div>`
          : nothing}
      </div>
    </ha-card>`;
  }

  private nowLine() {
    return html`<div class="now"><span>${time(this.hass, new Date(this.now))}</span><i></i><em></em></div>`;
  }

  getGridOptions(): GridOptions {
    return this.config?.style === 'date' ? { columns: 12, rows: 3, min_columns: 6, min_rows: 3 } : { columns: 12, rows: 6, min_columns: 6, min_rows: 4 };
  }

  getCardSize(): number {
    return this.config?.style === 'date' ? 3 : 7;
  }

  static styles = [
    ...HomeViewCard.styles,
    css`
      .list {
        justify-content: flex-start;
        gap: 12px;
        padding: 20px 22px;
      }
      .lhead {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        gap: 10px;
      }
      .small {
        font-size: 16px;
      }
      .rows {
        display: flex;
        flex-direction: column;
        gap: 12px;
        min-height: 0;
        overflow: hidden;
      }
      .ev {
        display: grid;
        grid-template-columns: 62px 12px minmax(0, 1fr);
        column-gap: 12px;
        align-items: center;
      }
      .ev b {
        font-size: 18px;
        font-weight: 600;
        white-space: nowrap;
      }
      .past {
        opacity: 0.45;
      }
      .dot {
        width: 12px;
        height: 12px;
        border-radius: 50%;
        flex: none;
      }
      .et {
        min-width: 0;
      }
      .t {
        font-size: 19px;
        font-weight: 600;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .p {
        font-size: 15px;
        font-weight: 500;
        color: var(--_ink2);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .now {
        display: flex;
        align-items: center;
        gap: 8px;
        color: var(--hv-now, #ff6b6f);
        font-size: 15px;
        font-weight: 700;
      }
      .now span {
        width: 62px;
      }
      .now i {
        width: 12px;
        height: 12px;
        border-radius: 50%;
        background: currentColor;
      }
      .now em {
        flex: 1;
        height: 2px;
        background: currentColor;
      }
      .tom {
        margin-top: auto;
        padding-top: 10px;
        border-top: 1px solid var(--_track);
        display: flex;
        justify-content: space-between;
        gap: 12px;
        font-size: 16px;
        font-weight: 600;
        color: var(--_ink2);
      }
      .tom span:last-child {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .date {
        height: 100%;
        box-sizing: border-box;
        padding: 20px 22px;
        display: flex;
        align-items: center;
        gap: 22px;
      }
      .dcol {
        text-align: center;
        flex: none;
        width: 92px;
      }
      .dow {
        font-size: 17px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--hv-now, #ff6b6f);
      }
      .dnum {
        font-size: 72px;
        font-weight: 600;
        letter-spacing: -0.04em;
        line-height: 0.95;
      }
      .mon {
        font-size: 16px;
      }
      .evs {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      .ev2 {
        display: flex;
        align-items: center;
        gap: 10px;
      }
    `,
  ];
}

defineElement('homeview-agenda-card', HomeViewAgendaCard);
registerCard({
  type: 'homeview-agenda-card',
  name: 'HomeView Agenda',
  description: "Today's calendar events, merged and colour-coded.",
  docs: 'agenda',
});
