import { css, html, nothing, svg } from 'lit';
import { state } from 'lit/decorators.js';
import { PopupContent } from './popup-base';
import { STATES, comfort, comfortSensors, type ComfortCardConfig, type Range } from '../cards/comfort-card';
import { fetchHistory, samples, type CompressedState } from '../core/history';
import { linePath, monotonePath, type Point } from '../core/chart';
import { SizeController } from '../core/measure';
import { areaName } from '../core/areas';
import { duration, fixed, numericState, time } from '../core/format';
import { defineElement } from '../core/register';

const SPANS = [6, 12, 24, 48];
const HEAT = '#FF8A3D';
const HUMID = '#5AC8FA';

type Span = { from: number; to: number };

/**
 * Comfort pop-up: the room's temperature and humidity over time against its
 * comfort ranges, the thermostat's target, and when it was heating (from the
 * thermostat's own activity).
 */
export class HomeViewComfortPopup extends PopupContent {
  @state() private hours = 24;
  @state() private hist: Record<string, CompressedState[]> = {};
  @state() private loading = false;
  private loadedFor?: string;
  private tempSize = new SizeController(this, '.tchart');
  private humSize = new SizeController(this, '.hchart');
  private heatSize = new SizeController(this, '.heat');

  private get c(): ComfortCardConfig {
    return this.cfg as ComfortCardConfig;
  }

  private get ids() {
    return this.hass ? comfortSensors(this.hass, this.c) : {};
  }

  private get ranges(): [Range, Range] {
    const c = this.c;
    return [
      { min: c.temp_min ?? 20, max: c.temp_max ?? 24, outerMin: c.temp_outer_min ?? 16, outerMax: c.temp_outer_max ?? 28 },
      { min: c.humidity_min ?? 40, max: c.humidity_max ?? 60, outerMin: c.humidity_outer_min ?? 20, outerMax: c.humidity_outer_max ?? 80 },
    ];
  }

  popupTitle(): string {
    return this.c.name ?? (this.c.area && this.hass ? areaName(this.hass, this.c.area) : undefined) ?? 'Comfort';
  }

  popupSubtitle(): string {
    return this.hass ? `Comfort · updated ${time(this.hass, new Date())}` : '';
  }

  protected updated(): void {
    const { temp, hum, climate } = this.ids;
    const key = `${temp}|${hum}|${climate}|${this.hours}`;
    if (!this.hass || this.loadedFor === key) return;
    this.loadedFor = key;
    void this.load([temp, hum, climate].filter((x): x is string => !!x));
  }

  private async load(ids: string[]): Promise<void> {
    this.loading = true;
    try {
      this.hist = await fetchHistory(this.hass!, ids, this.hours, { attributes: true, ttlMs: 2 * 60_000 });
    } catch {
      this.hist = {};
    }
    this.loading = false;
  }

  /** Temperature readings: the sensor, or the thermostat's own reading when there's no sensor. */
  private get temps(): Array<[number, number]> {
    const { temp, climate } = this.ids;
    if (temp) return samples(this.hist[temp]);
    return climate ? samples(this.hist[climate], 'current_temperature') : [];
  }

  private get humidity(): Array<[number, number]> {
    const { hum, climate } = this.ids;
    if (hum) return samples(this.hist[hum]);
    return climate ? samples(this.hist[climate], 'current_humidity') : [];
  }

  private get targets(): Array<[number, number]> {
    const { climate } = this.ids;
    return climate ? samples(this.hist[climate], 'temperature') : [];
  }

  /** Stretches when the thermostat reported it was heating. */
  private get heating(): Span[] {
    const { climate } = this.ids;
    const states = climate ? this.hist[climate] : undefined;
    if (!states?.length) return [];
    const out: Span[] = [];
    let attrs: Record<string, any> | undefined;
    let since: number | undefined;
    for (const s of states) {
      if (s.a) attrs = s.a;
      const t = s.lu * 1000;
      const on = s.s !== 'off' && (attrs?.hvac_action === 'heating' || attrs?.hvac_action === 'preheating');
      if (on && since === undefined) since = t;
      if (!on && since !== undefined) {
        out.push({ from: since, to: t });
        since = undefined;
      }
    }
    if (since !== undefined) out.push({ from: since, to: Date.now() });
    return out;
  }

  private x(t: number, w: number, start: number, end: number): number {
    return ((Math.max(start, Math.min(end, t)) - start) / (end - start)) * w;
  }

  /** Points across the window, carrying the reading in force at its start. */
  private points(data: Array<[number, number]>, w: number, h: number, lo: number, hi: number, start: number, end: number): Point[] {
    const y = (v: number) => h - 4 - ((v - lo) / (hi - lo || 1)) * (h - 8);
    const before = data.filter(([t]) => t <= start).pop();
    const inside = data.filter(([t]) => t > start);
    const pts: Point[] = [];
    if (before) pts.push([0, y(before[1])]);
    for (const [t, v] of inside) pts.push([this.x(t, w, start, end), y(v)]);
    if (pts.length) pts.push([w, pts[pts.length - 1][1]]);
    return pts;
  }

