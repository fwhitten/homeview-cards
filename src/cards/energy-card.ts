import { css, html, nothing, svg, type PropertyValues } from 'lit';
import { state } from 'lit/decorators.js';
import { HomeViewCard, type BaseCardConfig } from '../core/base-card';
import type { GridOptions, HomeAssistant } from '../core/types';
import { gappedPaths } from '../core/chart';
import {
  DEFAULT_THRESHOLDS,
  OTHER_COLOR,
  bucketCount,
  energyBetween,
  energyDevices,
  fetchEnergyStats,
  fetchPowerSeries,
  fetchPrefs,
  formatEnergy,
  formatPower,
  gradientStops,
  niceMax,
  readTotal,
  readWatts,
  firstWeekday,
  startOfDay,
  startOfMonth,
  startOfWeek,
  totalSignals,
  totalStats,
  bucketize,
  type DeviceOverride,
  type DeviceSettings,
  type EnergyPrefs,
  type Threshold,
  type TotalMode,
} from '../core/energy';
import { time } from '../core/format';
import { defineElement, registerCard } from '../core/register';
import { actionsSection, appearanceSection, choose, editorFor, layoutSection, type EditorSpec } from '../core/editor';
import './energy-devices-editor';

export interface EnergyCardConfig extends BaseCardConfig {
  /** A: live power over a threshold-coloured sparkline. B: where it's going now. C: today's total first. */
  style?: 'threshold' | 'distribution' | 'total';
  /** A single power sensor to use instead of the Energy dashboard's grid/solar/battery power. */
  power_entity?: string;
  /** Count the whole home (grid + solar + battery) or the grid only. */
  total_mode?: TotalMode;
  thresholds?: Threshold[];
  hours?: number;
  /** Line resolution. Empty: one point every two pixels, like energy-breakdown-card. */
  points_per_hour?: number;
  /** Fix the top of the graph, in watts. Empty: scales to the peak. */
  y_max?: number;
  /** Rename, recolour, hide or exclude Energy dashboard devices. */
  devices?: DeviceOverride[];
}

export interface DeviceNow {
  name: string;
  color: string;
  watts: number;
  entity?: string;
}

/**
 * Live devices from the Energy dashboard, with "Other" as the remainder.
 * Hidden devices fall into Other; excluded ones are already out of the total.
 */
export const devicesNow = (hass: HomeAssistant, prefs: EnergyPrefs | undefined, total: number | null, cfg: DeviceSettings = {}): DeviceNow[] => {
  if (!prefs) return [];
  const list = energyDevices(hass, prefs, cfg)
    .filter((d) => !d.hidden && !d.excluded)
    .map((d) => ({ name: d.name, color: d.color, watts: Math.max(0, readWatts(hass, d.power) ?? 0), entity: d.icon }))
    .filter((d) => d.watts > 0)
    .sort((a, b) => b.watts - a.watts);
  const known = list.reduce((n, d) => n + d.watts, 0);
  if (total != null && total - known > 20) list.push({ name: 'Other', color: OTHER_COLOR, watts: total - known, entity: undefined });
  return list;
};

