import { css, html, nothing, svg, type PropertyValues } from 'lit';
import { state } from 'lit/decorators.js';
import { HomeViewCard, type BaseCardConfig } from '../core/base-card';
import type { GridOptions, HomeAssistant } from '../core/types';
import { fetchHistory, resample, samples } from '../core/history';
import { areaPath, linePath, mapPoints } from '../core/chart';
import {
  DEFAULT_THRESHOLDS,
  DEVICE_COLORS,
  OTHER_COLOR,
  consumptionStats,
  energyBetween,
  fetchPrefs,
  formatEnergy,
  formatPower,
  gradientStops,
  powerSignals,
  readTotal,
  readWatts,
  startOfDay,
  topLevelDevices,
  bucketize,
  type EnergyPrefs,
  type Threshold,
  type TotalMode,
} from '../core/energy';
import { fetchStatistics } from '../core/history';
import { defineElement, registerCard } from '../core/register';

export interface EnergyCardConfig extends BaseCardConfig {
  /** A: live power over a threshold-coloured sparkline. B: where it's going now. C: today's total first. */
  style?: 'threshold' | 'distribution' | 'total';
  /** A single power sensor to use instead of the Energy dashboard's grid/solar/battery power. */
  power_entity?: string;
  /** Count the whole home (grid + solar + battery) or the grid only. */
  total_mode?: TotalMode;
  thresholds?: Threshold[];
  hours?: number;
}

export interface DeviceNow {
  name: string;
  color: string;
  watts: number;
  entity?: string;
}

const SPARK_POINTS = 60;

/** Live devices from the Energy dashboard, with "Other" as the remainder. */
export const devicesNow = (hass: HomeAssistant, prefs: EnergyPrefs | undefined, total: number | null): DeviceNow[] => {
  if (!prefs) return [];
  const list = topLevelDevices(prefs)
    .map((d, i) => ({
      name: d.name || hass.states[d.stat_rate ?? '']?.attributes.friendly_name || d.stat_consumption,
      color: DEVICE_COLORS[i % DEVICE_COLORS.length],
      watts: Math.max(0, readWatts(hass, d.stat_rate) ?? 0),
      entity: d.stat_rate ?? (d.stat_consumption.includes('.') ? d.stat_consumption : undefined),
    }))
    .filter((d) => d.watts > 0)
    .sort((a, b) => b.watts - a.watts);
  const known = list.reduce((n, d) => n + d.watts, 0);
  if (total != null && total - known > 20) list.push({ name: 'Other', color: OTHER_COLOR, watts: total - known, entity: undefined });
  return list;
};

/**
 * Energy (styles A, B and C, chosen in the card settings). Reads the Energy
 * dashboard, so it needs no entities unless you want a specific power sensor.
 * Tap opens the energy pop-up.
 */
export class HomeViewEnergyCard extends HomeViewCard<EnergyCardConfig> {
  @state() private prefs?: EnergyPrefs;
  @state() private spark: number[] = [];
  @state() private today?: number;
  @state() private yesterday?: number;
  @state() private hourly: number[] = [];
  @state() private error?: string;
  private refresh?: number;

  static getConfigForm() {
    return {
      schema: [
        {
          name: 'style',
          default: 'threshold',
          selector: {
            select: {
              mode: 'list',
              options: [
                { value: 'threshold', label: 'A: live power over a threshold sparkline' },
                { value: 'distribution', label: 'B: where the power is going now' },
                { value: 'total', label: "C: today's total first" },
              ],
            },
          },
        },
        { name: 'name', selector: { text: {} } },
        { name: 'power_entity', selector: { entity: { domain: 'sensor', device_class: 'power' } } },
        { name: 'total_mode', default: 'home', selector: { select: { options: [{ value: 'home', label: 'Whole home' }, { value: 'grid', label: 'Grid only' }] } } },
        { name: 'hours', default: 3, selector: { number: { min: 1, max: 24, unit_of_measurement: 'h' } } },
        {
          name: 'thresholds',
          selector: {
            object: {
              multiple: true,
              label_field: 'value',
              fields: {
                value: { label: 'From (W)', required: true, selector: { number: { min: 0, mode: 'box' } } },
                color: { label: 'Colour', required: true, selector: { text: {} } },
              },
            },
          },
        },
        { name: 'tap_action', selector: { ui_action: {} } },
      ],
      computeHelper: (s: { name: string }) =>
        s.name === 'power_entity' ? 'Leave empty to use the power sensors set up in the Energy dashboard' : undefined,
    };
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
    if (this.config.power_entity) return [{ entity: this.config.power_entity, sign: 1 as const }];
    return this.prefs ? powerSignals(this.prefs, this.config.total_mode ?? 'home') : [];
  }

