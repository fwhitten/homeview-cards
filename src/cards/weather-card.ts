import { css, html, nothing, type PropertyValues } from 'lit';
import { state } from 'lit/decorators.js';
import { HomeViewCard, type BaseCardConfig } from '../core/base-card';
import type { GridOptions } from '../core/types';
import { num, time } from '../core/format';
import { defineElement, registerCard } from '../core/register';
import { actionsSection, appearanceSection, choose, editorFor, layoutSection, type EditorSpec } from '../core/editor';

export interface WeatherCardConfig extends BaseCardConfig {
  entity: string;
  /** Which forecast the panel shows. Auto switches to the next hour when rain is due. */
  forecast?: 'auto' | 'next_hour' | 'hourly';
  /**
   * Optional minute-by-minute precipitation source (for example a sensor from
   * Pirate Weather or Met Office). Without it, the next-hour view uses the
   * hourly forecast.
   */
  rain_entity?: string;
  /** Attribute on `rain_entity` holding the list. Defaults to `forecast`. */
  rain_attribute?: string;
  /** Precipitation probability (%) that counts as "rain due" in auto mode. */
  rain_threshold?: number;
  show_animation?: boolean;
  /** Slot sunrise and sunset (from sun.sun) into the hourly forecast. Default true. */
  show_sun?: boolean;
}

interface Forecast {
  datetime: string;
  condition?: string;
  temperature?: number;
  templow?: number;
  precipitation?: number;
  precipitation_probability?: number;
  is_daytime?: boolean;
}

interface ForecastEvent {
  type: 'hourly' | 'daily' | 'twice_daily';
  forecast: Forecast[] | null;
}

const ICON: Record<string, string> = {
  'clear-night': 'mdi:weather-night',
  cloudy: 'mdi:weather-cloudy',
  exceptional: 'mdi:alert-circle-outline',
  fog: 'mdi:weather-fog',
  hail: 'mdi:weather-hail',
  lightning: 'mdi:weather-lightning',
  'lightning-rainy': 'mdi:weather-lightning-rainy',
  partlycloudy: 'mdi:weather-partly-cloudy',
  pouring: 'mdi:weather-pouring',
  rainy: 'mdi:weather-rainy',
  snowy: 'mdi:weather-snowy',
  'snowy-rainy': 'mdi:weather-snowy-rainy',
  sunny: 'mdi:weather-sunny',
  windy: 'mdi:weather-windy',
  'windy-variant': 'mdi:weather-windy-variant',
};

const WET = new Set(['rainy', 'pouring', 'lightning-rainy', 'snowy-rainy', 'hail']);

const sky = (condition: string, night: boolean): string => {
  if (WET.has(condition) || condition === 'lightning') return 'linear-gradient(180deg,#4b5b77 0%,#303b50 58%,#232c3b 100%)';
  if (condition === 'snowy') return 'linear-gradient(180deg,#6d7d96 0%,#4d5a70 60%,#3a4558 100%)';
  if (condition === 'fog') return 'linear-gradient(180deg,#7d8794 0%,#5c6672 100%)';
  if (night || condition === 'clear-night') return 'linear-gradient(180deg,#1c264e 0%,#36427a 60%,#786896 100%)';
  if (condition === 'cloudy') return 'linear-gradient(180deg,#6b7f9a 0%,#4f6079 100%)';
  if (condition === 'partlycloudy') return 'linear-gradient(180deg,#3f7cc0 0%,#6f9fd0 70%,#9cbad8 100%)';
  return 'linear-gradient(180deg,#2f78d0 0%,#5ea0e6 65%,#8fc1ef 100%)';
};

