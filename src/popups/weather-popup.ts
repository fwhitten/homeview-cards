import { css, html, nothing } from 'lit';
import { state } from 'lit/decorators.js';
import { PopupContent } from './popup-base';
import { ICON, type Forecast, type ForecastEvent } from '../cards/weather-card';
import { num, time, weekday } from '../core/format';
import { defineElement } from '../core/register';

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

/** Colours along the temperature scale (°C), as Apple Weather tints its ranges: cold blue to hot red. */
const TEMP_STOPS: Array<[number, [number, number, number]]> = [
  [-10, [125, 107, 255]],
  [0, [90, 200, 250]],
  [8, [110, 224, 176]],
  [14, [167, 227, 107]],
  [20, [255, 210, 90]],
  [26, [255, 154, 77]],
  [32, [255, 90, 95]],
];

const tempColor = (c: number): string => {
  const first = TEMP_STOPS[0];
  const last = TEMP_STOPS[TEMP_STOPS.length - 1];
  if (c <= first[0]) return `rgb(${first[1].join(',')})`;
  if (c >= last[0]) return `rgb(${last[1].join(',')})`;
  const i = TEMP_STOPS.findIndex(([t]) => t > c);
  const [t0, a] = TEMP_STOPS[i - 1];
  const [t1, b] = TEMP_STOPS[i];
  const f = (c - t0) / (t1 - t0);
  return `rgb(${a.map((v, k) => Math.round(v + (b[k] - v) * f)).join(',')})`;
};

/**
 * The gradient for a day's range from `low` to `high` (°C): the scale's own
 * colours between those temperatures, so a cold day is blue and a warm one
 * runs into orange.
 */
const rangeGradient = (low: number, high: number): string => {
  if (high - low < 0.5) return tempColor(low);
  const at = (c: number) => `${tempColor(c)} ${(((c - low) / (high - low)) * 100).toFixed(1)}%`;
  const inner = TEMP_STOPS.map(([t]) => t).filter((t) => t > low && t < high);
  return `linear-gradient(90deg, ${[low, ...inner, high].map(at).join(', ')})`;
};

/** Rain for a forecast entry: the chance if given (from 10%), else the amount if any falls. */
const rainText = (f: Forecast, unit = 'mm'): string => {
  if (f.precipitation_probability != null) return f.precipitation_probability >= 10 ? `${Math.round(f.precipitation_probability)}%` : '';
  return f.precipitation != null && f.precipitation >= 0.1 ? `${f.precipitation < 10 ? f.precipitation.toFixed(1) : Math.round(f.precipitation)} ${unit}` : '';
};

/** A wind bearing in degrees (or already a compass point) as a compass point. */
const compass = (bearing: unknown): string | undefined => {
  if (typeof bearing === 'string' && Number.isNaN(Number(bearing))) return bearing;
  const deg = Number(bearing);
  return Number.isFinite(deg) ? COMPASS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16] : undefined;
};

/**
 * Weather pop-up: now (with feels-like, humidity, wind and the rest the
 * entity reports), the hourly forecast as a strip you swipe through, with
 * sunrise and sunset slotted in, and the daily forecast with each day's
 * range on a shared scale.
 */
export class HomeViewWeatherPopup extends PopupContent {
  @state() private hourly: Forecast[] = [];
  @state() private daily: Forecast[] = [];
  private unsubs: Array<Promise<() => Promise<void>>> = [];
  private subscribedTo?: string;

  private get entity(): string | undefined {
    return this.props?.entity ?? this.cfg.entity;
  }

  popupTitle(): string {
    const st = this.st(this.entity);
    return this.cfg.name ?? st?.attributes.friendly_name ?? 'Weather';
  }

  popupSubtitle(): string {
    const st = this.st(this.entity);
    return st && this.hass ? `${this.hass.formatEntityState(st)} · updated ${time(this.hass, new Date())}` : '';
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.unsubs.forEach((p) => p.then((u) => u()).catch(() => undefined));
    this.unsubs = [];
    this.subscribedTo = undefined;
  }