const EDITOR: EditorSpec = {
  schema: (c) => {
    const style = c.style ?? 'threshold';
    return [
      { name: 'style', selector: choose([['threshold', 'A: live power over a sparkline'], ['distribution', 'B: where the power is going now'], ['total', "C: today's energy first"]], 'list') },
      { name: 'name', selector: { text: {} } },
      { name: 'power_entity', selector: { entity: { domain: 'sensor', device_class: 'power' } } },
      ...(!c.power_entity ? [{ name: 'total_mode', selector: choose([['home', 'Whole home (grid, solar and battery)'], ['grid', 'Grid only']]) }] : []),
      ...(style === 'threshold'
        ? [
            { name: 'hours', selector: { number: { min: 1, max: 24, mode: 'slider', unit_of_measurement: 'h' } } },
            {
              type: 'grid',
              name: '',
              schema: [
                { name: 'points_per_hour', selector: { number: { min: 2, max: 720, mode: 'box', unit_of_measurement: 'per hour' } } },
                { name: 'y_max', selector: { number: { min: 0, mode: 'box', unit_of_measurement: 'W' } } },
              ],
            },
          ]
        : []),
      ...(style !== 'total'
        ? [
            {
              name: 'thresholds',
              selector: {
                object: {
                  multiple: true,
                  label_field: 'value',
                  fields: {
                    value: { label: 'From (watts)', required: true, selector: { number: { min: 0, mode: 'box', unit_of_measurement: 'W' } } },
                    color: { label: 'Colour', required: true, selector: { text: {} } },
                  },
                },
              },
            },
          ]
        : []),
      appearanceSection,
      actionsSection(),
      layoutSection,
    ];
  },
  labels: { style: 'Style', power_entity: 'Power sensor', total_mode: 'Count', hours: 'Graph covers', points_per_hour: 'Graph points', y_max: 'Graph top', thresholds: 'Power colours' },
  helpers: {
    power_entity: 'Leave empty to use the power sensors set up in the Energy dashboard',
    thresholds: 'The line takes each colour from that power upwards. Defaults: green, amber from 1.5 kW, red from 4 kW',
    tap_action: 'Default: opens the energy pop-up',
    points_per_hour: 'Empty: one point every two pixels',
    y_max: 'Empty: scales to the peak',
  },
  custom: (hass, config, set) =>
    html`<homeview-energy-devices-editor .hass=${hass} .config=${config} @devices-changed=${(e: CustomEvent<DeviceOverride[] | undefined>) => set({ ...config, devices: e.detail })}></homeview-energy-devices-editor>`,
};

/**
 * Energy (styles A, B and C, chosen in the card settings). Reads the Energy
 * dashboard, so it needs no entities unless you want a specific power sensor.
 * Tap opens the energy pop-up.
 *
 * Every style shares one layout: the label with its context underneath, the
 * value top right on wide tiles (under the label on narrow ones), then the
 * picture filling the rest. The tile's size decides how much it shows.
 */
export class HomeViewEnergyCard extends HomeViewCard<EnergyCardConfig> {
  @state() private prefs?: EnergyPrefs;
  @state() private spark: Array<number | null> = [];
  @state() private today?: number;
  /** Yesterday up to the same time of day, for the comparison. */
  @state() private yesterday?: number;
  @state() private yesterdayFull?: number;
  @state() private week?: number;
  @state() private month?: number;
  @state() private hourly: number[] = [];
  @state() private error?: string;
  private refresh?: number;
  private sparkEnd = Date.now();
  private gradientId = `hvpw${Math.random().toString(36).slice(2, 8)}`;

  static getConfigElement() {
    return editorFor(EDITOR);
  }

  static getStubConfig() {
    return { style: 'threshold' };
  }

  protected defaults(): Partial<EnergyCardConfig> {
    return { style: 'threshold', total_mode: 'home', hours: 3 };
  }

  protected popupName(): string {
    return 'energy';
  }

  private get signals() {
    return this.hass ? totalSignals(this.hass, this.prefs, this.config) : [];
  }

  protected watched() {
    const devices = this.prefs && this.hass ? energyDevices(this.hass, this.prefs, this.config).map((d) => d.power) : [];
    return [...this.signals.map((s) => s.entity), ...(this.config.style === 'distribution' ? devices : [])];
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.refresh = window.setInterval(() => void this.load(), 2 * 60_000);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.clearInterval(this.refresh);
  }

  protected firstUpdated(): void {
    void this.load();
  }

  protected updated(changed: PropertyValues): void {
    super.updated(changed);
    if (changed.has('config') && changed.get('config')) void this.load();
  }

