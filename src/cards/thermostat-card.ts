import { css, html, nothing, svg, type PropertyValues } from 'lit';
import { state } from 'lit/decorators.js';
import { HomeViewCard, type BaseCardConfig } from '../core/base-card';
import type { GridOptions } from '../core/types';
import { fetchHistory, resample, samples } from '../core/history';
import { areaPath, extent, mapPoints, smoothPath } from '../core/chart';
import { fixed, numericState, time } from '../core/format';
import { defineElement, registerCard } from '../core/register';
import { haptic } from '../core/events';
import { actionsSection, appearanceSection, editorFor, layoutSection, type EditorSpec } from '../core/editor';

export interface ThermostatCardConfig extends BaseCardConfig {
  entity: string;
  /** Hours of actual vs target history behind the reading. */
  hours_to_show?: number;
  /** Optional humidity sensor; defaults to the climate entity's current_humidity. */
  humidity_entity?: string;
  show_graph?: boolean;
}

const POINTS = 48;

const ACTION_STYLE: Record<string, { color: string; icon: string; verb: string }> = {
  heating: { color: '#FF8A3D', icon: 'mdi:fire', verb: 'Heating to' },
  preheating: { color: '#FF8A3D', icon: 'mdi:fire', verb: 'Preheating to' },
  cooling: { color: '#4FB3FF', icon: 'mdi:snowflake', verb: 'Cooling to' },
  drying: { color: '#E2B33A', icon: 'mdi:water-percent', verb: 'Drying to' },
  fan: { color: '#40C8C0', icon: 'mdi:fan', verb: 'Fan' },
  defrosting: { color: '#4FB3FF', icon: 'mdi:snowflake-melt', verb: 'Defrosting' },
};

const EDITOR: EditorSpec = {
  schema: (c) => [
    { name: 'entity', required: true, selector: { entity: { domain: 'climate' } } },
    { name: 'name', selector: { text: {} } },
    { name: 'show_graph', selector: { boolean: {} } },
    ...(c.show_graph !== false ? [{ name: 'hours_to_show', selector: { number: { min: 1, max: 48, mode: 'slider', unit_of_measurement: 'h' } } }] : []),
    { name: 'humidity_entity', selector: { entity: { domain: 'sensor', device_class: 'humidity' } } },
    appearanceSection,
    actionsSection(),
    layoutSection,
  ],
  labels: { entity: 'Thermostat', show_graph: 'Show the history graph', hours_to_show: 'History to show', humidity_entity: 'Humidity sensor' },
  helpers: { humidity_entity: "Optional. Defaults to the thermostat's own humidity", tap_action: 'Default: more-info' },
};

/**
 * Thermostat (design A): reading and controls on top, the last hours of actual
 * (line) and target (dashed) temperature edge to edge underneath. At 2×2 the
 * graph grows, gains a time axis and the target stepper stacks vertically.
 */
export class HomeViewThermostatCard extends HomeViewCard<ThermostatCardConfig> {
  @state() private actual: number[] = [];
  @state() private target: number[] = [];
  @state() private pendingTarget?: number;
  private commitTimer?: number;
  private refreshTimer?: number;

  static getConfigElement() {
    return editorFor(EDITOR);
  }

  static getStubConfig(_hass: unknown, entities: string[], fallback: string[]) {
    return { entity: [...entities, ...fallback].find((e) => e.startsWith('climate.')) ?? '' };
  }

  protected validate(config: ThermostatCardConfig): void {
    if (!config.entity) throw new Error('Set a climate entity');
  }

  protected defaults(): Partial<ThermostatCardConfig> {
    return { hours_to_show: 12, show_graph: true };
  }

  protected watched() {
    return [this.config.entity, this.config.humidity_entity];
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.refreshTimer = window.setInterval(() => void this.loadHistory(), 5 * 60_000);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.clearInterval(this.refreshTimer);
  }

  protected firstUpdated(): void {
    void this.loadHistory();
  }

  protected updated(changed: PropertyValues): void {
    super.updated(changed);
    if (changed.has('config') && changed.get('config')) void this.loadHistory();
  }

