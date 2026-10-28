import { css, html, nothing, svg, type PropertyValues } from 'lit';
import { state } from 'lit/decorators.js';
import { HomeViewCard, type BaseCardConfig } from '../core/base-card';
import type { GridOptions } from '../core/types';
import { fetchStatistics } from '../core/history';
import { smoothPath } from '../core/chart';
import { areaName, sensorInArea } from '../core/areas';
import { fixed, numericState } from '../core/format';
import { defineElement, registerCard } from '../core/register';

type ComfortState = 'pleasant' | 'too_warm' | 'cold' | 'dry' | 'humid';

export interface ComfortCardConfig extends BaseCardConfig {
  /** An area: its temperature and humidity sensors are found automatically. */
  area?: string;
  temperature_entity?: string;
  humidity_entity?: string;
  /** A: the comfort gauge. C: two scales with the comfort band shaded. */
  style?: 'gauge' | 'scales';
  /** Filled in the comfort colour, or glass with the colour on the state text. */
  background?: 'filled' | 'glass';
  temp_min?: number;
  temp_max?: number;
  temp_outer_min?: number;
  temp_outer_max?: number;
  humidity_min?: number;
  humidity_max?: number;
  humidity_outer_min?: number;
  humidity_outer_max?: number;
  /** Hours of trail behind the gauge marker. 0 turns it off. */
  history_hours?: number;
}

interface Range {
  min: number;
  max: number;
  outerMin: number;
  outerMax: number;
}

const STATES: Record<ComfortState, { label: string; fill: string; ink: string }> = {
  pleasant: { label: 'Pleasant', fill: 'rgba(47,107,71,.88)', ink: 'var(--hv-comfort-pleasant, #7BE0A0)' },
  too_warm: { label: 'Too warm', fill: 'rgba(138,67,33,.9)', ink: 'var(--hv-comfort-warm, #FFA36E)' },
  cold: { label: 'Cold', fill: 'rgba(45,90,134,.9)', ink: 'var(--hv-comfort-cold, #8CC4FF)' },
  dry: { label: 'Dry', fill: 'rgba(138,111,31,.9)', ink: 'var(--hv-comfort-dry, #F0C860)' },
  humid: { label: 'Humid', fill: 'rgba(31,109,114,.9)', ink: 'var(--hv-comfort-humid, #7FD8DC)' },
};

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const deviation = (v: number, r: Range) => (v - (r.min + r.max) / 2) / Math.max(1e-4, (r.max - r.min) / 2);
const position = (v: number, r: Range) => clamp((v - (r.min + r.max) / 2) / Math.max(1e-4, (r.outerMax - r.outerMin) / 2), -1, 1);
const fraction = (v: number, r: Range) => clamp((v - r.outerMin) / (r.outerMax - r.outerMin), 0, 1);

/** The comfort model from Comfort-Card: which state, and where on the gauge. */
const comfort = (t: number, h: number, tr: Range, hr: Range) => {
  const dt = deviation(t, tr);
  const dh = deviation(h, hr);
  let st: ComfortState = 'pleasant';
  if (Math.abs(dt) > 1 || Math.abs(dh) > 1) {
    st = Math.abs(dt) >= Math.abs(dh) ? (dt > 0 ? 'too_warm' : 'cold') : dh > 0 ? 'humid' : 'dry';
  }
  return { state: st, ...gauge(t, h, tr, hr) };
};

const gauge = (t: number, h: number, tr: Range, hr: Range) => {
  let x = position(h, hr);
  let y = -position(t, tr);
  const len = Math.hypot(x, y);
  if (len > 1) {
    x /= len;
    y /= len;
  }
  return { x, y };
};

/**
 * Climate comfort (styles A and C, filled or glass): where a room sits on
 * temperature and humidity, with the state word in the comfort colour.
 */
export class HomeViewComfortCard extends HomeViewCard<ComfortCardConfig> {
  @state() private trail: Array<{ x: number; y: number }> = [];
  private refresh?: number;

