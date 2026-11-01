/**
 * Progress readings shared by the progress card and the progress chip, after
 * ha-progress-card: a number between min and max, a running timer, or the
 * calendar event in progress; pinned to a value while another entity is in
 * given states; with the value shown taken from another entity if set.
 */
import type { HomeAssistant, HassEntity } from './types';
import { countdown, duration, numericState, time } from './format';
import { eventsInProgress, nextEventAfter, type CalendarEvent } from './calendar';
import { themeColor } from './color';

export interface Threshold {
  value: number;
  color: string;
}

export interface ProgressSource {
  entity: string;
  attribute?: string;
  name?: string;
  icon?: string;
  min?: number;
  max?: number;
  color?: string;
  /** ha-progress-card's name for `color`. */
  bar_color?: string;
  /** The colour of the highest stop the value has reached wins. */
  thresholds?: Threshold[];
  /** Replaces the value with another entity's formatted state. */
  value_entity?: string;
  /** While pin_entity is in one of pin_states, progress is forced to pin_value. */
  pin_entity?: string;
  pin_states?: string[];
  pin_value?: 'max' | 'min' | number;
  /**
   * Calendars: when to hide. `no_events_within` hides unless an event is on
   * or starts within `within`; `no_events_today` unless one is on or starts
   * before midnight; `no_events` unless one is coming up in look_ahead_days.
   */
  hide_when?: 'never' | 'no_events_today' | 'no_events_within' | 'no_events';
  /** For no_events_within: how far ahead counts, as Home Assistant's duration ({ days, hours, minutes }). */
  within?: { days?: number; hours?: number; minutes?: number; seconds?: number };
  look_ahead_days?: number;
}

/** A Home Assistant duration in milliseconds. */
export const durationMs = (d: ProgressSource['within']): number =>
  (((d?.days ?? 0) * 24 + (d?.hours ?? 0)) * 60 + (d?.minutes ?? 0)) * 60_000 + (d?.seconds ?? 0) * 1000;

/** Days of events to fetch: the look-ahead, stretched to cover the hide window. */
export const calendarDays = (c: ProgressSource): number =>
  Math.max(c.look_ahead_days ?? 7, c.hide_when === 'no_events_within' ? Math.ceil(durationMs(c.within) / 86_400_000) + 1 : 1);

export interface ProgressReading {
  /** 0 to 1. */
  fraction: number;
  value: string;
  name: string;
  sub: string;
  icon: string;
  hidden?: boolean;
  /** Pinned at the maximum, or reached it. */
  done: boolean;
  /** The raw number the thresholds compare against. */
  raw?: number;
  /** Calendars: counting down to the next event, or to the end of the current one. */
  phase?: 'before' | 'during';
}

export interface ProgressContext {
  now: number;
  /** Parsed events, for a calendar entity. */
  events: CalendarEvent[];
  /** Which in-progress event to show when several overlap. */
  cycle: number;
  /** Text under the name for numbers and timers. */
  sub?: string;
}

export const isCalendar = (entity: string): boolean => entity.startsWith('calendar.');
export const isTimer = (entity: string): boolean => entity.startsWith('timer.');

/** Seconds from a number or "H:MM:SS". */
export const parseDuration = (v: unknown): number => {
  if (typeof v === 'number') return v;
  if (typeof v !== 'string') return 0;
  const parts = v.split(':').map(Number);
  return parts.reduce((n, p) => n * 60 + (Number.isFinite(p) ? p : 0), 0);
};