const EDITOR: EditorSpec = {
  schema: (c) => [
    { name: 'entity', required: true, selector: { entity: { domain: 'weather' } } },
    { name: 'name', selector: { text: {} } },
    { name: 'forecast', selector: choose([['auto', 'Auto: next hour when rain is due, otherwise hourly'], ['next_hour', 'Always the next hour'], ['hourly', 'Always hourly']], 'list') },
    ...(c.forecast !== 'hourly'
      ? [
          {
            type: 'expandable',
            name: '',
            title: 'Minute-by-minute rain (optional)',
            icon: 'mdi:weather-pouring',
            schema: [
              { name: 'rain_entity', selector: { entity: {} } },
              ...(c.rain_entity ? [{ name: 'rain_attribute', selector: { attribute: {} }, context: { filter_entity: 'rain_entity' } }] : []),
              ...((c.forecast ?? 'auto') === 'auto' ? [{ name: 'rain_threshold', selector: { number: { min: 0, max: 100, mode: 'slider', unit_of_measurement: '%' } } }] : []),
            ],
          },
        ]
      : []),
    { type: 'grid', name: '', schema: [{ name: 'show_animation', selector: { boolean: {} } }, ...(c.forecast !== 'next_hour' ? [{ name: 'show_sun', selector: { boolean: {} } }] : [])] },
    appearanceSection,
    actionsSection(),
    layoutSection,
  ],
  labels: { entity: 'Weather', forecast: 'Forecast panel', rain_entity: 'Rain source', rain_attribute: 'Attribute with the minute list', rain_threshold: 'Rain chance that counts as rain due', show_animation: 'Animated sky', show_sun: 'Sunrise and sunset in the hourly forecast' },
  helpers: { rain_entity: 'An entity with minute-by-minute precipitation, such as from Pirate Weather. Without it the next-hour view uses the hourly forecast.' },
};

/**
 * Weather (design A): an animated sky, conditions, temperature and high/low
 * top left, and a forecast panel showing the next hour or the hourly outlook.
 */
export class HomeViewWeatherCard extends HomeViewCard<WeatherCardConfig> {
  @state() private hourly: Forecast[] = [];
  @state() private daily: Forecast[] = [];
  private unsubs: Array<Promise<() => Promise<void>>> = [];
  private subscribedTo?: string;

  static getConfigElement() {
    return editorFor(EDITOR);
  }

  static getStubConfig(_hass: unknown, entities: string[], fallback: string[]) {
    return { entity: [...entities, ...fallback].find((e) => e.startsWith('weather.')) ?? '' };
  }

  protected validate(config: WeatherCardConfig): void {
    if (!config.entity) throw new Error('Set a weather entity');
  }

  protected defaults(): Partial<WeatherCardConfig> {
    return { forecast: 'auto', rain_threshold: 50, show_animation: true, show_sun: true, rain_attribute: 'forecast' };
  }

  protected watched() {
    return [this.config.entity, this.config.rain_entity, 'sun.sun'];
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.subscribedTo = undefined;
    if (this.hass && this.config) this.subscribe();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.unsubscribe();
  }

  protected updated(changed: PropertyValues): void {
    super.updated(changed);
    if (this.hass && this.config && this.subscribedTo !== this.config.entity) this.subscribe();
  }

  private unsubscribe(): void {
    this.unsubs.forEach((p) => p.then((u) => u()).catch(() => undefined));
    this.unsubs = [];
  }

  /** Forecasts come from weather/subscribe_forecast, the current HA way. */
  private subscribe(): void {
    this.unsubscribe();
    this.subscribedTo = this.config.entity;
    const sub = (type: 'hourly' | 'daily') =>
      this.hass!.connection.subscribeMessage<ForecastEvent>(
        (ev) => {
          if (type === 'hourly') this.hourly = ev.forecast ?? [];
          else this.daily = ev.forecast ?? [];
        },
        { type: 'weather/subscribe_forecast', forecast_type: type, entity_id: this.config.entity },
      );
    this.unsubs = [sub('hourly'), sub('daily')];
    this.unsubs.forEach((p) => p.catch(() => undefined));
  }

