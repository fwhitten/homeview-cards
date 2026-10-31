import type { HomeAssistant } from './types';

/** A compressed state from history/history_during_period with minimal_response. */
export interface CompressedState {
  s: string;
  a?: Record<string, any>;
  lu: number;
  lc?: number;
}

export interface StatisticValue {
  start: number;
  end: number;
  mean?: number | null;
  min?: number | null;
  max?: number | null;
  sum?: number | null;
  state?: number | null;
  change?: number | null;
}

interface CacheEntry<T> {
  at: number;
  value: Promise<T>;
}

const cache = new Map<string, CacheEntry<unknown>>();

const cached = <T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> => {
  const hit = cache.get(key) as CacheEntry<T> | undefined;
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  const value = load().catch((err) => {
    cache.delete(key);
    throw err;
  });
  cache.set(key, { at: Date.now(), value });
  return value;
};

/**
 * Recorder history over a window, via the history/history_during_period
 * WebSocket command the frontend's own history panel uses.
 */
export const fetchHistory = (
  hass: HomeAssistant,
  entityIds: string[],
  hours: number,
  opts: { attributes?: boolean; ttlMs?: number } = {},
): Promise<Record<string, CompressedState[]>> => {
  const ids = [...new Set(entityIds.filter(Boolean))].sort();
  if (!ids.length) return Promise.resolve({});
  const key = `h|${ids.join(',')}|${hours}|${opts.attributes ? 1 : 0}`;
  return cached(key, opts.ttlMs ?? 60_000, () => {
    const end = new Date();
    const start = new Date(end.getTime() - hours * 3_600_000);
    return hass.callWS<Record<string, CompressedState[]>>({
      type: 'history/history_during_period',
      start_time: start.toISOString(),
      end_time: end.toISOString(),
      entity_ids: ids,
      minimal_response: true,
      no_attributes: !opts.attributes,
      significant_changes_only: false,
    });
  });
};

/** Long-term statistics via recorder/statistics_during_period. */
export const fetchStatistics = (
  hass: HomeAssistant,
  statisticIds: string[],
  start: Date,
  end: Date,
  period: '5minute' | 'hour' | 'day' | 'week' | 'month',
  types: Array<'change' | 'mean' | 'min' | 'max' | 'sum' | 'state'> = ['change'],
  ttlMs = 60_000,
  /** Units to convert to, e.g. { energy: 'kWh' }, so sensors in Wh and kWh add up. */
  units?: Record<string, string>,
): Promise<Record<string, StatisticValue[]>> => {
  const ids = [...new Set(statisticIds.filter(Boolean))].sort();
  if (!ids.length) return Promise.resolve({});
  const key = `s|${ids.join(',')}|${start.getTime()}|${end.getTime()}|${period}|${types.join(',')}|${JSON.stringify(units ?? {})}`;
  return cached(key, ttlMs, () =>
    hass.callWS<Record<string, StatisticValue[]>>({
      type: 'recorder/statistics_during_period',
      start_time: start.toISOString(),
      end_time: end.toISOString(),
      statistic_ids: ids,
      period,
      types,
      ...(units ? { units } : {}),
    }),
  );
};

/** Numeric samples [timeMs, value] from compressed history, for a state or an attribute. */
export const samples = (states: CompressedState[] | undefined, attribute?: string): Array<[number, number]> => {
  const out: Array<[number, number]> = [];
  let lastAttrs: Record<string, any> | undefined;
  for (const st of states ?? []) {
    if (st.a) lastAttrs = st.a;
    const raw = attribute ? (st.a ?? lastAttrs)?.[attribute] : st.s;
    const v = typeof raw === 'number' ? raw : parseFloat(String(raw));
    if (Number.isFinite(v)) out.push([st.lu * 1000, v]);
  }
  return out;
};

/**
 * Resample step-wise history into `count` evenly spaced points across the
 * window ending now, carrying the last known value forward.
 */
export const resample = (points: Array<[number, number]>, hours: number, count: number): number[] => {
  if (!points.length) return [];
  const end = Date.now();
  const start = end - hours * 3_600_000;
  const step = (end - start) / (count - 1);
  const out: number[] = [];
  let i = 0;
  let current = points[0][1];
  for (let k = 0; k < count; k++) {
    const t = start + k * step;
    while (i < points.length && points[i][0] <= t) current = points[i++][1];
    out.push(current);
  }
  return out;
};
