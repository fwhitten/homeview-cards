import { css, html, nothing, svg } from 'lit';
import { state } from 'lit/decorators.js';
import { PopupContent } from './popup-base';
import {
  DEFAULT_THRESHOLDS,
  OTHER_COLOR,
  bucketCount,
  bucketize,
  energyBetween,
  energyDevices,
  fetchEnergyStats,
  fetchPowerSeries,
  niceMax,
  totalSignals,
  totalStats,
  fetchPrefs,
  firstWeekday,
  formatEnergy,
  formatPower,
  gradientStops,
  readTotal,
  startOfDay,
  startOfMonth,
  startOfWeek,
  startOfYear,
  type EnergyPrefs,
  type Threshold,
} from '../core/energy';
import { gappedPaths } from '../core/chart';
import { SizeController } from '../core/measure';
import { time } from '../core/format';
import { devicesNow } from '../cards/energy-card';
import { defineElement } from '../core/register';

type Period = 'day' | 'week' | 'month' | 'year';

interface Bucket {
  start: Date;
  end: Date;
  label: string;
}

interface Breakdown {
  buckets: Bucket[];
  series: Array<{ name: string; color: string; entity?: string; values: number[] }>;
  total: number;
  previous?: number;
}

/** Energy pop-up: power now with thresholds and distribution, totals so far, and a per-device breakdown. */
export class HomeViewEnergyPopup extends PopupContent {
  @state() private prefs?: EnergyPrefs;
  @state() private hours = 3;
  @state() private power: Array<number | null> = [];
  private chartSize = new SizeController(this, '.chart svg');
  @state() private period: Period = 'day';
  @state() private offset = 0;
  @state() private breakdown?: Breakdown;
  @state() private sofar: Array<{ label: string; value?: number; previous?: number; vs: string }> = [];
  private loaded = false;

  popupTitle(): string {
    return this.cfg.name ?? 'Energy';
  }

  popupSubtitle(): string {
    return `From your Energy dashboard · updated ${time(this.hass, new Date())}`;
  }

  private get thresholds(): Threshold[] {
    return (this.cfg.thresholds as Threshold[] | undefined)?.length ? this.cfg.thresholds : DEFAULT_THRESHOLDS;
  }

  private get signals() {
    return this.hass ? totalSignals(this.hass, this.prefs, this.cfg) : [];
  }

  protected updated(): void {
    if (this.hass && !this.loaded) {
      this.loaded = true;
      // Open on the period the card shows.
      const period = this.cfg.style === 'total' ? (this.cfg.period as Period | undefined) : undefined;
      if (period) this.period = period;
      void this.loadAll();
    }
  }

  private async loadAll(): Promise<void> {
    try {
      this.prefs = await fetchPrefs(this.hass!);
    } catch {
      this.prefs = undefined;
    }
    await Promise.all([this.loadPower(), this.loadSoFar(), this.loadBreakdown()]);
  }

  private async loadPower(): Promise<void> {
    const sigs = this.signals;
    if (!sigs.length || !this.hass) return;
    const width = (this.renderRoot.querySelector('.now') as HTMLElement | null)?.offsetWidth || 640;
    this.power = await fetchPowerSeries(this.hass, sigs, this.hours, bucketCount(this.hours, this.cfg.points_per_hour, width)).catch(() => []);
  }

  private async loadSoFar(): Promise<void> {
    if (!this.prefs || !this.hass) return;
    const stats = totalStats(this.hass, this.prefs, this.cfg);
    const now = new Date();
    const fw = firstWeekday(this.hass);
    const day = startOfDay(now);
    const week = startOfWeek(now, fw);
    const month = startOfMonth(now);
    const lastMonth = new Date(month.getFullYear(), month.getMonth() - 1, 1);
    const elapsedMonth = now.getTime() - month.getTime();
    const monthName = new Intl.DateTimeFormat(this.hass.locale.language, { month: 'long' });
    const ranges = [
      { label: 'Today', start: day, prevStart: new Date(day.getTime() - 86_400_000), vs: 'vs yesterday', span: now.getTime() - day.getTime() },
      { label: 'This week', start: week, prevStart: new Date(week.getTime() - 7 * 86_400_000), vs: 'vs last week', span: now.getTime() - week.getTime() },
      { label: monthName.format(now), start: month, prevStart: lastMonth, vs: `vs ${monthName.format(lastMonth)}`, span: elapsedMonth },
    ];
    this.sofar = await Promise.all(
      ranges.map(async (r) => {
        const value = await energyBetween(this.hass!, stats, r.start, now).catch(() => undefined);
        const previous = await energyBetween(this.hass!, stats, r.prevStart, new Date(r.prevStart.getTime() + r.span)).catch(() => undefined);
        return { label: r.label, value, previous, vs: r.vs };
      }),
    );
  }