  static getConfigForm() {
    return {
      schema: [
        { name: 'area', selector: { area: {} } },
        { name: 'name', selector: { text: {} } },
        {
          type: 'grid',
          name: '',
          schema: [
            { name: 'style', default: 'gauge', selector: { select: { options: [{ value: 'gauge', label: 'A: gauge' }, { value: 'scales', label: 'C: two scales' }] } } },
            { name: 'background', default: 'filled', selector: { select: { options: [{ value: 'filled', label: 'Filled' }, { value: 'glass', label: 'Glass' }] } } },
          ],
        },
        {
          type: 'expandable',
          name: '',
          title: 'Sensors (instead of an area)',
          schema: [
            { name: 'temperature_entity', selector: { entity: { domain: 'sensor', device_class: 'temperature' } } },
            { name: 'humidity_entity', selector: { entity: { domain: 'sensor', device_class: 'humidity' } } },
          ],
        },
        {
          type: 'expandable',
          name: '',
          title: 'Comfort ranges',
          schema: [
            {
              type: 'grid',
              name: '',
              schema: [
                { name: 'temp_min', default: 20, selector: { number: { mode: 'box', step: 0.5 } } },
                { name: 'temp_max', default: 24, selector: { number: { mode: 'box', step: 0.5 } } },
                { name: 'humidity_min', default: 40, selector: { number: { mode: 'box' } } },
                { name: 'humidity_max', default: 60, selector: { number: { mode: 'box' } } },
              ],
            },
          ],
        },
        { name: 'history_hours', default: 3, selector: { number: { min: 0, max: 24, unit_of_measurement: 'h' } } },
        { name: 'tap_action', selector: { ui_action: {} } },
      ],
    };
  }

  static getStubConfig(hass: { areas?: Record<string, { area_id: string }> }) {
    const area = Object.keys(hass?.areas ?? {})[0];
    return area ? { area } : {};
  }

  protected validate(config: ComfortCardConfig): void {
    if (!config.area && !(config.temperature_entity && config.humidity_entity)) {
      throw new Error('Set an area, or both a temperature and a humidity sensor');
    }
  }

  protected defaults(): Partial<ComfortCardConfig> {
    return {
      style: 'gauge',
      background: 'filled',
      temp_min: 20,
      temp_max: 24,
      temp_outer_min: 16,
      temp_outer_max: 28,
      humidity_min: 40,
      humidity_max: 60,
      humidity_outer_min: 20,
      humidity_outer_max: 80,
      history_hours: 3,
    };
  }

  private get sensors(): { temp?: string; hum?: string } {
    const c = this.config;
    if (c.temperature_entity && c.humidity_entity) return { temp: c.temperature_entity, hum: c.humidity_entity };
    if (!this.hass || !c.area) return {};
    return { temp: c.temperature_entity ?? sensorInArea(this.hass, c.area, 'temperature'), hum: c.humidity_entity ?? sensorInArea(this.hass, c.area, 'humidity') };
  }

  protected watched() {
    const s = this.sensors;
    return [s.temp, s.hum];
  }

  private get ranges(): [Range, Range] {
    const c = this.config;
    return [
      { min: c.temp_min!, max: c.temp_max!, outerMin: c.temp_outer_min!, outerMax: c.temp_outer_max! },
      { min: c.humidity_min!, max: c.humidity_max!, outerMin: c.humidity_outer_min!, outerMax: c.humidity_outer_max! },
    ];
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.refresh = window.setInterval(() => void this.loadTrail(), 10 * 60_000);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.clearInterval(this.refresh);
  }

  protected firstUpdated(): void {
    void this.loadTrail();
  }

  protected updated(changed: PropertyValues): void {
    super.updated(changed);
    if (changed.has('config') && changed.get('config')) void this.loadTrail();
  }

  /** The trail uses 5-minute statistics, so it needs sensors with a state_class. */
  private async loadTrail(): Promise<void> {
    const { temp, hum } = this.sensors;
    const hours = this.config.history_hours ?? 0;
    if (!this.hass || !temp || !hum || hours <= 0 || this.config.style !== 'gauge') {
      this.trail = [];
      return;
    }
    const end = new Date();
    try {
      const res = await fetchStatistics(this.hass, [temp, hum], new Date(end.getTime() - hours * 3_600_000), end, '5minute', ['mean'], 5 * 60_000);
      const humBy = new Map((res[hum] ?? []).filter((e) => e.mean != null).map((e) => [e.start, e.mean as number]));
      const [tr, hr] = this.ranges;
      let lastH: number | undefined;
      const pts: Array<{ x: number; y: number }> = [];
      for (const e of res[temp] ?? []) {
        if (e.mean == null) continue;
        lastH = humBy.get(e.start) ?? lastH;
        if (lastH == null) continue;
        const p = gauge(e.mean, lastH, tr, hr);
        const prev = pts[pts.length - 1];
        if (!prev || Math.hypot(p.x - prev.x, p.y - prev.y) > 0.03) pts.push(p);
      }
      this.trail = pts;
    } catch {
      this.trail = [];
    }
  }