  protected updated(): void {
    const entity = this.entity;
    if (!this.hass || !entity || this.subscribedTo === entity) return;
    this.subscribedTo = entity;
    const sub = (type: 'hourly' | 'daily') =>
      this.hass!.connection.subscribeMessage<ForecastEvent>(
        (ev) => {
          if (type === 'hourly') this.hourly = ev.forecast ?? [];
          else this.daily = ev.forecast ?? [];
        },
        { type: 'weather/subscribe_forecast', forecast_type: type, entity_id: entity },
      );
    this.unsubs = [sub('hourly'), sub('daily')];
    this.unsubs.forEach((p) => p.catch(() => undefined));
  }

  private details() {
    const st = this.st(this.entity)!;
    const a = st.attributes;
    const hass = this.hass!;
    const tiles: Array<{ icon: string; label: string; value: unknown; note?: string }> = [];
    const unit = (u: unknown) => (u ? html`<span class="u">${u}</span>` : nothing);
    if (a.humidity != null) {
      tiles.push({ icon: 'mdi:water-percent', label: 'Humidity', value: html`${Math.round(a.humidity)}${unit('%')}`, note: a.dew_point != null ? `Dew point ${num(hass, a.dew_point, 0)}°` : undefined });
    }
    if (a.wind_speed != null) {
      const dir = compass(a.wind_bearing);
      const deg = Number(a.wind_bearing);
      tiles.push({
        icon: 'mdi:weather-windy',
        label: 'Wind',
        value: html`${num(hass, a.wind_speed, 0)}${unit(a.wind_speed_unit)}${Number.isFinite(deg)
          ? html`<ha-icon class="arrow" icon="mdi:navigation" style="transform:rotate(${deg + 180}deg)" aria-hidden="true"></ha-icon>`
          : nothing}`,
        note: [dir ? `From the ${dir}` : '', a.wind_gust_speed != null ? `gusts ${num(hass, a.wind_gust_speed, 0)} ${a.wind_speed_unit ?? ''}` : ''].filter(Boolean).join(', '),
      });
    }
    if (a.apparent_temperature != null) tiles.push({ icon: 'mdi:thermometer', label: 'Feels like', value: `${num(hass, a.apparent_temperature, 0)}°` });
    const today = this.daily[0];
    const rain = today?.precipitation_probability ?? this.hourly[0]?.precipitation_probability;
    if (rain != null) tiles.push({ icon: 'mdi:umbrella-outline', label: 'Rain', value: html`${Math.round(rain)}${unit('%')}`, note: today?.precipitation ? `${num(hass, today.precipitation, 1)} ${a.precipitation_unit ?? 'mm'} today` : 'Chance today' });
    if (a.uv_index != null) tiles.push({ icon: 'mdi:sun-wireless-outline', label: 'UV index', value: num(hass, a.uv_index, 0), note: a.uv_index >= 6 ? 'High' : a.uv_index >= 3 ? 'Moderate' : 'Low' });
    if (a.pressure != null) tiles.push({ icon: 'mdi:gauge', label: 'Pressure', value: html`${num(hass, a.pressure, 0)}${unit(a.pressure_unit)}` });
    if (a.visibility != null) tiles.push({ icon: 'mdi:eye-outline', label: 'Visibility', value: html`${num(hass, a.visibility, 0)}${unit(a.visibility_unit)}` });
    if (a.cloud_coverage != null) tiles.push({ icon: 'mdi:cloud-outline', label: 'Cloud cover', value: html`${Math.round(a.cloud_coverage)}${unit('%')}` });
    return html`<div class="tiles">${tiles.map(
      (t) => html`<div class="panel tile">
        <div class="tl"><ha-icon .icon=${t.icon}></ha-icon>${t.label}</div>
        <div class="tv">${t.value}</div>
        ${t.note ? html`<div class="tn">${t.note}</div>` : nothing}
      </div>`,
    )}</div>`;
  }