  private buckets(): { buckets: Bucket[]; start: Date; end: Date; stat: 'hour' | 'day' | 'month'; prevStart: Date } {
    const now = new Date();
    const lang = this.hass?.locale.language;
    const fw = firstWeekday(this.hass);
    const out: Bucket[] = [];
    if (this.period === 'day') {
      const start = new Date(startOfDay(now).getTime() + this.offset * 86_400_000);
      for (let h = 0; h < 24; h++) {
        const s = new Date(start.getTime() + h * 3_600_000);
        out.push({ start: s, end: new Date(s.getTime() + 3_600_000), label: h % 3 === 0 ? String(h).padStart(2, '0') : '' });
      }
      return { buckets: out, start, end: new Date(start.getTime() + 86_400_000), stat: 'hour', prevStart: new Date(start.getTime() - 86_400_000) };
    }
    if (this.period === 'week') {
      const start = new Date(startOfWeek(now, fw).getTime() + this.offset * 7 * 86_400_000);
      const fmt = new Intl.DateTimeFormat(lang, { weekday: 'short' });
      for (let d = 0; d < 7; d++) {
        const s = new Date(start.getFullYear(), start.getMonth(), start.getDate() + d);
        out.push({ start: s, end: new Date(s.getFullYear(), s.getMonth(), s.getDate() + 1), label: fmt.format(s) });
      }
      return { buckets: out, start, end: out[6].end, stat: 'day', prevStart: new Date(start.getTime() - 7 * 86_400_000) };
    }
    if (this.period === 'month') {
      const base = startOfMonth(now);
      const start = new Date(base.getFullYear(), base.getMonth() + this.offset, 1);
      const days = new Date(start.getFullYear(), start.getMonth() + 1, 0).getDate();
      for (let d = 0; d < days; d++) {
        const s = new Date(start.getFullYear(), start.getMonth(), d + 1);
        out.push({ start: s, end: new Date(s.getFullYear(), s.getMonth(), s.getDate() + 1), label: d % 5 === 0 ? String(d + 1) : '' });
      }
      return { buckets: out, start, end: new Date(start.getFullYear(), start.getMonth() + 1, 1), stat: 'day', prevStart: new Date(start.getFullYear(), start.getMonth() - 1, 1) };
    }
    const start = new Date(startOfYear(now).getFullYear() + this.offset, 0, 1);
    const fmt = new Intl.DateTimeFormat(lang, { month: 'narrow' });
    for (let m = 0; m < 12; m++) {
      const s = new Date(start.getFullYear(), m, 1);
      out.push({ start: s, end: new Date(start.getFullYear(), m + 1, 1), label: fmt.format(s) });
    }
    return { buckets: out, start, end: new Date(start.getFullYear() + 1, 0, 1), stat: 'month', prevStart: new Date(start.getFullYear() - 1, 0, 1) };
  }

  private async loadBreakdown(): Promise<void> {
    if (!this.prefs || !this.hass) return;
    const hass = this.hass;
    const { buckets, start, end, stat, prevStart } = this.buckets();
    const now = new Date();
    const until = end > now ? now : end;
    // Hidden devices stay in the total and so land in Other; excluded ones leave the total.
    const devices = energyDevices(hass, this.prefs, this.cfg).filter((d) => !d.hidden && !d.excluded);
    const totals = totalStats(hass, this.prefs, this.cfg);
    const ids = [...devices.map((d) => d.stat), ...totals.map((t) => t.id)];
    try {
      const res = await fetchEnergyStats(hass, ids, start, until, stat);
      const totalPer = buckets.map((_, i) => Math.max(0, totals.reduce((n, t) => n + t.sign * bucketize(res[t.id], buckets)[i], 0)));
      const series = devices.map((d) => ({ name: d.name, color: d.color, entity: d.icon, values: bucketize(res[d.stat], buckets) }));
      const other = totalPer.map((t, i) => Math.max(0, t - series.reduce((n, s) => n + s.values[i], 0)));
      if (other.some((v) => v > 0.01)) series.push({ name: 'Other', color: OTHER_COLOR, entity: undefined, values: other });
      const total = totalPer.reduce((a, b) => a + b, 0);
      const span = until.getTime() - start.getTime();
      const previous = await energyBetween(hass, totals, prevStart, new Date(prevStart.getTime() + span)).catch(() => undefined);
      this.breakdown = { buckets, series, total, previous };
    } catch {
      this.breakdown = undefined;
    }
  }