  private async load(): Promise<void> {
    if (!this.hass) return;
    try {
      this.prefs = await fetchPrefs(this.hass);
    } catch {
      this.prefs = undefined;
      if (!this.config.power_entity) this.error = 'Set up the Energy dashboard, or choose a power sensor';
    }
    const hass = this.hass;
    const hours = this.config.hours ?? 3;
    const style = this.config.style ?? 'threshold';
    const sigs = this.signals;
    if (sigs.length && style === 'threshold') {
      try {
        const width = this.getBoundingClientRect().width || 420;
        this.sparkEnd = Date.now();
        this.spark = await fetchPowerSeries(hass, sigs, hours, bucketCount(hours, this.config.points_per_hour, width));
      } catch {
        this.spark = [];
      }
    }
    if (this.prefs && style === 'total') {
      const stats = totalStats(hass, this.prefs, this.config);
      const now = new Date();
      const day = startOfDay(now);
      const yStart = new Date(day.getTime() - 86_400_000);
      try {
        const between = (a: Date, b: Date) => energyBetween(hass, stats, a, b);
        [this.today, this.yesterday, this.yesterdayFull, this.week, this.month] = await Promise.all([
          between(day, now),
          between(yStart, new Date(now.getTime() - 86_400_000)),
          between(yStart, day),
          between(startOfWeek(now, firstWeekday(hass)), now),
          between(startOfMonth(now), now),
        ]);
        const buckets = Array.from({ length: 24 }, (_, h) => ({
          start: new Date(day.getTime() + h * 3_600_000),
          end: new Date(day.getTime() + (h + 1) * 3_600_000),
        }));
        const res = await fetchEnergyStats(hass, stats.map((s) => s.id), day, now, 'hour');
        this.hourly = buckets.map((_, i) => Math.max(0, stats.reduce((n, s) => n + s.sign * bucketize(res[s.id], buckets)[i], 0)));
      } catch {
        this.today = undefined;
      }
    }
  }

  private get watts(): number | null {
    return this.hass ? readTotal(this.hass, this.signals) : null;
  }

  private get readings(): number[] {
    return this.spark.filter((v): v is number => v !== null);
  }

  private get peak(): number | undefined {
    const vals = this.readings;
    return vals.length ? Math.max(...vals) : undefined;
  }

  private get wide(): boolean {
    return this.size === 'w' || this.size === 'l';
  }

  // ---------------------------------------------------------------- shared parts

  private power(watts: number) {
    const p = formatPower(watts, this.hass!.locale.language);
    return html`${p.value}<span class="u">${p.unit}</span>`;
  }

  /** Label, context lines and value, laid out for the tile's width. */
  private head(label: string, value: unknown, context: unknown[]) {
    const eyebrow = html`<div class="eb"><ha-icon icon="mdi:lightning-bolt"></ha-icon><span>${label}</span></div>`;
    if (this.wide) {
      return html`<div class="whead">
        <div class="wl">${eyebrow}${context}</div>
        <div class="val ${this.size === 'l' ? 'xl' : ''}">${value}</div>
      </div>`;
    }
    return html`<div class="nhead">
      ${eyebrow}
      <div class="val ${this.size === 's' ? 'sm' : ''}">${value}</div>
      ${context[0] ?? nothing}
    </div>`;
  }

  private stats(items: Array<[unknown, string]>) {
    return html`<div class="stats">${items.map(([v, label]) => html`<div class="stat"><b>${v}</b><div>${label}</div></div>`)}</div>`;
  }

  private deviceIcon(d: DeviceNow) {
    const st = d.entity ? this.hass!.states[d.entity] : undefined;
    return html`<span class="devi" style="background:${d.color}" role="img" aria-label=${d.name}>${st
      ? html`<ha-state-icon .hass=${this.hass} .stateObj=${st}></ha-state-icon>`
      : html`<ha-icon icon="mdi:power-plug"></ha-icon>`}</span>`;
  }

  /** The device bar: segments cut apart by gaps, fully round only at its two ends. */
  private bar(devices: DeviceNow[], total: number) {
    return html`<div class="bar">${devices.map((d) => html`<div style="flex:${d.watts / total} 1 0;background:${d.color}"></div>`)}</div>`;
  }

  // ---------------------------------------------------------------- A: power

