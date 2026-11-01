import { css, html, nothing } from 'lit';
import { state } from 'lit/decorators.js';
import { PopupContent } from './popup-base';
import { fetchCalendarRange, parseEvents, type CalendarEvent } from '../core/calendar';
import { longDate, time, weekday } from '../core/format';
import { agendaCalendars, type AgendaCardConfig } from '../cards/agenda-card';
import { defineElement } from '../core/register';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Height of one hour on the timeline, in px. */
const ROW = 60;

interface Placed {
  ev: CalendarEvent;
  lane: number;
  lanes: number;
}

const startOfDay = (t: number): number => {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/**
 * Side-by-side lanes for overlapping events: each event takes the first lane
 * free at its start, and every event in an overlapping group shares the
 * group's lane count so they split the width evenly.
 */
const layout = (events: CalendarEvent[]): Placed[] => {
  const out: Placed[] = [];
  let group: Placed[] = [];
  let groupEnd = -Infinity;
  const flush = () => {
    const lanes = Math.max(1, ...group.map((p) => p.lane + 1));
    for (const p of group) p.lanes = lanes;
    out.push(...group);
    group = [];
  };
  for (const ev of [...events].sort((a, b) => a.start - b.start || b.end - a.end)) {
    if (ev.start >= groupEnd) {
      flush();
      groupEnd = -Infinity;
    }
    const busy = group.filter((p) => p.ev.end > ev.start).map((p) => p.lane);
    let lane = 0;
    while (busy.includes(lane)) lane++;
    group.push({ ev, lane, lanes: 1 });
    groupEnd = Math.max(groupEnd, ev.end);
  }
  flush();
  return out;
};

/**
 * Calendar pop-up: one day as a timeline (hour lines, events as blocks side
 * by side where they overlap, a now line), all-day events above it, day
 * navigation, and what's coming up over the next week alongside.
 */
export class HomeViewAgendaPopup extends PopupContent {
  @state() private day = startOfDay(Date.now());
  @state() private events: CalendarEvent[] = [];
  @state() private upcoming: CalendarEvent[] = [];
  @state() private now = Date.now();
  private ticker?: number;
  private loadedDay?: number;
  private scrolled = false;

  private get calendars() {
    return agendaCalendars(this.cfg as AgendaCardConfig);
  }

  popupTitle(): string {
    return (this.cfg.name as string | undefined) ?? 'Calendar';
  }

  popupSubtitle(): string {
    return this.hass ? longDate(this.hass, new Date(this.day)) : '';
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.ticker = window.setInterval(() => (this.now = Date.now()), 60_000);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.clearInterval(this.ticker);
  }

  private async fetch(from: number, to: number): Promise<CalendarEvent[]> {
    const allDay = (this.cfg.include_all_day as boolean | undefined) ?? true;
    const lists = await Promise.all(
      this.calendars.map((c) =>
        fetchCalendarRange(this.hass!, c.entity, new Date(from), new Date(to))
          .then((raw) => parseEvents(raw, allDay).map((e) => ({ ...e, calendar: c.entity })))
          .catch(() => [] as CalendarEvent[]),
      ),
    );
    return lists.flat().sort((a, b) => a.start - b.start || a.end - b.end);
  }

  protected updated(): void {
    if (!this.hass || this.loadedDay === this.day) return;
    this.loadedDay = this.day;
    const day = this.day;
    void this.fetch(day, day + DAY).then((evs) => {
      if (this.day === day) this.events = evs.filter((e) => e.end > day && e.start < day + DAY);
    });
    if (!this.upcoming.length) {
      const today = startOfDay(Date.now());
      void this.fetch(today, today + 8 * DAY).then((evs) => (this.upcoming = evs));
    }
    // Open on now (or the morning), not midnight.
    requestAnimationFrame(() => {
      const scroller = this.renderRoot.querySelector('.scroll') as HTMLElement | null;
      if (!scroller || (this.scrolled && day !== startOfDay(Date.now()))) return;
      const isToday = day === startOfDay(Date.now());
      const firstTimed = this.events.find((e) => !e.allDay);
      const focus = isToday ? (Date.now() - day) / HOUR - 1.5 : firstTimed ? (Math.max(day, firstTimed.start) - day) / HOUR - 0.5 : 7.5;
      scroller.scrollTop = Math.max(0, focus * ROW);
      this.scrolled = true;
    });
  }

  private shift(days: number): void {
    this.day = days === 0 ? startOfDay(Date.now()) : startOfDay(this.day + days * DAY + 2 * HOUR);
    this.events = [];
  }

  private color(ev: CalendarEvent): string {
    return this.calendars.find((c) => c.entity === ev.calendar)?.color ?? '#7D6BFF';
  }

  private span(ev: CalendarEvent): string {
    return `${time(this.hass, new Date(ev.start))} – ${time(this.hass, new Date(ev.end))}`;
  }

  private timeline() {
    const day = this.day;
    const timed = this.events.filter((e) => !e.allDay);
    const isToday = day === startOfDay(this.now);
    return html`<div class="scroll">
      <div class="grid" style="height:${24 * ROW}px">
        ${Array.from({ length: 24 }, (_, h) => {
          // The now line carries its own time; drop an hour label it would sit on.
          const clash = isToday && Math.abs(this.now - (day + h * HOUR)) < 20 * 60_000;
          return html`<div class="hour" style="top:${h * ROW}px"><span>${h && !clash ? time(this.hass, new Date(day + h * HOUR)) : ''}</span></div>`;
        })}
        <div class="lanes">
          ${layout(timed).map(({ ev, lane, lanes }) => {
            const top = ((Math.max(ev.start, day) - day) / HOUR) * ROW;
            const height = Math.max(26, ((Math.min(ev.end, day + DAY) - Math.max(ev.start, day)) / HOUR) * ROW - 3);
            const c = this.color(ev);
            const past = ev.end <= this.now;
            return html`<div
              class="ev ${height < 46 ? 'short' : ''} ${past ? 'past' : ''}"
              style="top:${top}px;height:${height}px;left:calc(${(lane / lanes) * 100}% + 2px);width:calc(${100 / lanes}% - 4px);--c:${c}"
            >
              <b>${ev.summary}</b>
              <span>${this.span(ev)}${ev.location ? ` · ${ev.location}` : ''}</span>
            </div>`;
          })}
          ${isToday
            ? html`<div class="nowline" style="top:${((this.now - day) / HOUR) * ROW}px"><em>${time(this.hass, new Date(this.now))}</em><i></i></div>`
            : nothing}
        </div>
      </div>
    </div>`;
  }

  private comingUp() {
    const from = this.now;
    const list = this.upcoming.filter((e) => e.end > from).slice(0, 12);
    if (!list.length) return html`<div class="sub">Nothing in the next week</div>`;
    let last = '';
    return list.map((e) => {
      const dayKey = new Date(e.allDay ? e.start : Math.max(e.start, from)).toDateString();
      const head = dayKey !== last;
      last = dayKey;
      const d = new Date(e.start);
      const label = startOfDay(e.start) <= startOfDay(from) ? 'Today' : startOfDay(e.start) === startOfDay(from) + DAY ? 'Tomorrow' : `${weekday(this.hass, d, 'long')} ${d.getDate()}`;
      return html`${head ? html`<div class="dayhead">${label}</div>` : nothing}
        <button class="up" @click=${() => (this.day = startOfDay(e.start))}>
          <span class="dot" style="background:${this.color(e)}"></span>
          <span class="ut"><b>${e.summary}</b><span>${e.allDay ? 'All day' : this.span(e)}</span></span>
        </button>`;
    });
  }

  render() {
    if (!this.hass) return nothing;
    const allDay = this.events.filter((e) => e.allDay);
    const isToday = this.day === startOfDay(this.now);
    return html`
      <div class="layout">
        <div class="panel daypanel">
          <div class="bar">
            <div class="nav">
              <button class="round gl" aria-label="Previous day" @click=${() => this.shift(-1)}><ha-icon icon="mdi:chevron-left"></ha-icon></button>
              <button class="today gl" ?disabled=${isToday} @click=${() => this.shift(0)}>Today</button>
              <button class="round gl" aria-label="Next day" @click=${() => this.shift(1)}><ha-icon icon="mdi:chevron-right"></ha-icon></button>
            </div>
            <div class="legend">
              ${this.calendars.map(
                (c) => html`<span><i style="background:${c.color}"></i>${this.hass!.states[c.entity]?.attributes.friendly_name ?? c.entity}</span>`,
              )}
            </div>
          </div>
          ${allDay.length
            ? html`<div class="allday">${allDay.map((e) => html`<span class="pill" style="--c:${this.color(e)}">${e.summary}</span>`)}</div>`
            : nothing}
          ${this.timeline()}
        </div>
        <div class="panel side">
          <h3 class="sec">Coming up</h3>
          <div class="ups">${this.comingUp()}</div>
        </div>
      </div>
    `;
  }

  static styles = [
    ...PopupContent.styles,
    css`
      .layout {
        display: grid;
        grid-template-columns: minmax(0, 2fr) minmax(260px, 1fr);
        gap: 18px;
      }
      .daypanel {
        display: flex;
        flex-direction: column;
        gap: 14px;
        min-width: 0;
      }
      .bar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        flex-wrap: wrap;
      }
      .nav {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .nav .round {
        width: 44px;
        height: 44px;
      }
      .today {
        height: 44px;
        padding: 0 18px;
        border: 0;
        border-radius: 999px;
        font: inherit;
        font-size: 17px;
        font-weight: 600;
        color: var(--_ink);
        cursor: pointer;
      }
      .today[disabled] {
        opacity: 0.45;
        cursor: default;
      }
      .legend {
        display: flex;
        flex-wrap: wrap;
        gap: 6px 14px;
        font-size: 15px;
        font-weight: 600;
        color: var(--_ink2);
      }
      .legend span {
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }
      .legend i {
        width: 10px;
        height: 10px;
        border-radius: 50%;
      }
      .allday {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }
      .pill {
        padding: 6px 12px;
        border-radius: 10px;
        font-size: 15px;
        font-weight: 600;
        background: color-mix(in srgb, var(--c) 30%, transparent);
        box-shadow: inset 3px 0 0 var(--c);
      }
      .scroll {
        position: relative;
        height: min(56vh, 600px);
        overflow-y: auto;
        border-radius: 16px;
        -webkit-overflow-scrolling: touch;
      }
      .grid {
        position: relative;
      }
      .hour {
        position: absolute;
        left: 0;
        right: 0;
        height: 0;
        border-top: 1px solid var(--_track);
      }
      .hour span {
        position: absolute;
        left: 0;
        top: -10px;
        width: 54px;
        font-size: 13px;
        font-weight: 600;
        color: var(--_ink3);
        background: none;
      }
      .lanes {
        position: absolute;
        top: 0;
        bottom: 0;
        left: 62px;
        right: 0;
      }
      .ev {
        position: absolute;
        box-sizing: border-box;
        overflow: hidden;
        padding: 6px 10px;
        border-radius: 10px;
        background: color-mix(in srgb, var(--c) 32%, rgba(20, 18, 32, 0.4));
        box-shadow: inset 4px 0 0 var(--c);
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .ev b {
        font-size: 16px;
        font-weight: 600;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .ev span {
        font-size: 13px;
        font-weight: 600;
        color: var(--_ink2);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .ev.short {
        flex-direction: row;
        align-items: center;
        gap: 8px;
        padding: 2px 10px;
      }
      .ev.past {
        opacity: 0.55;
      }
      .nowline {
        position: absolute;
        left: -62px;
        right: 0;
        height: 0;
        z-index: 2;
        pointer-events: none;
      }
      .nowline i {
        position: absolute;
        left: 58px;
        right: 0;
        top: -1px;
        height: 2px;
        background: var(--hv-c-alert);
      }
      .nowline i::before {
        content: '';
        position: absolute;
        left: -4px;
        top: -4px;
        width: 10px;
        height: 10px;
        border-radius: 50%;
        background: var(--hv-c-alert);
      }
      .nowline em {
        position: absolute;
        left: 0;
        top: -10px;
        font-style: normal;
        font-size: 13px;
        font-weight: 700;
        color: var(--hv-c-alert);
      }
      .side {
        min-width: 0;
      }
      .ups {
        display: flex;
        flex-direction: column;
        gap: 4px;
        max-height: min(64vh, 680px);
        overflow-y: auto;
      }
      .dayhead {
        margin: 10px 0 4px;
        font-size: 15px;
        font-weight: 700;
        color: var(--_ink2);
      }
      .dayhead:first-child {
        margin-top: 0;
      }
      .up {
        display: flex;
        align-items: flex-start;
        gap: 10px;
        padding: 8px 10px;
        border: 0;
        border-radius: 12px;
        background: none;
        color: inherit;
        font: inherit;
        text-align: left;
        cursor: pointer;
      }
      .up:hover {
        background: var(--_glass-hi);
      }
      .dot {
        flex: none;
        width: 10px;
        height: 10px;
        margin-top: 6px;
        border-radius: 50%;
      }
      .ut {
        display: flex;
        flex-direction: column;
        min-width: 0;
      }
      .ut b {
        font-size: 17px;
        font-weight: 600;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .ut span {
        font-size: 14px;
        font-weight: 600;
        color: var(--_ink2);
      }
      @media (max-width: 760px) {
        .layout {
          grid-template-columns: minmax(0, 1fr);
        }
        .scroll {
          height: 52vh;
        }
      }
    `,
  ];
}

defineElement('homeview-agenda-popup', HomeViewAgendaPopup);