  private async loadHistory(): Promise<void> {
    if (!this.hass || !this.config.show_graph) return;
    const hours = this.config.hours_to_show ?? 12;
    try {
      const hist = await fetchHistory(this.hass, [this.config.entity], hours, { attributes: true, ttlMs: 4 * 60_000 });
      const rows = hist[this.config.entity];
      this.actual = resample(samples(rows, 'current_temperature'), hours, POINTS);
      this.target = resample(samples(rows, 'temperature'), hours, POINTS);
    } catch {
      this.actual = [];
      this.target = [];
    }
  }

  private get step(): number {
    const st = this.stateObj();
    return (st?.attributes.target_temp_step as number) ?? (this.hass?.config.unit_system.temperature === '°F' ? 1 : 0.5);
  }

  private nudge(dir: 1 | -1, ev: Event): void {
    ev.stopPropagation();
    const st = this.stateObj();
    if (!st || this.preview) return;
    const current = this.pendingTarget ?? (st.attributes.temperature as number | undefined);
    if (current == null) return;
    const min = (st.attributes.min_temp as number) ?? 5;
    const max = (st.attributes.max_temp as number) ?? 35;
    const next = Math.min(max, Math.max(min, Math.round((current + dir * this.step) / this.step) * this.step));
    this.pendingTarget = next;
    haptic('selection');
    window.clearTimeout(this.commitTimer);
    this.commitTimer = window.setTimeout(async () => {
      await this.call('climate', 'set_temperature', { entity_id: this.config.entity, temperature: next });
      window.setTimeout(() => (this.pendingTarget = undefined), 1500);
    }, 900);
  }

  private graph(width: number, height: number, strokeWidth: number) {
    if (!this.config.show_graph || this.actual.length < 2) return nothing;
    const all = [...this.actual, ...this.target.filter(Number.isFinite)];
    const [lo, hi] = extent(all, 0.12);
    const line = smoothPath(mapPoints(this.actual, 0, width, 8, height - 4, lo, hi));
    const tgt = this.target.length > 1 ? mapPoints(this.target, 0, width, 8, height - 4, lo, hi) : [];
    // Target is a step function, so draw it with horizontal/vertical segments.
    let tpath = '';
    tgt.forEach(([x, y], i) => (tpath += i ? ` H${x.toFixed(1)} V${y.toFixed(1)}` : `M0 ${y.toFixed(1)}`));
    const color = this.accent;
    return svg`
      <svg class="graph" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true" style="height:${height}px">
        <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color=${color} stop-opacity=".36"></stop><stop offset="1" stop-color=${color} stop-opacity="0"></stop></linearGradient></defs>
        <path d=${areaPath(line, width, height)} fill="url(#g)"></path>
        ${tpath ? svg`<path d=${tpath} fill="none" stroke="var(--_ink3)" stroke-width="1.6" stroke-dasharray="5 6" vector-effect="non-scaling-stroke"></path>` : nothing}
        <path d=${line} fill="none" stroke=${color} stroke-width=${strokeWidth} stroke-linecap="round" vector-effect="non-scaling-stroke"></path>
      </svg>`;
  }

  private get accent(): string {
    const st = this.stateObj();
    const action = st?.attributes.hvac_action as string | undefined;
    return (action && ACTION_STYLE[action]?.color) || '#9fb4d6';
  }