  private sparkline(labels: boolean) {
    if (this.spark.length < 2) return html`<div class="plot"></div>`;
    const W = 1000;
    // With time labels the fill carries on beneath them while the line stays clear above.
    const H = labels ? 122 : 100;
    const thresholds = this.config.thresholds?.length ? this.config.thresholds : DEFAULT_THRESHOLDS;
    const max = this.config.y_max && this.config.y_max > 0 ? this.config.y_max : niceMax(Math.max(this.peak ?? 0, 100), 2);
    const { line, area: fill } = gappedPaths(this.spark, 0, W, 3, 100, max, H);
    const stops = gradientStops(thresholds, max);
    const id = this.gradientId;
    const hours = this.config.hours ?? 3;
    const marks = this.size === 'l' ? [0, 1 / 3, 2 / 3] : [0];
    return html`<div class="plot">
      ${svg`<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
        <defs><linearGradient id=${id} gradientUnits="userSpaceOnUse" x1="0" y1="100" x2="0" y2="0">
          ${stops.map((s) => svg`<stop offset=${s.offset} stop-color=${s.color}></stop>`)}
        </linearGradient></defs>
        <path d=${fill} fill="url(#${id})" fill-opacity=".22"></path>
        <path d=${line} fill="none" stroke="url(#${id})" stroke-width="2.5" stroke-linejoin="round" vector-effect="non-scaling-stroke"></path>
      </svg>`}
      ${labels
        ? html`<div class="tlab">${marks.map((f) => html`<span>${time(this.hass, new Date(this.sparkEnd - (1 - f) * hours * 3_600_000))}</span>`)}<span>Now</span></div>`
        : nothing}
    </div>`;
  }

  private renderPower(watts: number | null, name: string) {
    const lang = this.hass!.locale.language;
    const peak = this.peak;
    const vals = this.readings;
    const peakText = peak != null ? html`<div class="ctx">Peak ${formatPower(peak, lang).value} ${formatPower(peak).unit}</div>` : nothing;
    const roomy = this.size === 't' || this.size === 'l';
    let extra: unknown = nothing;
    if (roomy && vals.length) {
      const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
      const items: Array<[unknown, string]> = [
        [this.power(avg), 'Average'],
        [this.power(Math.min(...vals)), 'Lowest'],
      ];
      if (this.size === 'l' && peak != null) {
        const i = this.spark.indexOf(peak);
        const hours = this.config.hours ?? 3;
        items.push([time(this.hass, new Date(this.sparkEnd - (1 - i / Math.max(1, this.spark.length - 1)) * hours * 3_600_000)), 'Peak at']);
      }
      extra = this.stats(items);
    }
    return html`
      ${this.head(name, watts != null ? this.power(watts) : '—', [peakText, html`<div class="meta">Last ${this.config.hours ?? 3} h</div>`])}
      ${extra}
      ${this.sparkline(roomy)}
    `;
  }

  // ---------------------------------------------------------------- B: devices

  private renderDevices(watts: number | null, name: string) {
    const lang = this.hass!.locale.language;
    const all = devicesNow(this.hass!, this.prefs, watts, this.config);
    const total = all.reduce((n, d) => n + d.watts, 0) || 1;
    const named = all.filter((d) => d.name !== 'Other');
    const other = all.find((d) => d.name === 'Other');
    const top = named[0];
    const share = top ? html`<div class="ctx">${Math.round((top.watts / total) * 100)}% ${top.name}</div>` : nothing;
    const amount = (d: DeviceNow) => html`${formatPower(d.watts, lang).value}&nbsp;${formatPower(d.watts).unit}`;
    const legend = (list: DeviceNow[]) => html`<div class="leg">${list.map((d) => html`<span class="li">${this.deviceIcon(d)}${amount(d)}</span>`)}</div>`;
    const rows = (list: DeviceNow[], pct: boolean) =>
      html`<div class="list">${list.map(
        (d) => html`<div class="lr">${this.deviceIcon(d)}<span class="n">${d.name}</span><span>${amount(d)}</span>${pct ? html`<span class="p">${Math.round((d.watts / total) * 100)}%</span>` : nothing}</div>`,
      )}</div>`;
    let body: unknown;
    if (this.size === 'w') body = legend([...named.slice(0, 3), ...(other ? [other] : [])]);
    else if (this.size === 's') body = legend(named.slice(0, 2));
    else body = rows(all.slice(0, this.size === 'l' ? 6 : 5), this.size === 'l');
    return html`
      ${this.head(name, watts != null ? this.power(watts) : '—', [this.size === 's' ? nothing : share, html`<div class="meta"><span class="live"></span>Live</div>`])}
      <div class="foot">${all.length ? this.bar(all, total) : nothing}${body}</div>
    `;
  }

  // ---------------------------------------------------------------- C: today