  /** Minute-level precipitation for the next 60 minutes, if a source is configured. */
  private get minutely(): number[] | undefined {
    const st = this.stateObj(this.config.rain_entity);
    const list = st?.attributes[this.config.rain_attribute ?? 'forecast'];
    if (!Array.isArray(list) || !list.length) return undefined;
    const now = Date.now();
    const out: number[] = [];
    for (const item of list) {
      const t = Date.parse(item.datetime ?? item.time ?? '');
      if (Number.isFinite(t) && (t < now - 60_000 || t > now + 60 * 60_000)) continue;
      const v = Number(item.precipitation ?? item.precipitation_intensity ?? item.value ?? 0);
      out.push(Number.isFinite(v) ? v : 0);
    }
    return out.length ? out.slice(0, 60) : undefined;
  }

  private get rainDue(): boolean {
    const m = this.minutely;
    if (m) return m.some((v) => v > 0.05);
    const threshold = this.config.rain_threshold ?? 50;
    return this.hourly.slice(0, 2).some((f) => (f.precipitation_probability ?? 0) >= threshold || (f.precipitation ?? 0) > 0.2);
  }

  private get showNextHour(): boolean {
    const f = this.config.forecast ?? 'auto';
    return f === 'next_hour' || (f === 'auto' && this.rainDue);
  }

  private rainCaption(bars: number[], minuteData: boolean): string {
    const wet = bars.map((v) => v > 0.05);
    const unit = minuteData ? 'min' : 'h';
    const toTime = (i: number) => (minuteData ? Math.max(1, Math.round((i / bars.length) * 60)) : i);
    if (!wet.some(Boolean)) return minuteData ? 'No rain in the next hour' : 'No rain in the next few hours';
    if (wet[0]) {
      const stop = wet.indexOf(false);
      return stop < 0 ? `Rain for the next ${minuteData ? 'hour' : 'few hours'}` : `Rain easing in ${toTime(stop)} ${unit}`;
    }
    return `Rain starting in ${toTime(wet.indexOf(true))} ${unit}`;
  }

  private rainPanel(compact: boolean) {
    const m = this.minutely;
    const bars = m ?? this.hourly.slice(0, 6).map((f) => f.precipitation ?? ((f.precipitation_probability ?? 0) / 100) * 0.5);
    const max = Math.max(0.5, ...bars);
    const labels = m
      ? compact
        ? ['Now', '30m', '60m']
        : ['Now', '15m', '30m', '45m', '60m']
      : this.hourly.slice(0, 6).map((f, i) => (i === 0 ? 'Now' : time(this.hass, new Date(f.datetime)).slice(0, 2)));
    return html`
      <div class="caption">
        <ha-icon icon="mdi:water" style="color:${bars.some((v) => v > 0.05) ? '#5AC8FA' : 'rgba(255,255,255,.6)'}"></ha-icon>
        ${this.rainCaption(bars, !!m)}
      </div>
      <div class="bars ${m ? 'minute' : ''}">
        ${bars.map(
          (v) =>
            html`<div style="height:${Math.max(4, (v / max) * 100)}%;opacity:${v > 0.05 ? 0.55 + Math.min(1, v / max) * 0.45 : 0.3};background:${v > 0.05 ? '#5AC8FA' : 'rgba(255,255,255,.3)'}"></div>`,
        )}
      </div>
      <div class="labels">${labels.map((l) => html`<span>${l}</span>`)}</div>
    `;
  }

  /** Sunrise and sunset from sun.sun, as Apple Weather slots them into the hourly row. */
  private sunEvents(from: number, to: number): Array<{ t: number; rise: boolean }> {
    const sun = this.hass?.states['sun.sun'];
    if (!sun) return [];
    return (
      [
        [sun.attributes.next_rising, true],
        [sun.attributes.next_setting, false],
      ] as Array<[string | undefined, boolean]>
    )
      .map(([iso, rise]) => ({ t: Date.parse(iso ?? ''), rise }))
      .filter((e) => Number.isFinite(e.t) && e.t > from && e.t < to);
  }