  private gaugeSvg(px: number, glass: boolean, x: number, y: number, innerR: number) {
    const R = 46;
    const ring = glass ? 'var(--_track)' : 'rgba(255,255,255,.32)';
    const pts = [...this.trail, { x, y }].map((p) => [50 + p.x * R * 0.92, 50 + p.y * R * 0.92] as [number, number]);
    return svg`<svg viewBox="2 2 96 96" style="width:${px}px;height:${px}px;flex:none" role="img" aria-label="Comfort gauge">
      <circle cx="50" cy="50" r=${R} fill="none" stroke=${ring} stroke-width="1.8"></circle>
      <circle cx="50" cy="50" r=${innerR * R} fill="#fff" fill-opacity=".2"></circle>
      ${pts.length > 1 ? svg`<path d=${smoothPath(pts)} fill="none" stroke="#fff" stroke-opacity=".5" stroke-width="2.6" stroke-linecap="round"></path>` : nothing}
      <circle cx=${pts[pts.length - 1][0]} cy=${pts[pts.length - 1][1]} r=${px > 120 ? 5.5 : 7} fill="#fff"></circle>
    </svg>`;
  }

  private bar(frac: number, band: [number, number], glass: boolean, thick: boolean) {
    return html`<div class="bar ${thick ? 'thick' : ''}" style="background:${glass ? 'var(--_track)' : 'rgba(255,255,255,.2)'}">
      <i style="left:${band[0] * 100}%;width:${(band[1] - band[0]) * 100}%"></i>
      <b style="left:${frac * 100}%"></b>
    </div>`;
  }