  render() {
    const st = this.stateObj();
    if (!this.hass) return nothing;
    if (!st) return html`<ha-card class="tile"><div class="warn">Entity not found: ${this.config.entity}</div></ha-card>`;
    const a = st.attributes;
    const action = a.hvac_action as string | undefined;
    const style = action ? ACTION_STYLE[action] : undefined;
    const off = st.state === 'off';
    const unit = '°';
    const cur = numericState(st, 'current_temperature');
    const tgt = this.pendingTarget ?? (a.temperature as number | undefined);
    const low = a.target_temp_low as number | undefined;
    const high = a.target_temp_high as number | undefined;
    const digits = this.step < 1 ? 1 : 0;
    const tgtText = tgt != null ? `${fixed(this.hass, tgt, digits)}${unit}` : low != null && high != null ? `${fixed(this.hass, low, digits)}–${fixed(this.hass, high, digits)}${unit}` : '';
    const status = off
      ? 'Off'
      : style && action !== 'fan' && action !== 'defrosting'
        ? `${style.verb} ${tgtText}`
        : style
          ? style.verb
          : `Idle · set to ${tgtText}`;
    const hum = this.config.humidity_entity ? numericState(this.stateObj(this.config.humidity_entity)) : (a.current_humidity as number | undefined);
    const name = this.config.name ?? a.friendly_name ?? this.config.entity;
    const icon = this.config.icon ?? style?.icon ?? (off ? 'mdi:power' : 'mdi:thermostat');
    const iconBg = style && !off ? style.color : 'var(--_glass-hi)';
    const canStep = !off && tgt != null;
    const heroText = cur != null ? `${fixed(this.hass, cur, 1)}${unit}` : '—';

    const minus = html`<button class="round step gl" aria-label="Lower target temperature" ?disabled=${!canStep} @click=${(e: Event) => this.nudge(-1, e)}><ha-icon icon="mdi:minus"></ha-icon></button>`;
    const plus = html`<button class="round step gl" aria-label="Raise target temperature" ?disabled=${!canStep} @click=${(e: Event) => this.nudge(1, e)}><ha-icon icon="mdi:plus"></ha-icon></button>`;

    // The target lives in the stepper, so the status only says what the system is doing.
    const short = off ? 'Off' : style ? style.verb.replace(/ to$/, '') : 'Idle';
    const stepperH = html`<div class="stepper-h gl">
      ${minus}
      <div class="tgt"><div class="tv">${tgtText || '—'}</div><div class="tl">${this.pendingTarget != null ? 'setting' : 'target'}</div></div>
      ${plus}
    </div>`;
    const header = html`
      <div class="head">
        <span class="round badge ${style && !off ? '' : 'gl'}" style="background:${iconBg};color:${style && !off ? '#fff' : 'var(--_ink2)'}"><ha-icon .icon=${icon}></ha-icon></span>
        <div class="text">
          <div class="name">${name}</div>
          <div class="sub status">
            <span style="color:${style && !off ? 'var(--_heat-ink)' : 'var(--_ink2)'}">${short}</span>
            ${hum != null ? html`<span class="hum"><ha-icon icon="mdi:water-percent"></ha-icon>${Math.round(hum)}%</span>` : nothing}
          </div>
        </div>
      </div>`;

    if (this.size === 'l') {
      const hours = this.config.hours_to_show ?? 12;
      return html`
        <ha-card class="tile clickable large" tabindex="0" role="button" aria-label="${name}, ${heroText}, ${status}">
          <div class="pad">
            ${header}
            <div class="hero-row">
              <span class="huge">${heroText}</span>
              <div class="stepper gl">
                ${plus}
                <div class="tgt"><div class="tv">${tgtText || '—'}</div><div class="tl">target</div></div>
                ${minus}
              </div>
            </div>
          </div>
          ${this.config.show_graph
            ? html`<div class="legend">
                  <span><i style="background:${this.accent}"></i>Actual</span>
                  <span><i class="dash"></i>Target</span>
                  <span class="spacer">Last ${hours} h</span>
                </div>
                <div class="axis"><span>${time(this.hass, new Date(Date.now() - hours * 3_600_000))}</span><span>${time(this.hass, new Date(Date.now() - (hours / 2) * 3_600_000))}</span><span>Now</span></div>`
            : nothing}
          ${this.graph(426, 130, 3)}
        </ha-card>`;
    }

    if (this.size === 's' || this.size === 't') {
      return html`
        <ha-card class="tile clickable small" tabindex="0" role="button" aria-label="${name}, ${heroText}, ${status}">
          ${this.graph(203, 56, 2.5)}
          <div class="pad">
            <div class="head">
              <span class="round badge sm ${style && !off ? '' : 'gl'}" style="background:${iconBg};color:${style && !off ? '#fff' : 'var(--_ink2)'}"><ha-icon .icon=${icon}></ha-icon></span>
              <div class="name">${name}</div>
            </div>
            <div class="mid">${heroText}</div>
            <div class="sub status" style="color:${style && !off ? 'var(--_heat-ink)' : 'var(--_ink2)'}">${off ? 'Off' : tgtText ? `To ${tgtText}` : status}</div>
          </div>
        </ha-card>`;
    }

    return html`
      <ha-card class="tile clickable wide" tabindex="0" role="button" aria-label="${name}, ${heroText}, ${status}">
        ${this.graph(426, 66, 2.5)}
        <div class="pad">
          <div class="row">${header}${canStep ? stepperH : nothing}</div>
          <div class="hero-line"><span class="hero">${heroText}</span></div>
        </div>
      </ha-card>`;
  }