  private hourlyPanel(count: number) {
    const hours = this.hourly.slice(0, count);
    if (!hours.length) return html`<div class="caption">Forecast unavailable</div>`;
    type Slot = { t: number; label: string; icon: string; value: string; rain?: number; sun?: boolean; rise?: boolean };
    let slots: Slot[] = hours.map((f, i) => ({
      t: Date.parse(f.datetime),
      label: i === 0 ? 'Now' : time(this.hass, new Date(f.datetime)).slice(0, 2),
      icon: ICON[f.condition ?? ''] ?? 'mdi:weather-cloudy',
      value: f.temperature != null ? `${Math.round(f.temperature)}°` : '',
      rain: f.precipitation_probability,
    }));
    if (this.config.show_sun !== false) {
      const from = Math.max(Date.now(), slots[0].t);
      const to = slots[slots.length - 1].t;
      for (const e of this.sunEvents(from, to)) {
        slots.push({ t: e.t, label: time(this.hass, new Date(e.t)), icon: e.rise ? 'mdi:weather-sunset-up' : 'mdi:weather-sunset-down', value: e.rise ? 'Sunrise' : 'Sunset', sun: true, rise: e.rise });
      }
      // Keep the column count: an inserted sunrise or sunset pushes the last hour off.
      slots = slots.sort((a, b) => a.t - b.t).slice(0, count);
    }
    const anyRain = slots.some((s) => (s.rain ?? 0) >= 10);
    return html`<div class="hours" style="grid-template-columns:${slots.map((s) => (s.sun ? 'minmax(0,1.5fr)' : 'minmax(0,1fr)')).join(' ')}">
      ${slots.map(
        (s) => html`<div class="hour ${s.sun ? 'sunev' : ''}">
          <span class="lab">${s.label}</span>
          <ha-icon .icon=${s.icon}></ha-icon>
          <span class="t">${s.value}</span>
          ${anyRain ? html`<span class="p">${(s.rain ?? 0) >= 10 ? `${Math.round(s.rain!)}%` : ''}</span>` : nothing}
        </div>`,
      )}
    </div>`;
  }

  private animation(condition: string, night: boolean) {
    if (!this.config.show_animation) return nothing;
    const wet = WET.has(condition);
    const snow = condition === 'snowy' || condition === 'snowy-rainy';
    const clouds = wet || snow || ['cloudy', 'partlycloudy', 'fog', 'lightning'].includes(condition);
    return html`
      ${clouds
        ? html`<div class="cloud c1 anim" aria-hidden="true"></div>
            <div class="cloud c2 anim" aria-hidden="true"></div>`
        : nothing}
      ${wet ? html`<div class="rain anim" aria-hidden="true"></div>` : nothing}
      ${snow ? html`<div class="snow anim" aria-hidden="true"></div>` : nothing}
      ${(night || condition === 'clear-night') && !clouds ? html`<div class="stars anim" aria-hidden="true"></div>` : nothing}
      ${condition === 'sunny' && !night ? html`<div class="sun anim" aria-hidden="true"></div>` : nothing}
    `;
  }

  render() {
    const st = this.stateObj();
    if (!this.hass) return nothing;
    if (!st) return html`<ha-card class="tile"><div class="warn">Entity not found: ${this.config.entity}</div></ha-card>`;
    const condition = st.state;
    const night = this.hass.states['sun.sun']?.state === 'below_horizon';
    const today = this.daily[0];
    const temp = st.attributes.temperature as number | undefined;
    const label = this.hass.formatEntityState(st);
    const icon = ICON[condition] ?? 'mdi:weather-cloudy';
    const hl =
      today?.temperature != null
        ? `H:${Math.round(today.temperature)}°  L:${today.templow != null ? Math.round(today.templow) : '–'}°`
        : '';
    const name = this.config.name;
    const size = this.size;

    if (size === 's' || size === 't') {
      return html`<ha-card class="tile sky clickable" style="background:${sky(condition, night)}" tabindex="0" role="button" aria-label="${label}, ${temp}°">
        ${this.animation(condition, night)}
        <div class="in">
          <div class="top"><div class="cond sm">${label}</div><ha-icon class="wicon sm" .icon=${icon}></ha-icon></div>
          <div><div class="temp sm">${temp != null ? `${num(this.hass, temp, 0)}°` : '—'}</div><div class="hl">${hl}</div></div>
        </div>
      </ha-card>`;
    }

    const compact = size === 'w';
    return html`
      <ha-card class="tile sky clickable ${compact ? 'compact' : ''}" style="background:${sky(condition, night)}" tabindex="0" role="button" aria-label="${label}, ${temp}°, ${hl}">
        ${this.animation(condition, night)}
        <div class="body">
          <div class="now">
            <div>
              ${name ? html`<div class="place">${name}</div>` : nothing}
              <div class="cond">${label}</div>
              <div class="temp">${temp != null ? `${num(this.hass, temp, 0)}°` : '—'}</div>
              <div class="hl">${hl}</div>
            </div>
            ${compact ? nothing : html`<ha-icon class="wicon" .icon=${icon}></ha-icon>`}
          </div>
          <div class="panel">${this.showNextHour ? this.rainPanel(compact) : this.hourlyPanel(compact ? 4 : 6)}</div>
        </div>
      </ha-card>
    `;
  }