  private renderToday(name: string) {
    const lang = this.hass!.locale.language;
    const kwh = (v: number | undefined) => html`${v != null ? formatEnergy(v, lang) : '—'}<span class="u">kWh</span>`;
    const delta = this.today != null && this.yesterday ? ((this.today - this.yesterday) / this.yesterday) * 100 : undefined;
    const vs =
      delta != null
        ? html`<div class="ctx" style="color:${delta <= 0 ? 'var(--_energy-ink)' : 'var(--hv-c-notice)'}">${delta <= 0 ? '↓' : '↑'} ${Math.abs(Math.round(delta))}% vs yesterday</div>`
        : nothing;
    const monthName = new Intl.DateTimeFormat(lang, { month: 'long' }).format(new Date());
    let extra: unknown = nothing;
    if (this.size === 't') extra = this.stats([[kwh(this.yesterdayFull), 'Yesterday'], [kwh(this.week), 'This week']]);
    if (this.size === 'l') extra = this.stats([[kwh(this.yesterdayFull), 'Yesterday'], [kwh(this.week), 'This week'], [kwh(this.month), monthName]]);
    const max = Math.max(0.1, ...this.hourly);
    const nowHour = new Date().getHours();
    const axis = this.size === 's' ? [] : this.size === 't' ? ['00', '12', '24'] : ['00', '06', '12', '18', '24'];
    return html`
      ${this.head(name, kwh(this.today), [vs])}
      ${extra}
      <div class="hours">
        <div class="hbars">${Array.from({ length: 24 }, (_, i) => {
          const v = this.hourly[i] ?? 0;
          const bg = i === nowHour ? 'var(--hv-c-energy)' : i < nowHour ? 'rgba(76,208,125,.6)' : 'var(--_track)';
          return html`<div style="height:${i <= nowHour ? Math.max(5, (v / max) * 100) : 5}%;background:${bg}"></div>`;
        })}</div>
        ${axis.length ? html`<div class="axis">${axis.map((a) => html`<span>${a}</span>`)}</div>` : nothing}
      </div>
    `;
  }

  render() {
    if (!this.hass) return nothing;
    const w = this.watts;
    const style = this.config.style ?? 'threshold';
    if (this.error && w == null) {
      return html`<ha-card class="tile"><div class="in"><ha-icon icon="mdi:lightning-bolt"></ha-icon><div class="sub wrap">${this.error}</div></div></ha-card>`;
    }
    const p = w != null ? formatPower(w, this.hass.locale.language) : { value: '—', unit: '' };
    const name =
      this.config.name ??
      (style === 'distribution' ? 'Using now' : style === 'total' ? (this.wide ? 'Energy today' : 'Today') : 'Power');
    const label =
      style === 'total' && this.today != null ? `${name} ${formatEnergy(this.today, this.hass.locale.language)} kWh` : `${name} ${p.value} ${p.unit}`;
    return html`<ha-card class="tile clickable energy ${style}" tabindex="0" role="button" aria-label=${label}>
      ${style === 'distribution' ? this.renderDevices(w, name) : style === 'total' ? this.renderToday(name) : this.renderPower(w, name)}
    </ha-card>`;
  }

  getGridOptions(): GridOptions {
    return { columns: 6, rows: 3, min_columns: 6, min_rows: 3 };
  }

  getCardSize(): number {
    return 3;
  }