  getGridOptions(): GridOptions {
    return { columns: 12, rows: 3, min_columns: 6, min_rows: 3 };
  }

  getCardSize(): number {
    return 4;
  }

  static styles = [
    ...HomeViewCard.styles,
    css`
      .pad {
        position: relative;
        padding: 18px 20px 0;
      }
      .graph {
        position: absolute;
        left: 0;
        right: 0;
        bottom: 0;
        width: 100%;
        pointer-events: none;
      }
      .large .graph {
        bottom: 34px;
      }
      .head {
        display: flex;
        align-items: center;
        gap: 12px;
        min-width: 0;
      }
      .text {
        min-width: 0;
      }
      .badge {
        width: 40px;
        height: 40px;
        cursor: default;
        --mdc-icon-size: 22px;
      }
      .badge.sm {
        width: 38px;
        height: 38px;
        --mdc-icon-size: 20px;
      }
      .status {
        font-weight: 600;
      }
      .row {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 12px;
      }
      .steps {
        display: flex;
        gap: 10px;
        flex: none;
      }
      .step {
        width: 52px;
        height: 52px;
      }
      .step[disabled] {
        opacity: 0.4;
        cursor: default;
      }
      .hero-line {
        margin-top: 8px;
      }
      .status {
        display: flex;
        align-items: center;
        gap: 12px;
        font-weight: 600;
      }
      .hum {
        display: inline-flex;
        align-items: center;
        gap: 2px;
        color: var(--_ink2);
        --mdc-icon-size: 18px;
      }
      .stepper-h {
        display: flex;
        align-items: center;
        gap: 2px;
        padding: 4px;
        border-radius: 999px;
        flex: none;
      }
      .stepper-h .step {
        width: 44px;
        height: 44px;
        background: none;
      }
      .stepper-h .step::after {
        display: none;
      }
      .stepper-h .tgt {
        min-width: 58px;
      }
      .stepper-h .tv {
        font-size: 22px;
      }
      .small .name {
        font-size: 19px;
      }
      .mid {
        font-size: 48px;
        font-weight: 600;
        letter-spacing: -0.035em;
        line-height: 1;
        margin-top: 12px;
      }
      .large .pad {
        padding: 22px 22px 0;
      }
      .hero-row {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-top: 6px;
      }
      .huge {
        font-size: 96px;
        font-weight: 600;
        letter-spacing: -0.045em;
        line-height: 0.9;
      }
      .stepper {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 2px;
        padding: 5px;
        border-radius: 30px;
      }
      .stepper .step {
        width: 48px;
        height: 48px;
        background: none;
      }
      .stepper .step::after {
        display: none;
      }
      .tgt {
        text-align: center;
        min-width: 54px;
      }
      .tv {
        font-size: 26px;
        font-weight: 600;
        line-height: 1;
      }
      .tl,
      .legend,
      .axis {
        font-size: 15px;
        font-weight: 600;
        color: var(--_ink3);
      }
      .legend {
        position: absolute;
        left: 22px;
        right: 22px;
        bottom: 170px;
        display: flex;
        gap: 16px;
        color: var(--_ink2);
      }
      .legend span {
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .legend i {
        width: 18px;
        height: 3px;
        border-radius: 2px;
      }
      .legend i.dash {
        height: 0;
        border-top: 2px dashed currentColor;
      }
      .legend .spacer {
        margin-left: auto;
        color: var(--_ink3);
      }
      .axis {
        position: absolute;
        left: 22px;
        right: 22px;
        bottom: 10px;
        display: flex;
        justify-content: space-between;
      }
    `,
  ];
}

defineElement('homeview-thermostat-card', HomeViewThermostatCard);
registerCard({
  type: 'homeview-thermostat-card',
  name: 'HomeView Thermostat',
  description: 'Temperature and target with a subtle history of actual vs target behind it.',
  getEntitySuggestion: (_hass, entityId) =>
    entityId.startsWith('climate.') ? { config: { type: 'custom:homeview-thermostat-card', entity: entityId } } : null,
  docs: 'thermostat',
});
