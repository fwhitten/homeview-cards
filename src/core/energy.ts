/**
 * Energy dashboard plumbing, adapted from energy-breakdown-card: read the
 * Energy dashboard preferences, work out total power and consumption from
 * them, and turn statistics into buckets.
 */
import type { HomeAssistant } from './types';
import { fetchStatistics, type StatisticValue } from './history';

export type TotalMode = 'grid' | 'home';

export interface EnergyPrefs {
  energy_sources: EnergySource[];
  device_consumption: DeviceConsumption[];
}

export interface DeviceConsumption {
  stat_consumption: string;
  /** Power entity for the device, in watts. */
  stat_rate?: string;
  name?: string;
  included_in_stat?: string | null;
}

interface PowerConfig {
  stat_rate?: string;
  stat_rate_inverted?: string;
  stat_rate_from?: string;
  stat_rate_to?: string;
}

export interface EnergySource {
  type: 'grid' | 'solar' | 'battery' | 'gas' | 'water';
  flow_from?: Array<{ stat_energy_from: string }>;
  flow_to?: Array<{ stat_energy_to: string }>;
  stat_energy_from?: string | null;
  stat_energy_to?: string | null;
  stat_rate?: string;
  power_config?: PowerConfig;
}

export interface Threshold {
  value: number;
  color: string;
}

export const DEFAULT_THRESHOLDS: Threshold[] = [
  { value: 0, color: '#4CD07D' },
  { value: 1500, color: '#FFB340' },
  { value: 4000, color: '#FF5A5F' },
];

/** HomeView's category-led palette for devices, in order. */
export const DEVICE_COLORS = ['#FF8A3D', '#4C8DFF', '#5AC8FA', '#BF5AF2', '#4CD07D', '#FFC94D', '#40C8C0', '#FF6FB1', '#7D6BFF', '#E2B33A'];
export const OTHER_COLOR = 'rgba(160,160,170,.55)';

let prefsCache: { at: number; value: Promise<EnergyPrefs> } | undefined;

export const fetchPrefs = (hass: HomeAssistant): Promise<EnergyPrefs> => {
  if (prefsCache && Date.now() - prefsCache.at < 10 * 60_000) return prefsCache.value;
  const value = hass.callWS<EnergyPrefs>({ type: 'energy/get_prefs' }).catch((err) => {
    prefsCache = undefined;
    throw err;
  });
  prefsCache = { at: Date.now(), value };
  return value;
};

export const topLevelDevices = (prefs: EnergyPrefs): DeviceConsumption[] =>
  (prefs.device_consumption ?? []).filter((d) => !d.included_in_stat);

interface Signal {
  entity: string;
  sign: 1 | -1;
}

const fromPowerConfig = (source: EnergySource): Signal[] => {
  const c = source.power_config;
  if (c?.stat_rate_from || c?.stat_rate_to) {
    return [
      ...(c.stat_rate_from ? [{ entity: c.stat_rate_from, sign: 1 as const }] : []),
      ...(c.stat_rate_to ? [{ entity: c.stat_rate_to, sign: -1 as const }] : []),
    ];
  }
  if (c?.stat_rate_inverted) return [{ entity: c.stat_rate_inverted, sign: -1 }];
  const signed = c?.stat_rate ?? source.stat_rate;
  return signed ? [{ entity: signed, sign: 1 }] : [];
};

/** Power signals that add up to the home's (or the grid's) consumption. */
export const powerSignals = (prefs: EnergyPrefs, mode: TotalMode): Signal[] => {
  const out: Signal[] = [];
  for (const s of prefs.energy_sources ?? []) {
    if (s.type === 'grid') out.push(...fromPowerConfig(s));
    else if (mode === 'home' && s.type === 'solar' && s.stat_rate) out.push({ entity: s.stat_rate, sign: 1 });
    else if (mode === 'home' && s.type === 'battery') out.push(...fromPowerConfig(s));
  }
  return out;
};

const UNIT: Record<string, number> = { mW: 0.001, W: 1, kW: 1000, MW: 1_000_000 };

export const readWatts = (hass: HomeAssistant, entity: string | undefined): number | null => {
  const st = entity ? hass.states[entity] : undefined;
  if (!st || st.state === 'unavailable' || st.state === 'unknown') return null;
  const v = parseFloat(st.state);
  return Number.isFinite(v) ? v * (UNIT[st.attributes.unit_of_measurement ?? 'W'] ?? 1) : null;
};

export const readTotal = (hass: HomeAssistant, signals: Signal[]): number | null => {
  let total = 0;
  let seen = false;
  for (const s of signals) {
    const v = readWatts(hass, s.entity);
    if (v === null) continue;
    seen = true;
    total += s.sign * v;
  }
  return seen ? total : null;
};

