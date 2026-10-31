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

export interface Signal {
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

/** Energy statistics in kWh whatever each sensor reports in (Wh, kWh, MWh), as the Energy dashboard asks for them. */
export const fetchEnergyStats = (hass: HomeAssistant, ids: string[], start: Date, end: Date, period: 'hour' | 'day' | 'week' | 'month') =>
  fetchStatistics(hass, ids, start, end, period, ['change'], 60_000, { energy: 'kWh' });

const change = (v: StatisticValue): number => (typeof v.change === 'number' && Number.isFinite(v.change) ? v.change : 0);

/** kWh consumed between two moments, from hourly statistics. */
export const energyBetween = async (
  hass: HomeAssistant,
  stats: Array<{ id: string; sign: 1 | -1 }>,
  start: Date,
  end: Date,
): Promise<number> => {
  if (!stats.length) return 0;
  const res = await fetchEnergyStats(hass, stats.map((s) => s.id), start, end, 'hour');
  // Consumption can't go below zero, even if an excluded device's meter runs ahead of the grid's.
  return Math.max(0, stats.reduce((sum, s) => sum + s.sign * (res[s.id] ?? []).reduce((n, v) => n + change(v), 0), 0));
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

// ---------------------------------------------------------------- devices

/** Per-device settings, keyed by the device's energy statistic, as in energy-breakdown-card. */
export interface DeviceOverride {
  stat: string;
  name?: string;
  color?: string;
  /** Left out of the breakdowns, but still counted in the total (it joins "Other"). */
  hidden?: boolean;
  /** Taken out of the total entirely, and so out of every graph. */
  excluded?: boolean;
  /** A power sensor to use instead of the one set in the Energy dashboard. */
  power_entity?: string;
}

export interface EnergyDevice {
  stat: string;
  name: string;
  color: string;
  /** Power entity, in watts. */
  power?: string;
  /** Something to take an icon from. */
  icon?: string;
  hidden: boolean;
  excluded: boolean;
}

export interface DeviceSettings {
  power_entity?: string;
  total_mode?: TotalMode;
  devices?: DeviceOverride[];
}

/** Top-level devices from the Energy dashboard with the card's overrides applied. Colours stay put when others hide. */
export const energyDevices = (hass: HomeAssistant, prefs: EnergyPrefs | undefined, cfg: DeviceSettings): EnergyDevice[] => {
  if (!prefs) return [];
  const overrides = new Map((cfg.devices ?? []).map((d) => [d.stat, d]));
  return topLevelDevices(prefs).map((d, i) => {
    const o = overrides.get(d.stat_consumption);
    const power = o?.power_entity || d.stat_rate;
    return {
      stat: d.stat_consumption,
      name: o?.name || d.name || hass.states[power ?? '']?.attributes.friendly_name || hass.states[d.stat_consumption]?.attributes.friendly_name || d.stat_consumption,
      color: o?.color || DEVICE_COLORS[i % DEVICE_COLORS.length],
      power,
      icon: power ?? (d.stat_consumption.includes('.') ? d.stat_consumption : undefined),
      hidden: !!o?.hidden,
      excluded: !!o?.excluded,
    };
  });
};

/** Power signals for the card's total: its sensor or the Energy dashboard's, less any excluded devices. */
export const totalSignals = (hass: HomeAssistant, prefs: EnergyPrefs | undefined, cfg: DeviceSettings): Signal[] => {
  const base: Signal[] = cfg.power_entity ? [{ entity: cfg.power_entity, sign: 1 }] : prefs ? powerSignals(prefs, cfg.total_mode ?? 'home') : [];
  const excluded = energyDevices(hass, prefs, cfg)
    .filter((d) => d.excluded && d.power)
    .map((d) => ({ entity: d.power!, sign: -1 as const }));
  return [...base, ...excluded];
};

/** Energy statistics for the card's total, less any excluded devices. */
export const totalStats = (hass: HomeAssistant, prefs: EnergyPrefs, cfg: DeviceSettings): Array<{ id: string; sign: 1 | -1 }> => [
  ...consumptionStats(prefs, cfg.total_mode ?? 'home'),
  ...energyDevices(hass, prefs, cfg)
    .filter((d) => d.excluded)
    .map((d) => ({ id: d.stat, sign: -1 as const })),
];

// ---------------------------------------------------------------- power series

/**
 * Up to this many hours the recorder's history is used, which keeps every
 * reading; beyond it five-minute statistics, which outlive the purge window.
 */
export const HISTORY_WINDOW_HOURS = 6;

type Sample = { t: number; v: number | null };

const historySamples = async (hass: HomeAssistant, ids: string[], start: Date, end: Date): Promise<Record<string, Sample[]>> => {
  const res = await hass.callWS<Record<string, Array<{ s: string; lu: number }>>>({
    type: 'history/history_during_period',
    start_time: start.toISOString(),
    end_time: end.toISOString(),
    entity_ids: ids,
    minimal_response: true,
    no_attributes: true,
    significant_changes_only: false,
  });
  const out: Record<string, Sample[]> = {};
  for (const id of ids) {
    const scale = UNIT[hass.states[id]?.attributes.unit_of_measurement ?? 'W'] ?? 1;
    out[id] = (res?.[id] ?? []).map((e) => {
      const v = parseFloat(e.s);
      return { t: e.lu * 1000, v: Number.isFinite(v) ? v * scale : null };
    });
  }
  return out;
};

const statisticSamples = async (hass: HomeAssistant, ids: string[], start: Date, end: Date): Promise<Record<string, Sample[]>> => {
  const res = await hass.callWS<Record<string, Array<{ start: number; mean?: number | null }>>>({
    type: 'recorder/statistics_during_period',
    start_time: start.toISOString(),
    end_time: end.toISOString(),
    statistic_ids: ids,
    period: '5minute',
    types: ['mean'],
    units: { power: 'W' },
  });
  const out: Record<string, Sample[]> = {};
  for (const id of ids) {
    out[id] = (res?.[id] ?? []).map((e) => ({ t: e.start, v: typeof e.mean === 'number' && Number.isFinite(e.mean) ? e.mean : null }));
  }
  return out;
};

/**
 * One value per bucket: the mean of the readings inside it, or the last
 * reading carried forward through quiet stretches. Unavailable leaves a gap.
 */
export const bucketSamples = (samples: Sample[], start: number, end: number, buckets: number): Array<number | null> => {
  const out = new Array<number | null>(buckets).fill(null);
  if (buckets <= 0 || end <= start) return out;
  const width = (end - start) / buckets;
  let i = 0;
  let carried: number | null = null;
  while (i < samples.length && samples[i].t < start) carried = samples[i++].v;
  for (let b = 0; b < buckets; b++) {
    const until = start + width * (b + 1);
    let sum = 0;
    let n = 0;
    let gap = false;
    while (i < samples.length && samples[i].t < until) {
      const v = samples[i++].v;
      if (v === null) {
        gap = true;
        carried = null;
      } else {
        sum += v;
        n++;
        carried = v;
      }
    }
    out[b] = n ? sum / n : gap ? null : carried;
  }
  return out;
};

/**
 * How many points a line is drawn from: `points_per_hour` when set, otherwise
 * one every two pixels of width, as energy-breakdown-card does.
 */
export const bucketCount = (hours: number, pointsPerHour: number | undefined, width: number): number =>
  pointsPerHour && pointsPerHour > 0
    ? Math.max(2, Math.min(2000, Math.round(hours * pointsPerHour)))
    : Math.max(24, Math.min(600, Math.round((width || 300) / 2)));

/**
 * Net power over the last `hours`, from the same recorder data and with the
 * same bucketing as energy-breakdown-card's power graph.
 */
export const fetchPowerSeries = async (
  hass: HomeAssistant,
  signals: Signal[],
  hours: number,
  buckets: number,
): Promise<Array<number | null>> => {
  const ids = [...new Set(signals.map((s) => s.entity))];
  if (!ids.length) return [];
  const end = new Date();
  const start = new Date(end.getTime() - hours * 3_600_000);
  const fetcher = hours > HISTORY_WINDOW_HOURS ? statisticSamples : historySamples;
  const data = await fetcher(hass, ids, start, end);
  const series = signals.map((s) => bucketSamples(data[s.entity] ?? [], start.getTime(), end.getTime(), buckets).map((v) => (v === null ? null : v * s.sign)));
  return Array.from({ length: buckets }, (_, i) => {
    let total = 0;
    let seen = false;
    for (const ser of series) {
      const v = ser[i];
      if (v === null) continue;
      total += v;
      seen = true;
    }
    return seen ? total : null;
  });
};

const STEPS = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];

/** Round an axis maximum up to a value that divides into readable steps (from energy-breakdown-card). */
export const niceMax = (value: number, divisions = 4): number => {
  if (!Number.isFinite(value) || value <= 0) return divisions;
  const rough = (value * 1.02) / divisions;
  const magnitude = Math.pow(10, Math.floor(Math.log10(rough)));
  const step = STEPS.find((s) => rough / magnitude <= s) ?? 10;
  return step * magnitude * divisions;
};