  /** A line chart with the comfort band, optional heating stretches behind and an optional stepped target. */
  private chart(cls: string, size: SizeController, data: Array<[number, number]>, band: [number, number], color: string, unit: string, opts: { heat?: Span[]; target?: Array<[number, number]> } = {}) {
    const { width: W, height: H } = size;
    const end = Date.now();
    const start = end - this.hours * 3_600_000;
    const visible = data.filter(([t]) => t >= start).map(([, v]) => v);
    const tvals = (opts.target ?? []).filter(([t]) => t >= start).map(([, v]) => v);
    const all = [...visible, ...tvals, band[0], band[1]];
    const pad = Math.max(1, (Math.max(...all) - Math.min(...all)) * 0.12);
    const lo = Math.floor(Math.min(...all) - pad);
    const hi = Math.ceil(Math.max(...all) + pad);
    const y = (v: number) => H - 4 - ((v - lo) / (hi - lo || 1)) * (H - 8);
    const ticks = [hi, (hi + lo) / 2, lo];
    let body: unknown = nothing;
    if (W && H && data.length) {
      const line = monotonePath(this.points(data, W, H, lo, hi, start, end));
      // A target is a set point: draw it as steps, not a slope.
      const tp = this.points(opts.target ?? [], W, H, lo, hi, start, end);
      const steps: Point[] = [];
      tp.forEach((p, i) => {
        if (i > 0) steps.push([p[0], tp[i - 1][1]]);
        steps.push(p);
      });
      body = svg`<svg viewBox="0 0 ${W} ${H}" aria-hidden="true">
        <rect x="0" y=${y(band[1])} width=${W} height=${Math.max(0, y(band[0]) - y(band[1]))} fill="var(--hv-comfort-pleasant, #7BE0A0)" fill-opacity=".1"></rect>
        ${(opts.heat ?? []).map((s) => svg`<rect x=${this.x(s.from, W, start, end)} y="0" width=${Math.max(1.5, this.x(s.to, W, start, end) - this.x(s.from, W, start, end))} height=${H} fill=${HEAT} fill-opacity=".14"></rect>`)}
        ${steps.length > 1 ? svg`<path d=${linePath(steps)} fill="none" stroke="var(--_ink2)" stroke-width="2" stroke-dasharray="6 6"></path>` : nothing}
        <path d=${line} fill="none" stroke=${color} stroke-width="3" stroke-linejoin="round" stroke-linecap="round"></path>
      </svg>`;
    }
    return html`<div class="chartrow">
      <div class="yaxis">${ticks.map((v) => html`<span>${Math.round(v)}${unit}</span>`)}</div>
      <div class="plot ${cls}">${body}${!data.length && !this.loading ? html`<div class="empty sub">No history</div>` : nothing}</div>
    </div>`;
  }

  private heatStrip(spans: Span[]) {
    const { width: W } = this.heatSize;
    const end = Date.now();
    const start = end - this.hours * 3_600_000;
    return html`<div class="heat" aria-hidden="true">${W
      ? spans.map((s) => html`<i style="left:${this.x(s.from, W, start, end)}px;width:${Math.max(3, this.x(s.to, W, start, end) - this.x(s.from, W, start, end))}px"></i>`)
      : nothing}</div>`;
  }