  private setPeriod(p: Period): void {
    this.period = p;
    this.offset = 0;
    void this.loadBreakdown();
  }

  private shift(dir: -1 | 1): void {
    if (dir === 1 && this.offset >= 0) return;
    this.offset += dir;
    void this.loadBreakdown();
  }

  private setHours(h: number): void {
    this.hours = h;
    void this.loadPower();
  }

  private rangeLabel(): string {
    const { start, end } = this.buckets();
    const lang = this.hass?.locale.language;
    if (this.offset === 0) return { day: 'Today', week: 'This week', month: 'This month', year: 'This year' }[this.period];
    if (this.period === 'day') return new Intl.DateTimeFormat(lang, { weekday: 'short', day: 'numeric', month: 'short' }).format(start);
    if (this.period === 'week') {
      const f = new Intl.DateTimeFormat(lang, { day: 'numeric', month: 'short' });
      return `${f.format(start)} – ${f.format(new Date(end.getTime() - 1))}`;
    }
    if (this.period === 'month') return new Intl.DateTimeFormat(lang, { month: 'long', year: 'numeric' }).format(start);
    return String(start.getFullYear());
  }

  private get peak(): number | undefined {
    const vals = this.power.filter((v): v is number => v !== null);
    return vals.length ? Math.max(...vals) : undefined;
  }

  private icon(entity?: string) {
    const st = entity ? this.hass!.states[entity] : undefined;
    return st ? html`<ha-state-icon .hass=${this.hass} .stateObj=${st}></ha-state-icon>` : html`<ha-icon icon="mdi:power-plug"></ha-icon>`;
  }

  private powerChart() {
    if (this.power.length < 2) return html`<div class="empty sub">No power history yet</div>`;
    // Drawn at the chart's real width, so no stretching (and no non-scaling-stroke, which WebKit mis-colours).
    const W = this.chartSize.width || 640;
    const H = 132;
    const peak = this.peak ?? 0;
    const max = this.cfg.y_max > 0 ? this.cfg.y_max : niceMax(Math.max(peak, 100));
    const { line, area } = gappedPaths(this.power, 0, W, 2, H - 1, max, H);
    const stops = gradientStops(this.thresholds, max);
    const step = max / 4;
    return html`<div class="chart">
      <div class="yaxis">${[4, 3, 2, 1].map((k) => html`<span>${formatPower(step * k, this.hass!.locale.language).value}${k === 4 ? ` ${formatPower(step * 4).unit}` : ''}</span>`)}</div>
      ${svg`<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Power over the last ${this.hours} hours">
        <defs><linearGradient id="pt" gradientUnits="userSpaceOnUse" x1="0" y1=${H - 1} x2="0" y2="2">${stops.map((s) => svg`<stop offset=${s.offset} stop-color=${s.color}></stop>`)}</linearGradient></defs>
        <path d="M0 33 H${W} M0 66 H${W} M0 99 H${W}" stroke="var(--_track)" stroke-width="1"></path>
        <path d=${area} fill="url(#pt)" fill-opacity=".2"></path>
        <path d=${line} fill="none" stroke="url(#pt)" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"></path>
      </svg>`}
      <div class="xaxis">
        ${[3, 2, 1].map((k) => html`<span>${time(this.hass, new Date(Date.now() - ((this.hours * k) / 3) * 3_600_000))}</span>`)}<span>Now</span>
      </div>
    </div>`;
  }