  protected watched() {
    const devices = this.prefs ? topLevelDevices(this.prefs).map((d) => d.stat_rate) : [];
    return [...this.signals.map((s) => s.entity), ...(this.config.style === 'distribution' ? devices : [])];
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.refresh = window.setInterval(() => void this.load(), 5 * 60_000);
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
    const sigs = this.signals;
    if (sigs.length) {
      try {
        const hist = await fetchHistory(hass, sigs.map((s) => s.entity), hours, { ttlMs: 60_000 });
        const series = sigs.map((s) => resample(samples(hist[s.entity]), hours, SPARK_POINTS).map((v) => v * s.sign));
        const unit = (e: string) => ({ kW: 1000, MW: 1e6 } as Record<string, number>)[hass.states[e]?.attributes.unit_of_measurement] ?? 1;
        this.spark = series[0]
          ? series[0].map((_, i) => series.reduce((sum, ser, k) => sum + (ser[i] ?? 0) * unit(sigs[k].entity), 0))
          : [];
      } catch {
        this.spark = [];
      }
    }
    if (this.prefs) {
      const stats = consumptionStats(this.prefs, this.config.total_mode ?? 'home');
      const now = new Date();
      const day = startOfDay(now);
      const yStart = new Date(day.getTime() - 86_400_000);
      try {
        this.today = await energyBetween(hass, stats, day, now);
        this.yesterday = await energyBetween(hass, stats, yStart, new Date(now.getTime() - 86_400_000));
        if (this.config.style === 'total') {
          const buckets = Array.from({ length: 24 }, (_, h) => ({
            start: new Date(day.getTime() + h * 3_600_000),
            end: new Date(day.getTime() + (h + 1) * 3_600_000),
          }));
          const res = await fetchStatistics(hass, stats.map((s) => s.id), day, now, 'hour', ['change']);
          this.hourly = buckets.map((_, i) => stats.reduce((n, s) => n + s.sign * bucketize(res[s.id], buckets)[i], 0));
        }
      } catch {
        this.today = undefined;
      }
    }
  }

  private get watts(): number | null {
    return this.hass ? readTotal(this.hass, this.signals) : null;
  }

  private sparkline(width: number, height: number, top: number) {
    if (this.spark.length < 2) return nothing;
    const thresholds = this.config.thresholds?.length ? this.config.thresholds : DEFAULT_THRESHOLDS;
    const max = Math.max(...this.spark, thresholds[thresholds.length - 1]?.value ?? 4000) * 1.05;
    const line = linePath(mapPoints(this.spark, 0, width, top, height - 2, 0, max));
    const stops = gradientStops(thresholds, max);
    const id = `pw${this.config.style}`;
    return svg`<svg class="spark" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">
      <defs><linearGradient id=${id} gradientUnits="userSpaceOnUse" x1="0" y1=${height - 2} x2="0" y2=${top}>
        ${stops.map((s) => svg`<stop offset=${s.offset} stop-color=${s.color}></stop>`)}
      </linearGradient></defs>
      <path d=${areaPath(line, width, height)} fill="url(#${id})" fill-opacity=".22"></path>
      <path d=${line} fill="none" stroke="url(#${id})" stroke-width="2.5" stroke-linejoin="round" vector-effect="non-scaling-stroke"></path>
    </svg>`;
  }