  static styles = [
    ...HomeViewCard.styles,
    css`
      ha-card.energy {
        display: flex;
        flex-direction: column;
      }
      .eb {
        display: flex;
        align-items: center;
        gap: 7px;
        min-width: 0;
        font-size: 17px;
        font-weight: 600;
        white-space: nowrap;
        --mdc-icon-size: 18px;
      }
      .eb span {
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .whead {
        flex: none;
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: 12px;
        padding: 18px 20px 0;
      }
      .wl {
        display: flex;
        flex-direction: column;
        gap: 3px;
        min-width: 0;
      }
      .nhead {
        flex: none;
        display: flex;
        flex-direction: column;
        gap: 6px;
        padding: 18px 20px 0;
      }
      .val {
        font-size: 52px;
        font-weight: 600;
        letter-spacing: -0.02em;
        line-height: 1;
        white-space: nowrap;
      }
      .val.xl {
        font-size: 64px;
      }
      .val.sm {
        font-size: 40px;
      }
      .u {
        font-size: 0.38em;
        font-weight: 600;
        letter-spacing: 0;
        color: var(--_ink2);
        margin-left: 4px;
      }
      .ctx {
        font-size: 15px;
        font-weight: 600;
        color: var(--_ink2);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .meta {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 14px;
        font-weight: 600;
        color: var(--_ink3);
        white-space: nowrap;
      }
      .live {
        width: 7px;
        height: 7px;
        border-radius: 50%;
        background: var(--hv-c-energy);
      }
      .stats {
        flex: none;
        display: flex;
        gap: 22px;
        padding: 14px 20px 0;
      }
      .stat b {
        font-size: 22px;
        font-weight: 600;
        white-space: nowrap;
      }
      .stat .u {
        font-size: 14px;
        margin-left: 3px;
      }
      .stat div {
        font-size: 13px;
        font-weight: 600;
        color: var(--_ink3);
        margin-top: 2px;
      }
      .plot {
        position: relative;
        flex: 1;
        min-height: 40px;
        margin-top: 10px;
        pointer-events: none;
      }
      .plot svg {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
      }
      .tlab {
        position: absolute;
        left: 18px;
        right: 18px;
        bottom: 14px;
        display: flex;
        justify-content: space-between;
        font-size: 13px;
        font-weight: 600;
        color: var(--_ink2);
      }
      .foot {
        margin-top: auto;
        padding: 12px 20px 18px;
        display: flex;
        flex-direction: column;
        gap: 12px;
      }
      :host([size='l']) .foot {
        gap: 20px;
        padding-bottom: 22px;
      }
      .bar {
        display: flex;
        gap: 4px;
        height: 14px;
        border-radius: 7px;
        overflow: hidden;
      }
      .bar div {
        min-width: 4px;
        border-radius: 3px;
      }
      :host([size='s']) .bar {
        height: 10px;
        gap: 3px;
        border-radius: 5px;
      }
      :host([size='l']) .bar {
        height: 18px;
        gap: 5px;
        border-radius: 9px;
      }
      .devi {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex: none;
        width: 24px;
        height: 24px;
        border-radius: 999px;
        color: #17151f;
        --mdc-icon-size: 15px;
      }
      .leg {
        display: flex;
        gap: 16px;
        overflow: hidden;
      }
      :host([size='s']) .leg {
        gap: 10px;
      }
      .li {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        font-size: 16px;
        font-weight: 600;
        white-space: nowrap;
      }
      :host([size='s']) .li {
        font-size: 14px;
        gap: 4px;
      }
      :host([size='s']) .devi {
        width: 20px;
        height: 20px;
        --mdc-icon-size: 12px;
      }
      .list {
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      .lr {
        display: flex;
        align-items: center;
        gap: 10px;
        font-size: 16px;
        font-weight: 600;
        white-space: nowrap;
      }
      :host([size='l']) .lr {
        font-size: 17px;
      }
      :host([size='t']) .lr {
        gap: 8px;
        font-size: 15px;
      }
      :host([size='t']) .devi {
        width: 22px;
        height: 22px;
        --mdc-icon-size: 13px;
      }
      .lr .n {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        color: var(--_ink2);
      }
      .lr .p {
        width: 38px;
        text-align: right;
        font-size: 14px;
        color: var(--_ink3);
      }
      .hours {
        flex: 1;
        min-height: 0;
        display: flex;
        flex-direction: column;
        gap: 4px;
        padding: 12px 20px 14px;
      }
      :host([size='s']) .hours {
        padding: 10px 18px 18px;
      }
      :host([size='l']) .hours {
        padding: 18px 20px 16px;
      }
      .hbars {
        flex: 1;
        min-height: 0;
        display: flex;
        align-items: flex-end;
        gap: 3px;
      }
      :host([size='s']) .hbars,
      :host([size='t']) .hbars {
        gap: 2px;
      }
      .hbars div {
        flex: 1;
        border-radius: 3px;
      }
      .axis {
        display: flex;
        justify-content: space-between;
        font-size: 13px;
        font-weight: 600;
        color: var(--_ink3);
      }
      .wrap {
        white-space: normal;
      }
    `,
  ];
}

defineElement('homeview-energy-card', HomeViewEnergyCard);
registerCard({
  type: 'homeview-energy-card',
  name: 'HomeView Energy',
  description: 'Live power from your Energy dashboard in three styles. Tap for graphs, totals and the device breakdown.',
  docs: 'energy',
});