  getGridOptions(): GridOptions {
    return { columns: 12, rows: 6, min_columns: 6, min_rows: 3 };
  }

  getCardSize(): number {
    return 7;
  }

  static styles = [
    ...HomeViewCard.styles,
    css`
      .sky {
        color: #fff;
      }
      .body {
        position: relative;
        height: 100%;
        box-sizing: border-box;
        padding: 24px 26px 22px;
        display: flex;
        flex-direction: column;
        gap: 12px;
      }
      .compact .body {
        flex-direction: row;
        padding: 18px 20px 18px 22px;
        gap: 16px;
      }
      .now {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
      }
      .compact .now {
        flex: none;
      }
      .place {
        font-size: 17px;
        font-weight: 600;
        color: rgba(255, 255, 255, 0.8);
      }
      .cond {
        font-size: 24px;
        font-weight: 600;
        letter-spacing: -0.01em;
      }
      /* Proportional figures and a nudge for the glyph's side bearing keep big numbers flush with the text above. */
      .temp {
        font-size: 100px;
        font-weight: 300;
        font-variant-numeric: proportional-nums;
        letter-spacing: -0.05em;
        line-height: 0.95;
        margin: 2px 0 0 -0.055em;
      }
      .compact .cond {
        font-size: 20px;
      }
      .compact .temp {
        font-size: 72px;
        line-height: 1;
      }
      .hl {
        font-size: 19px;
        font-weight: 500;
        color: rgba(255, 255, 255, 0.8);
        margin-top: 4px;
        white-space: pre;
      }
      .wicon {
        --mdc-icon-size: 64px;
        flex: none;
      }
      .top {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
      }
      .cond.sm {
        font-size: 19px;
      }
      .wicon.sm {
        --mdc-icon-size: 36px;
      }
      .temp.sm {
        font-size: 64px;
      }
      /* Inset evenly from the card's sides and bottom, with a concentric radius. */
      .panel {
        --_inset: 12px;
        margin: auto calc(var(--_inset) - 26px) calc(var(--_inset) - 22px);
        padding: 16px 18px 14px;
        border-radius: calc(var(--_radius) - var(--_inset));
        background: rgba(8, 14, 26, 0.34);
      }
      .compact .panel {
        flex: 1;
        min-width: 0;
        margin: calc(var(--_inset) - 18px) calc(var(--_inset) - 20px) calc(var(--_inset) - 18px) 0;
        padding: 12px 14px;
        display: flex;
        flex-direction: column;
      }
      .caption {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 19px;
        font-weight: 600;
        --mdc-icon-size: 20px;
      }
      .compact .caption {
        font-size: 17px;
      }
      .bars {
        display: flex;
        align-items: flex-end;
        gap: 3px;
        height: 56px;
        margin-top: 12px;
      }
      .bars.minute {
        gap: 2px;
      }
      .compact .bars {
        flex: 1;
        height: auto;
        margin-top: 8px;
      }
      .bars div {
        flex: 1;
        border-radius: 3px;
        min-height: 3px;
      }
      .labels {
        display: flex;
        justify-content: space-between;
        margin-top: 6px;
      }
      .labels span,
      .lab {
        font-size: 15px;
        font-weight: 600;
        color: rgba(255, 255, 255, 0.74);
      }
      .hours {
        display: grid;
        text-align: center;
      }
      .compact .hours {
        flex: 1;
        align-items: end;
      }
      .hour {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 6px;
        --mdc-icon-size: 30px;
      }
      .hour .t {
        font-size: 21px;
        font-weight: 600;
        white-space: nowrap;
      }
      .sunev ha-icon {
        color: #ffd60a;
      }
      .sunev .t {
        font-size: 18px;
      }
      .hour .p {
        height: 18px;
        font-size: 15px;
        font-weight: 700;
        color: #7fd0ff;
      }
      .cloud {
        position: absolute;
        border-radius: 50%;
        background: rgba(255, 255, 255, 0.13);
        filter: blur(26px);
        animation: drift 9s ease-in-out infinite alternate;
      }
      .c1 {
        width: 260px;
        height: 120px;
        left: 40%;
        top: 20px;
      }
      .c2 {
        width: 300px;
        height: 110px;
        left: -60px;
        top: 110px;
        background: rgba(255, 255, 255, 0.08);
        animation-duration: 13s;
        animation-direction: alternate-reverse;
      }
      .rain,
      .snow {
        position: absolute;
        left: 0;
        right: 0;
        top: -180px;
        height: calc(100% + 180px);
        background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='60' height='90'%3E%3Cpath d='M8 6l-3 14M34 40l-3 14M52 68l-3 14M22 60l-2 10M46 12l-2 10' stroke='%23cfe3ff' stroke-opacity='.34' stroke-width='1.4' stroke-linecap='round'/%3E%3C/svg%3E");
        animation: fall 0.9s linear infinite;
      }
      .snow {
        background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='70' height='90'%3E%3Cg fill='%23fff' fill-opacity='.5'%3E%3Ccircle cx='10' cy='12' r='2'/%3E%3Ccircle cx='40' cy='44' r='1.6'/%3E%3Ccircle cx='60' cy='70' r='2.2'/%3E%3Ccircle cx='24' cy='66' r='1.4'/%3E%3C/g%3E%3C/svg%3E");
        animation-duration: 6s;
      }
      .stars {
        position: absolute;
        inset: 0 0 40% 0;
        background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='120'%3E%3Cg fill='%23fff'%3E%3Ccircle cx='20' cy='30' r='1.2'/%3E%3Ccircle cx='90' cy='14' r='1'/%3E%3Ccircle cx='130' cy='70' r='1.3'/%3E%3Ccircle cx='60' cy='90' r='1'/%3E%3C/g%3E%3C/svg%3E");
        animation: twinkle 4s ease-in-out infinite;
      }
      .sun {
        position: absolute;
        width: 220px;
        height: 220px;
        right: -60px;
        top: -60px;
        border-radius: 50%;
        background: radial-gradient(circle, rgba(255, 236, 170, 0.75), rgba(255, 236, 170, 0) 65%);
        animation: pulse 6s ease-in-out infinite;
      }
      @keyframes fall {
        to {
          transform: translateY(180px);
        }
      }
      @keyframes drift {
        from {
          transform: translateX(-24px);
        }
        to {
          transform: translateX(24px);
        }
      }
      @keyframes twinkle {
        50% {
          opacity: 0.4;
        }
      }
      @keyframes pulse {
        50% {
          transform: scale(1.08);
        }
      }
    `,
  ];
}

defineElement('homeview-weather-card', HomeViewWeatherCard);
registerCard({
  type: 'homeview-weather-card',
  name: 'HomeView Weather',
  description: 'Animated sky with conditions, temperature, high and low, and a next-hour or hourly forecast.',
  getEntitySuggestion: (_hass, entityId) =>
    entityId.startsWith('weather.') ? { config: { type: 'custom:homeview-weather-card', entity: entityId } } : null,
  docs: 'weather',
});