  render() {
    if (!this.hass) return nothing;
    const lang = this.hass.locale.language;
    const watts = readTotal(this.hass, this.signals);
    const p = watts != null ? formatPower(watts, lang) : { value: '—', unit: '' };
    const peak = this.peak != null ? formatPower(this.peak, lang) : undefined;
    const devices = devicesNow(this.hass, this.prefs, watts, this.cfg);
    const devTotal = devices.reduce((n, d) => n + d.watts, 0) || 1;
    const b = this.breakdown;
    const bmax = b ? Math.max(0.01, ...b.buckets.map((_, i) => b.series.reduce((n, s) => n + s.values[i], 0))) * 1.08 : 1;
    const cmp = b?.previous ? ((b.total - b.previous) / b.previous) * 100 : undefined;

    return html`
      <div class="top">
        <div class="panel now">
          <div class="nowhead">
            <div>
              <h3 class="sec">Power now</h3>
              <div class="reading"><span class="big">${p.value}</span><span class="unit">${p.unit}</span></div>
              ${peak ? html`<div class="sub">Peak ${peak.value} ${peak.unit} in the last ${this.hours} h</div>` : nothing}
            </div>
            <div class="seg">${[1, 3, 6].map((h) => html`<button aria-pressed=${this.hours === h} @click=${() => this.setHours(h)}>${h}h</button>`)}</div>
          </div>
          ${this.powerChart()}
          ${devices.length
            ? html`<div class="dist">${devices.map((d) => html`<div style="flex:${d.watts / devTotal} 1 0;background:${d.color}"></div>`)}</div>
                <div class="legend">${devices.map(
                  (d) => html`<span class="dev"><span class="devi" style="background:${d.color}" role="img" aria-label=${d.name}>${this.icon(d.entity)}</span>${formatPower(d.watts, lang).value} ${formatPower(d.watts).unit}</span>`,
                )}</div>`
            : nothing}
        </div>
        <div class="panel sofar">
          <h3 class="sec">So far</h3>
          ${this.sofar.map((r) => {
            const d = r.value != null && r.previous ? ((r.value - r.previous) / r.previous) * 100 : undefined;
            return html`<div class="sf">
              <div>
                <div class="sfl">${r.label}</div>
                ${d != null ? html`<div class="sfd" style="color:${d <= 0 ? 'var(--_energy-ink)' : 'var(--hv-c-notice)'}">${d <= 0 ? '↓' : '↑'} ${Math.abs(Math.round(d))}% ${r.vs}</div>` : nothing}
              </div>
              <b>${r.value != null ? formatEnergy(r.value, lang) : '—'}</b><u>kWh</u>
            </div>`;
          })}
        </div>
      </div>

      <div class="panel usage">
        <div class="uhead">
          <div class="reading">
            <span class="mid">${b ? formatEnergy(b.total, lang) : '—'}</span><span class="unit">kWh</span>
            ${cmp != null ? html`<span class="sub cmp">${cmp <= 0 ? '↓' : '↑'} ${Math.abs(Math.round(cmp))}% vs the same point last ${this.period}</span>` : nothing}
          </div>
          <div class="controls">
            <button class="round nav gl" aria-label="Previous period" @click=${() => this.shift(-1)}><ha-icon icon="mdi:chevron-left"></ha-icon></button>
            <div class="range">${this.rangeLabel()}</div>
            <button class="round nav gl" aria-label="Next period" ?disabled=${this.offset >= 0} @click=${() => this.shift(1)}><ha-icon icon="mdi:chevron-right"></ha-icon></button>
            <div class="seg">${(['day', 'week', 'month', 'year'] as Period[]).map(
              (k) => html`<button aria-pressed=${this.period === k} @click=${() => this.setPeriod(k)}>${k[0].toUpperCase() + k.slice(1)}</button>`,
            )}</div>
          </div>
        </div>
        <div class="bars">
          ${b
            ? b.buckets.map((bk, i) => {
                const sum = b.series.reduce((n, s) => n + s.values[i], 0);
                return html`<div class="bar" title="${formatEnergy(sum, lang)} kWh">
                  <div class="stack">${sum > 0
                    ? b.series.map((s) => (s.values[i] > 0 ? html`<div style="height:${(s.values[i] / bmax) * 100}%;background:${s.color}"></div>` : nothing))
                    : html`<div style="height:1.5%;background:var(--_track)"></div>`}</div>
                  <div class="blab">${bk.label}</div>
                </div>`;
              })
            : html`<div class="empty sub">No energy statistics for this period</div>`}
        </div>
        ${b
          ? html`<div class="legend">${b.series.map(
              (s) => html`<span class="dev"><span class="devi" style="background:${s.color}">${this.icon(s.entity)}</span>${s.name}</span>`,
            )}</div>`
          : nothing}
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
      .top {
        display: grid;
        grid-template-columns: minmax(0, 1.75fr) minmax(0, 1fr);
        gap: 20px;
      }
      .now {
        display: flex;
        flex-direction: column;
        gap: 12px;
      }
      .nowhead,
      .uhead {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: 14px;
        flex-wrap: wrap;
      }
      .reading {
        display: flex;
        align-items: baseline;
        gap: 6px;
        flex-wrap: wrap;
      }
      .big {
        font-size: 60px;
        font-weight: 600;
        letter-spacing: -0.035em;
        line-height: 1;
      }
      .mid {
        font-size: 40px;
        font-weight: 600;
        letter-spacing: -0.03em;
      }
      .cmp {
        margin-left: 8px;
        font-weight: 600;
      }
      .chart {
        position: relative;
        display: grid;
        grid-template-columns: 52px minmax(0, 1fr);
        grid-template-rows: 132px auto;
        gap: 4px 6px;
      }
      .chart svg {
        width: 100%;
        height: 132px;
      }
      .yaxis {
        display: flex;
        flex-direction: column;
        justify-content: space-between;
        font-size: 15px;
        font-weight: 600;
        color: var(--_ink2);
        white-space: nowrap;
      }
      .xaxis {
        grid-column: 2;
        display: flex;
        justify-content: space-between;
        font-size: 15px;
        font-weight: 600;
        color: var(--_ink2);
      }
      /* Segments are cut apart by gaps the glass shows through; only the bar's outer ends are fully round. */
      .dist {
        display: flex;
        height: 18px;
        border-radius: 9px;
        overflow: hidden;
        gap: 5px;
      }
      .dist div {
        min-width: 4px;
        border-radius: 3px;
      }
      .legend {
        display: flex;
        flex-wrap: wrap;
        gap: 8px 22px;
      }
      .dev {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        font-size: 16px;
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
      }
      .sofar {
        display: flex;
        flex-direction: column;
      }
      .sf {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto 44px;
        column-gap: 8px;
        align-items: center;
        padding: 14px 0;
        border-bottom: 1px solid var(--_track);
      }
      .sf:last-child {
        border-bottom: 0;
      }
      .sfl {
        font-size: 19px;
        font-weight: 600;
      }
      .sfd {
        font-size: 16px;
        font-weight: 600;
      }
      .sf b {
        font-size: 44px;
        font-weight: 600;
        letter-spacing: -0.03em;
        line-height: 1;
        text-align: right;
      }
      .sf u {
        text-decoration: none;
        font-size: 18px;
        font-weight: 600;
        color: var(--_ink2);
        align-self: end;
        padding-bottom: 4px;
      }
      .usage {
        display: flex;
        flex-direction: column;
        gap: 14px;
      }
      .controls {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
      }
      .nav {
        width: 44px;
        height: 44px;
      }
      .nav[disabled] {
        opacity: 0.35;
        cursor: default;
      }
      .range {
        min-width: 150px;
        text-align: center;
        font-size: 17px;
        font-weight: 600;
      }
      .bars {
        display: flex;
        align-items: stretch;
        gap: 6px;
        height: 240px;
      }
      .bar {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .stack {
        flex: 1;
        display: flex;
        flex-direction: column-reverse;
        gap: 2px;
      }
      .stack div {
        border-radius: 4px;
      }
      .blab {
        height: 18px;
        text-align: center;
        font-size: 15px;
        font-weight: 600;
        color: var(--_ink2);
        white-space: nowrap;
      }
      .empty {
        padding: 24px 0;
        white-space: normal;
      }
      @media (max-width: 1000px) {
        .top {
          grid-template-columns: 1fr;
        }
      }
    `,
  ];
}

defineElement('homeview-energy-popup', HomeViewEnergyPopup);