  render() {
    if (!this.hass) return nothing;
    const { temp, hum, climate } = this.ids;
    const cl = this.st(climate);
    const t = temp ? numericState(this.st(temp)) : numericState(cl, 'current_temperature');
    const h = hum ? numericState(this.st(hum)) : numericState(cl, 'current_humidity');
    const [tr, hr] = this.ranges;
    const s = t != null && h != null ? STATES[comfort(t, h, tr, hr).state] : undefined;
    const target = numericState(cl, 'temperature');
    const action = cl?.attributes.hvac_action as string | undefined;
    const heatingNow = action === 'heating' || action === 'preheating';
    const heat = this.heating;
    const end = Date.now();
    const start = end - this.hours * 3_600_000;
    const heatedMs = heat.reduce((n, sp) => n + Math.max(0, Math.min(end, sp.to) - Math.max(start, sp.from)), 0);
    const axis = [1, 2 / 3, 1 / 3].map((f) => time(this.hass, new Date(end - f * this.hours * 3_600_000)));

    return html`
      <div class="summary">
        <div class="panel now">
          <div class="state" style="color:${s?.ink ?? 'var(--_ink)'}">${s?.label ?? '—'}</div>
          <div class="reads">
            <div><div class="cap">Temperature</div><div class="big">${t != null ? `${fixed(this.hass, t, 1)}°` : '—'}</div></div>
            <div><div class="cap">Humidity</div><div class="big">${h != null ? `${Math.round(h)}%` : '—'}</div></div>
            ${cl
              ? html`<div>
                  <div class="cap">Heating</div>
                  <div class="big" style="color:${heatingNow ? 'var(--_heat-ink)' : 'inherit'}">${heatingNow ? 'On' : cl.state === 'off' ? 'Off' : 'Idle'}</div>
                  ${target != null ? html`<div class="sub">Target ${fixed(this.hass, target, 1)}°</div>` : nothing}
                </div>`
              : nothing}
          </div>
        </div>
        <div class="seg spans">${SPANS.map((k) => html`<button aria-pressed=${this.hours === k} @click=${() => (this.hours = k)}>${k}h</button>`)}</div>
      </div>

      <div class="panel graphs">
        <div class="ghead">
          <h3 class="sec">Temperature</h3>
          <div class="legend">
            <span><i style="background:${HEAT}"></i>Actual</span>
            ${climate ? html`<span><i class="dash"></i>Target</span>` : nothing}
            <span><i class="band"></i>Comfortable ${tr.min}–${tr.max}°</span>
          </div>
        </div>
        ${this.chart('tchart', this.tempSize, this.temps, [tr.min, tr.max], HEAT, '°', { heat, target: this.targets })}

        ${climate
          ? html`<div class="ghead">
                <h3 class="sec">Heating</h3>
                <div class="legend"><span>${heatedMs > 0 ? `On for ${duration(heatedMs)} in the last ${this.hours} h` : `Off for the last ${this.hours} h`}</span></div>
              </div>
              <div class="chartrow"><div></div>${this.heatStrip(heat)}</div>`
          : nothing}

        <div class="ghead">
          <h3 class="sec">Humidity</h3>
          <div class="legend"><span><i class="band"></i>Comfortable ${hr.min}–${hr.max}%</span></div>
        </div>
        ${this.chart('hchart', this.humSize, this.humidity, [hr.min, hr.max], HUMID, '%')}
        <div class="chartrow"><div></div><div class="xaxis">${axis.map((a) => html`<span>${a}</span>`)}<span>Now</span></div></div>
      </div>
    `;
  }

  static styles = [
    ...PopupContent.styles,
    css`
      :host {
        display: flex;
        flex-direction: column;
        gap: 20px;
      }
      .summary {
        display: flex;
        align-items: flex-end;
        justify-content: space-between;
        gap: 16px;
        flex-wrap: wrap;
      }
      .now {
        flex: 1;
        display: flex;
        align-items: center;
        gap: 28px;
        flex-wrap: wrap;
      }
      .state {
        font-size: 34px;
        font-weight: 700;
        min-width: 150px;
      }
      .reads {
        display: flex;
        gap: 36px;
        flex-wrap: wrap;
      }
      .cap {
        font-size: 14px;
        font-weight: 700;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        color: var(--_ink2);
      }
      .big {
        font-size: 44px;
        font-weight: 600;
        letter-spacing: -0.03em;
        line-height: 1.1;
      }
      .graphs {
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      .ghead {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 12px;
        flex-wrap: wrap;
        margin-top: 8px;
      }
      .ghead .sec {
        margin: 0;
      }
      .legend {
        display: flex;
        gap: 16px;
        flex-wrap: wrap;
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
        width: 16px;
        height: 4px;
        border-radius: 2px;
      }
      .legend i.dash {
        background: repeating-linear-gradient(90deg, var(--_ink2) 0 5px, transparent 5px 9px);
      }
      .legend i.band {
        height: 12px;
        border-radius: 3px;
        background: var(--hv-comfort-pleasant, #7be0a0);
        opacity: 0.35;
      }
      .chartrow {
        display: grid;
        grid-template-columns: 44px minmax(0, 1fr);
        gap: 8px;
      }
      .yaxis {
        display: flex;
        flex-direction: column;
        justify-content: space-between;
        font-size: 14px;
        font-weight: 600;
        color: var(--_ink2);
        text-align: right;
      }
      .plot {
        position: relative;
        height: 170px;
      }
      .hchart {
        height: 120px;
      }
      .plot svg {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
      }
      .plot .empty {
        position: absolute;
        inset: 0;
        display: grid;
        place-items: center;
      }
      .heat {
        position: relative;
        height: 22px;
        border-radius: 6px;
        background: var(--_track);
        overflow: hidden;
      }
      .heat i {
        position: absolute;
        top: 0;
        bottom: 0;
        background: #ff8a3d;
      }
      .xaxis {
        display: flex;
        justify-content: space-between;
        font-size: 14px;
        font-weight: 600;
        color: var(--_ink2);
      }
      @container (max-width: 560px) {
        .panel {
          padding: 18px;
        }
        .now {
          gap: 14px;
        }
        .reads {
          gap: 20px;
        }
        .big {
          font-size: 34px;
        }
        .spans {
          width: 100%;
        }
        .spans button {
          flex: 1;
        }
      }
    `,
  ];
}

defineElement('homeview-comfort-popup', HomeViewComfortPopup);