export const progressReading = (hass: HomeAssistant, c: ProgressSource, ctx: ProgressContext): ProgressReading | undefined => {
  const st: HassEntity | undefined = hass.states[c.entity];
  if (!st) return undefined;
  const name = c.name ?? st.attributes.friendly_name ?? c.entity;
  const icon = c.icon ?? st.attributes.icon ?? '';
  const now = ctx.now;

  if (isCalendar(c.entity)) {
    const live = eventsInProgress(ctx.events, now);
    const ev = live.length ? live[ctx.cycle % live.length] : undefined;
    if (!ev) {
      const next = nextEventAfter(ctx.events, now);
      const todayEnd = new Date().setHours(24, 0, 0, 0);
      const hidden =
        (c.hide_when === 'no_events' && !next) ||
        (c.hide_when === 'no_events_today' && (!next || next.start >= todayEnd)) ||
        (c.hide_when === 'no_events_within' && (!next || next.start - now > durationMs(c.within)));
      return {
        fraction: 0,
        value: next ? countdown(next.start - now) : '',
        phase: next ? 'before' : undefined,
        name: next?.summary ?? name,
        sub: next ? `Starts ${time(hass, new Date(next.start))}` : 'Nothing on',
        icon: icon || 'mdi:calendar',
        hidden,
        done: false,
      };
    }
    const fraction = Math.min(1, (now - ev.start) / (ev.end - ev.start));
    const after = nextEventAfter(ctx.events, ev.end - 1);
    const sub =
      after && after.start - ev.end < 3 * 3_600_000 ? `Then ${after.summary} in ${duration(after.start - now)}` : `Ends ${time(hass, new Date(ev.end))}`;
    return { fraction, value: countdown(ev.end - now), name: ev.summary, sub, icon: icon || 'mdi:calendar', done: false, phase: 'during' };
  }

  if (isTimer(c.entity)) {
    const dur = parseDuration(st.attributes.duration);
    let remaining = parseDuration(st.attributes.remaining);
    if (st.state === 'active' && st.attributes.finishes_at) remaining = (Date.parse(st.attributes.finishes_at) - now) / 1000;
    const fraction = st.state === 'idle' || !dur ? 0 : Math.min(1, Math.max(0, 1 - remaining / dur));
    return {
      fraction,
      value: st.state === 'idle' ? 'Idle' : duration(remaining * 1000),
      name,
      sub: st.state === 'paused' ? 'Paused' : ctx.sub ?? '',
      icon: icon || 'mdi:timer-outline',
      done: false,
    };
  }

  const raw = numericState(st, c.attribute);
  const min = c.min ?? (st.attributes.min as number | undefined) ?? 0;
  const max = c.max ?? (st.attributes.max as number | undefined) ?? 100;
  let fraction = raw == null ? 0 : (raw - min) / (max - min || 1);
  const pinned = !!c.pin_entity && (c.pin_states ?? []).includes(hass.states[c.pin_entity]?.state ?? '');
  if (pinned) {
    const pv = c.pin_value ?? 'max';
    fraction = pv === 'max' ? 1 : pv === 'min' ? 0 : (Number(pv) - min) / (max - min || 1);
  }
  fraction = Math.min(1, Math.max(0, fraction));
  const valueSt = c.value_entity ? hass.states[c.value_entity] : undefined;
  const value = valueSt
    ? hass.formatEntityState(valueSt)
    : raw == null
      ? '—'
      : max === 100 && min === 0
        ? `${Math.round(raw)}%`
        : c.attribute
          ? hass.formatEntityAttributeValue(st, c.attribute)
          : hass.formatEntityState(st);
  return { fraction, value, name, sub: ctx.sub ?? '', icon, done: fraction >= 1, raw: pinned ? min + fraction * (max - min) : raw ?? undefined };
};

/**
 * The colour for a reading: the highest threshold reached, else color /
 * bar_color, else blue. Theme names (blue, light-green…) resolve through
 * `resolve`: CSS variables by default, or plain hex where maths needs it.
 */
export const progressColor = (
  c: ProgressSource,
  r: Pick<ProgressReading, 'fraction' | 'raw'>,
  resolve: (name: string) => string = themeColor,
): string => {
  const value = r.raw ?? r.fraction * 100;
  let color = c.color ?? c.bar_color ?? '#4C8DFF';
  for (const t of [...(c.thresholds ?? [])].sort((a, b) => a.value - b.value)) if (value >= t.value) color = t.color;
  return resolve(color);
};