  /** Sunrise and sunset from sun.sun between two moments. */
  private sunEvents(from: number, to: number): Array<{ t: number; rise: boolean }> {
    const sun = this.hass?.states['sun.sun'];
    if (!sun) return [];
    const out: Array<{ t: number; rise: boolean }> = [];
    for (const [iso, rise] of [
      [sun.attributes.next_rising, true],
      [sun.attributes.next_setting, false],
    ] as Array<[string | undefined, boolean]>) {
      const t = Date.parse(iso ?? '');
      // The same event a day later too, so a 24-hour strip shows both.
      for (const k of [0, 1]) if (Number.isFinite(t) && t + k * 86_400_000 > from && t + k * 86_400_000 < to) out.push({ t: t + k * 86_400_000, rise });
    }
    return out;
  }

  private hourlyStrip() {
    const hours = this.hourly.slice(0, 48);
    if (!hours.length) return html`<div class="empty sub">Hourly forecast unavailable</div>`;
    type Slot = { t: number; top: string; icon: string; value: string; rain?: string; sun?: boolean };
    const unit = this.st(this.entity)?.attributes.precipitation_unit ?? 'mm';
    const slots: Slot[] = hours.map((f, i) => ({
      t: Date.parse(f.datetime),
      top: i === 0 ? 'Now' : time(this.hass, new Date(f.datetime)),
      icon: ICON[f.condition ?? ''] ?? 'mdi:weather-cloudy',
      value: f.temperature != null ? `${Math.round(f.temperature)}°` : '—',
      rain: rainText(f, unit),
    }));
    const from = slots[0].t;
    const to = slots[slots.length - 1].t;
    for (const e of this.sunEvents(from, to)) {
      slots.push({ t: e.t, top: time(this.hass, new Date(e.t)), icon: e.rise ? 'mdi:weather-sunset-up' : 'mdi:weather-sunset-down', value: e.rise ? 'Sunrise' : 'Sunset', sun: true });
    }
    slots.sort((a, b) => a.t - b.t);
    let day = new Date(from).getDate();
    // The rain line only when some hour has a real chance of it, so dry days don't leave a gap.
    const wet = slots.some((s) => !s.sun && s.rain);
    return html`<div class="strip" role="list">${slots.map((s) => {
      const d = new Date(s.t);
      const newDay = d.getDate() !== day && !s.sun;
      if (newDay) day = d.getDate();
      return html`<div class="slot ${s.sun ? 'sunslot' : ''} ${newDay ? 'newday' : ''}" role="listitem">
        <div class="st">${newDay ? weekday(this.hass, d) : s.top}</div>
        <ha-icon .icon=${s.icon} class=${s.sun ? 'sunicon' : ''}></ha-icon>
        <div class="sv">${s.value}</div>
        ${wet ? html`<div class="sr">${!s.sun ? s.rain : ''}</div>` : nothing}
      </div>`;
    })}</div>`;
  }