/** Energy statistics that add up to consumption, with the sign each one carries. */
export const consumptionStats = (prefs: EnergyPrefs, mode: TotalMode): Array<{ id: string; sign: 1 | -1 }> => {
  const out: Array<{ id: string; sign: 1 | -1 }> = [];
  for (const s of prefs.energy_sources ?? []) {
    if (s.type === 'grid') {
      const from = s.flow_from?.map((f) => f.stat_energy_from) ?? (s.stat_energy_from ? [s.stat_energy_from] : []);
      const to = s.flow_to?.map((f) => f.stat_energy_to) ?? (s.stat_energy_to ? [s.stat_energy_to] : []);
      from.filter(Boolean).forEach((id) => out.push({ id, sign: 1 }));
      if (mode === 'home') to.filter(Boolean).forEach((id) => out.push({ id, sign: -1 }));
    } else if (mode === 'home' && s.type === 'solar' && s.stat_energy_from) {
      out.push({ id: s.stat_energy_from, sign: 1 });
    } else if (mode === 'home' && s.type === 'battery') {
      if (s.stat_energy_from) out.push({ id: s.stat_energy_from, sign: 1 });
      if (s.stat_energy_to) out.push({ id: s.stat_energy_to, sign: -1 });
    }
  }
  return out;
};

const change = (v: StatisticValue): number => (typeof v.change === 'number' && Number.isFinite(v.change) ? v.change : 0);

/** kWh consumed between two moments, from hourly statistics. */
export const energyBetween = async (
  hass: HomeAssistant,
  stats: Array<{ id: string; sign: 1 | -1 }>,
  start: Date,
  end: Date,
): Promise<number> => {
  if (!stats.length) return 0;
  const res = await fetchStatistics(hass, stats.map((s) => s.id), start, end, 'hour', ['change']);
  return stats.reduce((sum, s) => sum + s.sign * (res[s.id] ?? []).reduce((n, v) => n + change(v), 0), 0);
};

/** Sum each statistic's change into buckets [start, end). */
export const bucketize = (
  rows: StatisticValue[] | undefined,
  buckets: Array<{ start: Date; end: Date }>,
): number[] => {
  const out = buckets.map(() => 0);
  for (const r of rows ?? []) {
    const t = typeof r.start === 'number' ? r.start : Date.parse(String(r.start));
    const i = buckets.findIndex((b) => t >= b.start.getTime() && t < b.end.getTime());
    if (i >= 0) out[i] += change(r);
  }
  return out;
};

export const colorAt = (thresholds: Threshold[], watts: number): string => {
  const list = [...thresholds].sort((a, b) => a.value - b.value);
  let c = list[0]?.color ?? '#4CD07D';
  for (const t of list) if (watts >= t.value) c = t.color;
  return c;
};

/** Threshold colours as gradient stops from the bottom (0) to the top (1) of a plot. */
export const gradientStops = (thresholds: Threshold[], max: number): Array<{ offset: number; color: string }> => {
  const list = [...thresholds].sort((a, b) => a.value - b.value);
  const stops = list.map((t) => ({ offset: Math.min(1, Math.max(0, t.value / (max || 1))), color: t.color }));
  if (!stops.length) return [{ offset: 0, color: '#4CD07D' }];
  if (stops[0].offset > 0) stops.unshift({ offset: 0, color: stops[0].color });
  if (stops[stops.length - 1].offset < 1) stops.push({ offset: 1, color: stops[stops.length - 1].color });
  return stops;
};

export const startOfDay = (d: Date): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate());
export const startOfWeek = (d: Date, firstDay = 1): Date => {
  const s = startOfDay(d);
  s.setDate(s.getDate() - ((s.getDay() - firstDay + 7) % 7));
  return s;
};
export const startOfMonth = (d: Date): Date => new Date(d.getFullYear(), d.getMonth(), 1);
export const startOfYear = (d: Date): Date => new Date(d.getFullYear(), 0, 1);

export const firstWeekday = (hass?: HomeAssistant): number => {
  const pref = hass?.locale?.first_weekday;
  if (pref === 'sunday') return 0;
  if (pref === 'saturday') return 6;
  return 1;
};

/** Power in a short readable form: "380 W", "1.24 kW". */
export const formatPower = (watts: number, language?: string): { value: string; unit: string } =>
  Math.abs(watts) >= 1000
    ? { value: new Intl.NumberFormat(language, { maximumFractionDigits: 2, minimumFractionDigits: 2 }).format(watts / 1000), unit: 'kW' }
    : { value: new Intl.NumberFormat(language, { maximumFractionDigits: 0 }).format(watts), unit: 'W' };

export const formatEnergy = (kwh: number, language?: string): string =>
  new Intl.NumberFormat(language, { maximumFractionDigits: kwh >= 100 ? 0 : 1, minimumFractionDigits: kwh >= 100 ? 0 : 1 }).format(kwh);
