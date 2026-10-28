import type { HassEntity, HomeAssistant } from './types';

const lang = (hass?: HomeAssistant): string => hass?.locale?.language ?? hass?.language ?? navigator.language;

export const num = (hass: HomeAssistant | undefined, value: number, digits = 1): string =>
  new Intl.NumberFormat(lang(hass), { maximumFractionDigits: digits, minimumFractionDigits: 0 }).format(value);

export const fixed = (hass: HomeAssistant | undefined, value: number, digits = 1): string =>
  new Intl.NumberFormat(lang(hass), { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(value);

/** True when times should show as 24-hour, following the user's HA profile. */
export const use24h = (hass?: HomeAssistant): boolean => {
  const tf = hass?.locale?.time_format;
  if (tf === '24') return true;
  if (tf === '12') return false;
  const probe = new Intl.DateTimeFormat(tf === 'system' ? undefined : lang(hass), { hour: 'numeric' }).resolvedOptions();
  return probe.hourCycle === 'h23' || probe.hourCycle === 'h24';
};

export const time = (hass: HomeAssistant | undefined, date: Date, withSeconds = false): string =>
  new Intl.DateTimeFormat(lang(hass), {
    hour: '2-digit',
    minute: '2-digit',
    second: withSeconds ? '2-digit' : undefined,
    hour12: !use24h(hass),
    timeZone: hass?.config?.time_zone,
  }).format(date);

/** Clock face digits without an AM/PM suffix. */
export const clockDigits = (hass: HomeAssistant | undefined, date: Date): string =>
  new Intl.DateTimeFormat(lang(hass), {
    hour: use24h(hass) ? '2-digit' : 'numeric',
    minute: '2-digit',
    hour12: !use24h(hass),
    timeZone: hass?.config?.time_zone,
  })
    .formatToParts(date)
    .filter((p) => p.type !== 'dayPeriod')
    .map((p) => p.value)
    .join('')
    .trim();

export const longDate = (hass: HomeAssistant | undefined, date: Date): string =>
  new Intl.DateTimeFormat(lang(hass), {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: hass?.config?.time_zone,
  }).format(date);

export const weekday = (hass: HomeAssistant | undefined, date: Date, style: 'short' | 'narrow' | 'long' = 'short'): string =>
  new Intl.DateTimeFormat(lang(hass), { weekday: style, timeZone: hass?.config?.time_zone }).format(date);

export const tempUnit = (hass?: HomeAssistant): string => hass?.config?.unit_system?.temperature ?? '°C';

export const numericState = (st: HassEntity | undefined, attribute?: string): number | undefined => {
  if (!st) return undefined;
  const raw = attribute ? st.attributes[attribute] : st.state;
  const n = typeof raw === 'number' ? raw : parseFloat(String(raw));
  return Number.isFinite(n) ? n : undefined;
};

export const isUnavailable = (st?: HassEntity): boolean => !st || st.state === 'unavailable' || st.state === 'unknown';

/** "1h 12m", "25m", "40s". */
export const duration = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h) return m ? `${h}h ${m}m` : `${h}h`;
  if (m) return `${m}m`;
  return `${s}s`;
};

export const entityName = (st: HassEntity | undefined, override?: string): string => {
  if (override) return override;
  if (!st) return '';
  return st.attributes.friendly_name ?? st.entity_id;
};

export const greeting = (date: Date): string => {
  const h = date.getHours();
  if (h < 5) return 'Good night';
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
};