  private dailyList() {
    const days = this.daily.slice(0, 10);
    if (!days.length) return html`<div class="empty sub">Daily forecast unavailable</div>`;
    const lows = days.map((d) => d.templow ?? d.temperature ?? 0);
    const highs = days.map((d) => d.temperature ?? 0);
    const lo = Math.min(...lows);
    const hi = Math.max(...highs);
    const span = Math.max(1, hi - lo);
    const now = numberOr(this.st(this.entity)?.attributes.temperature);
    const fahrenheit = String(this.st(this.entity)?.attributes.temperature_unit ?? this.hass?.config.unit_system.temperature ?? '').includes('F');
    const toC = (t: number) => (fahrenheit ? ((t - 32) * 5) / 9 : t);
    const unit = this.st(this.entity)?.attributes.precipitation_unit ?? 'mm';
    return html`<div class="days">${days.map((d, i) => {
      const low = d.templow ?? d.temperature ?? 0;
      const high = d.temperature ?? low;
      const left = ((low - lo) / span) * 100;
      const width = Math.max(4, ((high - low) / span) * 100);
      const dot = i === 0 && now != null ? ((Math.min(hi, Math.max(lo, now)) - lo) / span) * 100 : undefined;
      return html`<div class="day">
        <div class="dn">${i === 0 ? 'Today' : weekday(this.hass, new Date(d.datetime))}</div>
        <div class="di">
          <ha-icon .icon=${ICON[d.condition ?? ''] ?? 'mdi:weather-cloudy'}></ha-icon>
          ${rainText(d, unit) ? html`<span class="rain"><ha-icon icon="mdi:water"></ha-icon>${rainText(d, unit)}</span>` : nothing}
        </div>
        <div class="dlo">${d.templow != null ? `${Math.round(low)}°` : ''}</div>
        <div class="range"><i style="left:${left}%;width:${width}%;background:${rangeGradient(toC(low), toC(high))}"></i>${dot != null ? html`<b style="left:${dot}%"></b>` : nothing}</div>
        <div class="dhi">${Math.round(high)}°</div>
      </div>`;
    })}</div>`;
  }