  private bolt() {
    return html`<span class="round bolt"><ha-icon icon="mdi:lightning-bolt"></ha-icon></span>`;
  }

  private deviceInline(d: DeviceNow) {
    const st = d.entity ? this.hass!.states[d.entity] : undefined;
    return html`<span class="dev"><span class="devi" style="background:${d.color}" role="img" aria-label=${d.name}>${st
        ? html`<ha-state-icon .hass=${this.hass} .stateObj=${st}></ha-state-icon>`
        : html`<ha-icon icon="mdi:power-plug"></ha-icon>`}</span>${formatPower(d.watts, this.hass!.locale.language).value}&nbsp;${formatPower(d.watts).unit}</span>`;
  }

  render() {
    if (!this.hass) return nothing;
    const lang = this.hass.locale.language;
    const w = this.watts;
    const p = w != null ? formatPower(w, lang) : { value: '—', unit: '' };
    const name = this.config.name ?? (this.size === 'w' ? 'Home power' : 'Power');
    const todayText = this.today != null ? `${formatEnergy(this.today, lang)} kWh` : '';
    const style = this.config.style ?? 'threshold';
    const wide = this.size === 'w' || this.size === 'l';

    if (this.error && w == null) {
      return html`<ha-card class="tile"><div class="in">${this.bolt()}<div class="sub wrap">${this.error}</div></div></ha-card>`;
    }

    if (style === 'distribution') {
      const devices = devicesNow(this.hass, this.prefs, w);
      const total = devices.reduce((n, d) => n + d.watts, 0) || 1;
      return html`<ha-card class="tile clickable" tabindex="0" role="button" aria-label="${name} ${p.value} ${p.unit}">
        <div class="in">
          <div class="${wide ? 'row' : ''}">
            <div class="hd">${this.bolt()}<span class="name">${name}</span></div>
            <div class="reading"><span class="value ${wide ? '' : 'sm'}">${p.value}</span><span class="unit">${p.unit}</span></div>
          </div>
          <div class="dist ${wide ? 'thick' : ''}">${devices.map((d) => html`<div style="flex:${d.watts / total} 1 0;background:${d.color}"></div>`)}</div>
          <div class="devs">${devices.filter((d) => d.name !== 'Other').slice(0, wide ? 5 : 2).map((d) => this.deviceInline(d))}</div>
        </div>
      </ha-card>`;
    }

    if (style === 'total') {
      const delta = this.today != null && this.yesterday ? ((this.today - this.yesterday) / this.yesterday) * 100 : undefined;
      const max = Math.max(0.1, ...this.hourly);
      const nowHour = new Date().getHours();
      const left = html`<div class="stack">
        <div class="hd">${this.bolt()}<span class="name">${this.config.name ?? 'Today'}</span></div>
        <div>
          <div class="reading"><span class="value">${this.today != null ? formatEnergy(this.today, lang) : '—'}</span><span class="unit">kWh</span></div>
          ${delta != null
            ? html`<div class="delta" style="color:${delta <= 0 ? 'var(--_energy-ink)' : 'var(--hv-c-notice)'}">${delta <= 0 ? '↓' : '↑'} ${Math.abs(Math.round(delta))}% vs yesterday</div>`
            : nothing}
        </div>
        <div class="live"><span class="pulse anim"></span>${p.value} ${p.unit} now</div>
      </div>`;
      return html`<ha-card class="tile clickable" tabindex="0" role="button" aria-label="Today ${todayText}">
        <div class="in ${wide ? 'split' : ''}">
          ${left}
          ${wide
            ? html`<div class="hours">
                <div class="hbars">${Array.from({ length: 24 }, (_, i) => {
                  const v = this.hourly[i] ?? 0;
                  return html`<div style="height:${i <= nowHour ? Math.max(3, (v / max) * 100) : 3}%;background:${i === nowHour ? 'var(--hv-c-energy)' : i < nowHour ? 'rgba(76,208,125,.55)' : 'var(--_track)'}"></div>`;
                })}</div>
                <div class="axis"><span>00</span><span>12</span><span>24</span></div>
              </div>`
            : nothing}
        </div>
      </ha-card>`;
    }

    // A: threshold sparkline
    const peak = this.spark.length ? Math.max(...this.spark) : undefined;
    const pk = peak != null ? formatPower(peak, lang) : undefined;
    return html`<ha-card class="tile clickable" tabindex="0" role="button" aria-label="${name} ${p.value} ${p.unit}">
      ${wide ? this.sparkline(426, 208, 100) : this.sparkline(203, 208, 126)}
      <div class="pad ${wide ? 'row' : ''}">
        <div>
          <div class="hd">${this.bolt()}<span class="name">${name}</span></div>
          <div class="reading top"><span class="value ${wide ? 'xl' : ''}">${p.value}</span><span class="unit">${p.unit}</span></div>
          ${wide ? nothing : html`<div class="sub small">${todayText ? `Today ${todayText}` : ''}</div>`}
        </div>
        ${wide
          ? html`<div class="right">
              ${pk ? html`<div class="sub small strong">Peak ${pk.value} ${pk.unit}</div>` : nothing}
              ${todayText ? html`<div class="sub small">Today ${todayText}</div>` : nothing}
              <div class="sub small faint">Last ${this.config.hours ?? 3} h</div>
            </div>`
          : nothing}
      </div>
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
      .spark {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        pointer-events: none;
      }
      .pad {
        position: relative;
        padding: 18px 20px;
      }
      .row {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: 12px;
      }
      .right {
        text-align: right;
      }
      .hd {
        display: flex;
        align-items: center;
        gap: 10px;
      }
      .hd .name {
        font-size: 19px;
      }
      .bolt {
        width: 36px;
        height: 36px;
        background: var(--hv-c-energy);
        color: #06240f;
        cursor: default;
        --mdc-icon-size: 20px;
      }
      .reading {
        display: flex;
        align-items: baseline;
        gap: 4px;
      }
      .reading.top {
        margin-top: 10px;
      }
      .value {
        font-size: 52px;
      }
      .value.sm {
        font-size: 46px;
      }
      .value.xl {
        font-size: 60px;
      }
      .small {
        font-size: 16px;
      }
      .strong {
        font-weight: 600;
      }
      .faint {
        color: var(--_ink3);
      }
      .wrap {
        white-space: normal;
      }
      .dist {
        display: flex;
        height: 14px;
        border-radius: 7px;
        overflow: hidden;
        gap: 2px;
        background: var(--_track);
      }
      .dist.thick {
        height: 18px;
        border-radius: 9px;
      }
      .devs {
        display: flex;
        flex-wrap: wrap;
        gap: 8px 18px;
      }
      .dev {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        font-size: 17px;
        font-weight: 600;
        white-space: nowrap;
      }
      .devi {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 24px;
        height: 24px;
        border-radius: 999px;
        color: #14161c;
        --mdc-icon-size: 15px;
        flex: none;
      }
      .split {
        flex-direction: row;
        gap: 22px;
      }
      .stack {
        display: flex;
        flex-direction: column;
        justify-content: space-between;
        flex: none;
        height: 100%;
      }
      .delta {
        font-size: 16px;
        font-weight: 600;
      }
      .live {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 16px;
        font-weight: 600;
        color: var(--_ink2);
      }
      .pulse {
        width: 9px;
        height: 9px;
        border-radius: 50%;
        background: var(--hv-c-energy);
        animation: pulse 1.6s ease-in-out infinite;
      }
      .hours {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 6px;
        padding-top: 6px;
      }
      .hbars {
        flex: 1;
        display: flex;
        align-items: flex-end;
        gap: 3px;
      }
      .hbars div {
        flex: 1;
        border-radius: 3px;
      }
      .axis {
        display: flex;
        justify-content: space-between;
        font-size: 15px;
        font-weight: 600;
        color: var(--_ink2);
      }
      @keyframes pulse {
        50% {
          opacity: 0.35;
        }
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