  render() {
    if (!this.hass) return nothing;
    const { temp, hum } = this.sensors;
    const t = numericState(this.stateObj(temp));
    const h = numericState(this.stateObj(hum));
    const name = this.config.name ?? (this.config.area ? areaName(this.hass, this.config.area) : undefined) ?? 'Comfort';
    if (t == null || h == null) {
      return html`<ha-card class="tile"><div class="in"><div class="name">${name}</div><div class="sub">${!temp || !hum ? 'No temperature or humidity sensor found' : 'Sensors unavailable'}</div></div></ha-card>`;
    }
    const [tr, hr] = this.ranges;
    const c = comfort(t, h, tr, hr);
    const s = STATES[c.state];
    const glass = this.config.background === 'glass';
    const cardStyle = glass ? '' : `background:radial-gradient(130% 80% at 0% 0%, rgba(255,255,255,.14), rgba(255,255,255,0) 52%),${s.fill};color:#fff`;
    const ink2 = glass ? 'var(--_ink2)' : 'rgba(255,255,255,.84)';
    const stInk = glass ? s.ink : 'rgba(255,255,255,.86)';
    const tText = `${fixed(this.hass, t, 1)}°`;
    const hText = `${Math.round(h)}%`;
    const wide = this.size === 'w' || this.size === 'l';
    const innerR = ((tr.max - tr.min) / (tr.outerMax - tr.outerMin) + (hr.max - hr.min) / (hr.outerMax - hr.outerMin)) / 2;
    const tBand: [number, number] = [fraction(tr.min, tr), fraction(tr.max, tr)];
    const hBand: [number, number] = [fraction(hr.min, hr), fraction(hr.max, hr)];
    const label = `${name}: ${s.label}, ${tText}, ${hText}`;
    const head = html`<div class="text"><div class="name ${wide ? '' : 'sm'}">${name}</div><div class="state" style="color:${stInk}">${s.label}</div></div>`;

    if (this.config.style === 'scales') {
      if (wide) {
        return html`<ha-card class="tile clickable" style=${cardStyle} tabindex="0" role="button" aria-label=${label}>
          <div class="in">
            <div class="row"><div class="name">${name}</div><div class="state big" style="color:${stInk}">${s.label}</div></div>
            <div class="scales">
              <span class="lab" style="color:${ink2}">Temp</span>${this.bar(fraction(t, tr), tBand, glass, true)}<span class="num">${tText}</span>
              <span class="lab" style="color:${ink2}">Humidity</span>${this.bar(fraction(h, hr), hBand, glass, true)}<span class="num">${hText}</span>
            </div>
          </div>
        </ha-card>`;
      }
      return html`<ha-card class="tile clickable" style=${cardStyle} tabindex="0" role="button" aria-label=${label}>
        <div class="in">
          ${head}
          <div class="stack">
            <div><div class="line"><span style="color:${ink2}">Temp</span><span>${tText}</span></div>${this.bar(fraction(t, tr), tBand, glass, false)}</div>
            <div><div class="line"><span style="color:${ink2}">Humidity</span><span>${hText}</span></div>${this.bar(fraction(h, hr), hBand, glass, false)}</div>
          </div>
        </div>
      </ha-card>`;
    }

    if (wide) {
      return html`<ha-card class="tile clickable" style=${cardStyle} tabindex="0" role="button" aria-label=${label}>
        <div class="in rowed">
          <div class="col">
            ${head}
            <div class="vals"><span class="v xl">${tText}</span><span class="v xl" style="color:${ink2}">${hText}</span></div>
          </div>
          ${this.gaugeSvg(172, glass, c.x, c.y, innerR)}
        </div>
      </ha-card>`;
    }
    return html`<ha-card class="tile clickable" style=${cardStyle} tabindex="0" role="button" aria-label=${label}>
      <div class="in">
        ${head}
        <div class="bottom">
          <div class="vals"><span class="v">${tText}</span><span class="v" style="color:${ink2}">${hText}</span></div>
          ${this.gaugeSvg(88, glass, c.x, c.y, innerR)}
        </div>
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
      .text {
        min-width: 0;
      }
      .name.sm {
        font-size: 19px;
      }
      .state {
        font-size: 17px;
        font-weight: 600;
      }
      .state.big {
        font-size: 19px;
        font-weight: 700;
      }
      .bottom {
        display: flex;
        align-items: flex-end;
        justify-content: space-between;
      }
      .vals {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .v {
        font-size: 30px;
        font-weight: 600;
        letter-spacing: -0.02em;
      }
      .v.xl {
        font-size: 46px;
        line-height: 1;
      }
      .rowed {
        flex-direction: row;
        align-items: stretch;
      }
      .col {
        display: flex;
        flex-direction: column;
        justify-content: space-between;
      }
      .row {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
      }
      .stack {
        display: flex;
        flex-direction: column;
        gap: 12px;
      }
      .line {
        display: flex;
        justify-content: space-between;
        font-size: 17px;
        font-weight: 600;
        margin-bottom: 8px;
      }
      .bar {
        position: relative;
        height: 12px;
        border-radius: 6px;
      }
      .bar.thick {
        height: 16px;
        border-radius: 8px;
      }
      .bar i {
        position: absolute;
        top: 0;
        bottom: 0;
        border-radius: inherit;
        background: #fff;
        opacity: 0.32;
      }
      .bar b {
        position: absolute;
        top: -6px;
        width: 8px;
        height: 24px;
        margin-left: -4px;
        border-radius: 4px;
        background: #fff;
        box-shadow: 0 1px 4px rgba(0, 0, 0, 0.35);
      }
      .bar.thick b {
        height: 28px;
        width: 10px;
        margin-left: -5px;
      }
      .scales {
        display: grid;
        grid-template-columns: 96px minmax(0, 1fr) 84px;
        align-items: center;
        gap: 26px 16px;
        padding-bottom: 6px;
      }
      .lab {
        font-size: 17px;
        font-weight: 600;
      }
      .num {
        font-size: 32px;
        font-weight: 600;
        letter-spacing: -0.02em;
        text-align: right;
      }
    `,
  ];
}

defineElement('homeview-comfort-card', HomeViewComfortCard);
registerCard({
  type: 'homeview-comfort-card',
  name: 'HomeView Comfort',
  description: 'How comfortable a room is, from its temperature and humidity: gauge or two scales, filled or glass.',
  docs: 'comfort',
});