  render() {
    const st = this.st(this.entity);
    if (!this.hass || !st) return html`<div class="empty sub">Weather unavailable</div>`;
    const today = this.daily[0];
    return html`
      <div class="now">
        <div class="panel now-hero">
          <ha-icon class="heroicon" .icon=${ICON[st.state] ?? 'mdi:weather-cloudy'}></ha-icon>
          <div>
            <div class="temp">${st.attributes.temperature != null ? `${Math.round(st.attributes.temperature)}°` : '—'}</div>
            <div class="cond">${this.hass.formatEntityState(st)}</div>
            ${today ? html`<div class="hl">H:${Math.round(today.temperature ?? 0)}°${today.templow != null ? ` L:${Math.round(today.templow)}°` : ''}</div>` : nothing}
          </div>
        </div>
        ${this.details()}
      </div>
      <div class="panel">
        <h3 class="sec">Hourly</h3>
        ${this.hourlyStrip()}
      </div>
      <div class="panel">
        <h3 class="sec">${Math.min(10, this.daily.length) || ''}-day forecast</h3>
        ${this.dailyList()}
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
      .now {
        display: grid;
        grid-template-columns: minmax(260px, 1fr) minmax(0, 2fr);
        gap: 20px;
      }
      .now-hero {
        display: flex;
        flex-direction: column;
        justify-content: center;
        gap: 8px;
      }
      .heroicon {
        --mdc-icon-size: 64px;
      }
      .temp {
        font-size: 96px;
        font-weight: 600;
        letter-spacing: -0.045em;
        line-height: 0.95;
      }
      .cond {
        font-size: 24px;
        font-weight: 600;
      }
      .hl {
        font-size: 19px;
        font-weight: 600;
        color: var(--_ink2);
        margin-top: 2px;
      }
      .tiles {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(170px, 1fr));
        gap: 12px;
      }
      .tile {
        padding: 16px 18px;
        border-radius: 24px;
      }
      .tl {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 14px;
        font-weight: 700;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        color: var(--_ink2);
        --mdc-icon-size: 18px;
      }
      .tv {
        display: flex;
        align-items: baseline;
        gap: 2px;
        margin-top: 8px;
        font-size: 36px;
        font-weight: 600;
        letter-spacing: -0.02em;
        line-height: 1;
      }
      .u {
        font-size: 17px;
        color: var(--_ink2);
        margin-left: 3px;
      }
      .arrow {
        align-self: center;
        margin-left: 8px;
        --mdc-icon-size: 24px;
        color: var(--_ink2);
      }
      .tn {
        margin-top: 6px;
        font-size: 15px;
        font-weight: 600;
        color: var(--_ink2);
      }
      /*
       * Swipe sideways through the next 48 hours. Slots share the width evenly
       * (twelve across a full sheet, fewer on narrower ones), so the first
       * screenful always fills the panel.
       */
      .strip {
        --_n: 12;
        display: grid;
        grid-auto-flow: column;
        grid-auto-columns: calc((100% - (var(--_n) - 1) * 6px) / var(--_n));
        align-items: start;
        gap: 6px;
        overflow-x: auto;
        overscroll-behavior-x: contain;
        scroll-snap-type: x mandatory;
        -webkit-overflow-scrolling: touch;
        scrollbar-width: none;
      }
      .strip::-webkit-scrollbar {
        display: none;
      }
      .slot {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 12px;
        padding: 14px 0;
        border-radius: 20px;
        scroll-snap-align: start;
        --mdc-icon-size: 30px;
      }
      .slot:first-child {
        background: var(--_glass-hi);
      }
      .sunicon {
        color: #ffc861;
      }
      .newday .st {
        color: var(--_ink);
      }
      .st {
        font-size: 16px;
        font-weight: 600;
        color: var(--_ink2);
        white-space: nowrap;
      }
      .sv {
        font-size: 22px;
        font-weight: 600;
        white-space: nowrap;
      }
      .sunslot .sv {
        font-size: 15px;
        line-height: 26px;
        color: var(--_ink2);
      }
      .sr {
        height: 18px;
        font-size: 15px;
        font-weight: 700;
        color: #5ac8fa;
      }
      .days {
        display: flex;
        flex-direction: column;
      }
      .day {
        display: grid;
        grid-template-columns: 110px 150px 48px minmax(80px, 1fr) 48px;
        align-items: center;
        gap: 14px;
        min-height: 56px;
        border-bottom: 1px solid var(--_track);
        font-size: 20px;
        font-weight: 600;
      }
      .day:last-child {
        border-bottom: 0;
      }
      .di {
        display: flex;
        align-items: center;
        gap: 6px;
        --mdc-icon-size: 28px;
      }
      /* Rain beside the icon: a drop and the chance (or amount). */
      .rain {
        display: inline-flex;
        align-items: center;
        gap: 2px;
        font-size: 15px;
        font-weight: 700;
        color: #5ac8fa;
        white-space: nowrap;
        --mdc-icon-size: 16px;
      }
      .dlo {
        text-align: right;
        color: var(--_ink2);
      }
      .range {
        position: relative;
        height: 8px;
        border-radius: 4px;
        background: var(--_track);
      }
      .range i {
        position: absolute;
        top: 0;
        bottom: 0;
        border-radius: 4px;
      }
      .range b {
        position: absolute;
        top: 50%;
        width: 12px;
        height: 12px;
        margin: -6px 0 0 -6px;
        border-radius: 50%;
        background: #fff;
        box-shadow: 0 0 0 3px rgba(0, 0, 0, 0.35);
      }
      .empty {
        padding: 16px 0;
      }
      @container (max-width: 820px) {
        .now {
          grid-template-columns: minmax(0, 1fr);
        }
        .now-hero {
          flex-direction: row;
          align-items: center;
          justify-content: flex-start;
          gap: 18px;
        }
        .temp {
          font-size: 72px;
        }
        .strip {
          --_n: 8;
        }
      }
      @container (max-width: 520px) {
        .panel {
          padding: 18px;
        }
        .strip {
          --_n: 5;
        }
        .tiles {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
        .tv {
          font-size: 30px;
        }
        .day {
          grid-template-columns: 52px 96px 32px minmax(40px, 1fr) 36px;
          gap: 8px;
          font-size: 18px;
        }
      }
    `,
  ];
}

const numberOr = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

defineElement('homeview-weather-popup', HomeViewWeatherPopup);
