import { css, html, nothing } from 'lit';
import { state } from 'lit/decorators.js';
import { PopupContent } from './popup-base';
import { haptic } from '../core/events';
import { isUnavailable, numericState, use24h } from '../core/format';
import { defineElement } from '../core/register';
import type { HassEntity, HomeAssistant } from '../core/types';
import '../core/slider';

interface EvEntities {
  vehicle?: string;
  soc?: string;
  target?: string;
  time?: string;
}

/**
 * The charger's controls, found on the same device as the chip's entity (or
 * among Ohme's entities): by translation key first, then by entity id.
 */
const findEntities = (hass: HomeAssistant, cfg: Record<string, any>): EvEntities => {
  const reg = hass.entities ?? {};
  const device = cfg.entity ? reg[cfg.entity]?.device_id : undefined;
  const pool = Object.values(reg).filter((e) => (device ? e.device_id === device : e.platform === 'ohme'));
  const find = (domains: string[], keys: string[]) =>
    pool.find((e) => domains.includes(e.entity_id.split('.')[0]) && keys.includes(String(e.translation_key ?? '')))?.entity_id ??
    pool.find((e) => domains.includes(e.entity_id.split('.')[0]) && keys.some((k) => e.entity_id.includes(k)))?.entity_id;
  return {
    vehicle: cfg.vehicle_entity ?? find(['select', 'input_select'], ['vehicle']),
    soc: cfg.soc_entity ?? find(['number', 'input_number'], ['state_of_charge', 'soc', 'battery_level']),
    target: cfg.target_soc_entity ?? find(['number', 'input_number'], ['target_percentage', 'target_soc', 'charge_target']),
    time: cfg.target_time_entity ?? find(['time', 'input_datetime'], ['target_time', 'ready_by', 'departure']),
  };
};

/**
 * EV charger pop-up (from a chip with `popup: ev`): the car, how full it is
 * and how full to charge it, and when it needs to be ready. Built for a
 * finger: wide sliders with ± buttons, big pills and big time steppers.
 */
export class HomeViewEvPopup extends PopupContent {
  /** Values set here but not yet reported back, so the controls don't jump. */
  @state() private pending: Record<string, number | string> = {};
  private timers: Record<string, number> = {};

  private get ids(): EvEntities {
    return this.hass ? findEntities(this.hass, this.cfg) : {};
  }

  popupTitle(): string {
    return this.cfg.name && !String(this.cfg.name).includes('{state}') ? this.cfg.name : 'EV charging';
  }

  popupSubtitle(): string {
    const st = this.st(this.props?.entity);
    return st && this.hass ? `${st.attributes.friendly_name ?? ''} · ${this.hass.formatEntityState(st)}` : '';
  }

  protected willUpdate(): void {
    // Drop a pending value once the entity reports it.
    for (const [id, v] of Object.entries(this.pending)) {
      const st = this.st(id);
      if (st && (String(st.state) === String(v) || Number(st.state) === v)) {
        const { [id]: _, ...rest } = this.pending;
        this.pending = rest;
      }
    }
  }

  private num(id?: string): number | undefined {
    if (!id) return undefined;
    const p = this.pending[id];
    return typeof p === 'number' ? p : numericState(this.st(id));
  }

  private range(st?: HassEntity): { min: number; max: number; step: number } {
    return { min: st?.attributes.min ?? 0, max: st?.attributes.max ?? 100, step: st?.attributes.step ?? 1 };
  }

  private setNumber(id: string, value: number, delay = 0): void {
    this.pending = { ...this.pending, [id]: value };
    window.clearTimeout(this.timers[id]);
    // ± taps in a row send once, after the last.
    this.timers[id] = window.setTimeout(() => {
      void this.hass?.callService(id.split('.')[0], 'set_value', { entity_id: id, value });
    }, delay);
  }

  private nudge(id: string, dir: 1 | -1): void {
    const st = this.st(id);
    const { min, max, step } = this.range(st);
    const cur = this.num(id) ?? min;
    haptic('selection');
    this.setNumber(id, Math.min(max, Math.max(min, Math.round((cur + dir * step) / step) * step)), 600);
  }

  // ---------------------------------------------------------------- time

  private minutes(id?: string): number | undefined {
    if (!id) return undefined;
    const p = this.pending[id];
    const raw = typeof p === 'string' ? p : this.st(id)?.state;
    const m = /^(\d{1,2}):(\d{2})/.exec(String(raw ?? ''));
    return m ? Number(m[1]) * 60 + Number(m[2]) : undefined;
  }

  private setTime(id: string, mins: number): void {
    const m = ((mins % 1440) + 1440) % 1440;
    const value = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:00`;
    haptic('selection');
    this.pending = { ...this.pending, [id]: value };
    window.clearTimeout(this.timers[id]);
    this.timers[id] = window.setTimeout(() => {
      const domain = id.split('.')[0];
      if (domain === 'input_datetime') void this.hass?.callService('input_datetime', 'set_datetime', { entity_id: id, time: value });
      else void this.hass?.callService('time', 'set_value', { entity_id: id, time: value });
    }, 700);
  }

  private clockText(mins: number): { main: string; ampm?: string } {
    const h = Math.floor(mins / 60);
    const m = String(mins % 60).padStart(2, '0');
    if (use24h(this.hass)) return { main: `${String(h).padStart(2, '0')}:${m}` };
    return { main: `${h % 12 || 12}:${m}`, ampm: h < 12 ? 'AM' : 'PM' };
  }

  // ---------------------------------------------------------------- parts

  private vehicle(id: string) {
    const st = this.st(id);
    if (!st) return nothing;
    const options = (st.attributes.options as string[] | undefined) ?? [];
    const current = (this.pending[id] as string | undefined) ?? st.state;
    const pick = (o: string) => () => {
      if (o === current) return;
      haptic('selection');
      this.pending = { ...this.pending, [id]: o };
      void this.hass!.callService(id.split('.')[0], 'select_option', { entity_id: id, option: o });
    };
    return html`<div class="panel">
      <h3 class="sec">Vehicle</h3>
      ${isUnavailable(st)
        ? html`<div class="sub">Unavailable</div>`
        : html`<div class="pills" role="radiogroup" aria-label="Vehicle">${options.map(
            (o) => html`<button role="radio" aria-checked=${o === current} @click=${pick(o)}><ha-icon icon="mdi:car-electric-outline"></ha-icon><span>${o}</span></button>`,
          )}</div>`}
    </div>`;
  }

  private numberRow(id: string, label: string, color: string) {
    const st = this.st(id);
    const v = this.num(id);
    const { min, max, step } = this.range(st);
    const off = !st || isUnavailable(st);
    return html`<div class="nrow">
      <button class="round gl pm" aria-label="Lower ${label}" ?disabled=${off} @click=${() => this.nudge(id, -1)}><ha-icon icon="mdi:minus"></ha-icon></button>
      <homeview-slider
        .mode=${this.mode}
        .label=${label}
        .value=${v ?? min}
        .min=${min}
        .max=${max}
        .step=${step}
        .color=${color}
        .display=${v != null ? `${Math.round(v)}%` : '—'}
        ?disabled=${off}
        @value-change=${(e: CustomEvent<number>) => this.setNumber(id, e.detail)}
      ></homeview-slider>
      <button class="round gl pm" aria-label="Raise ${label}" ?disabled=${off} @click=${() => this.nudge(id, 1)}><ha-icon icon="mdi:plus"></ha-icon></button>
    </div>`;
  }

  private battery(ids: EvEntities) {
    const soc = this.num(ids.soc);
    const target = this.num(ids.target);
    if (!ids.soc && !ids.target) return nothing;
    const toAdd = soc != null && target != null ? Math.max(0, target - soc) : undefined;
    return html`<div class="panel">
      <div class="bhead">
        <h3 class="sec">Battery</h3>
        ${toAdd != null ? html`<div class="sub">${toAdd > 0 ? `${Math.round(toAdd)}% to add` : 'At or above target'}</div>` : nothing}
      </div>
      <div class="battery" role="img" aria-label="Charged to ${soc != null ? Math.round(soc) : '?'}%${target != null ? `, charging to ${Math.round(target)}%` : ''}">
        <div class="cell">
          <div class="charge" style="width:${soc ?? 0}%"></div>
          ${target != null ? html`<div class="goal" style="width:${target}%"></div><div class="mark" style="left:${target}%"></div>` : nothing}
          <div class="now">${soc != null ? html`${Math.round(soc)}<span>%</span>` : '—'}</div>
        </div>
        <div class="nub"></div>
      </div>
      <div class="rows">
        ${ids.soc ? this.numberRow(ids.soc, 'Charged now', '#4cd07d') : nothing}
        ${ids.target ? this.numberRow(ids.target, 'Charge to', 'rgba(76,208,125,.55)') : nothing}
      </div>
    </div>`;
  }

  private readyBy(id: string) {
    const st = this.st(id);
    const mins = this.minutes(id);
    const off = !st || isUnavailable(st) || mins == null;
    const t = mins != null ? this.clockText(mins) : undefined;
    const quick = [6 * 60, 7 * 60, 8 * 60, 9 * 60];
    const stepper = (label: string, delta: number, icon: string) =>
      html`<button class="round gl big" aria-label=${label} ?disabled=${off} @click=${() => mins != null && this.setTime(id, mins + delta)}><ha-icon .icon=${icon}></ha-icon></button>`;
    return html`<div class="panel">
      <h3 class="sec">Ready by</h3>
      <div class="clock">
        <div class="col">${stepper('One hour later', 60, 'mdi:chevron-up')}${stepper('One hour earlier', -60, 'mdi:chevron-down')}</div>
        <div class="time" aria-live="polite">${t ? html`${t.main}${t.ampm ? html`<span class="ampm">${t.ampm}</span>` : nothing}` : '—'}</div>
        <div class="col">${stepper('15 minutes later', 15, 'mdi:chevron-up')}${stepper('15 minutes earlier', -15, 'mdi:chevron-down')}</div>
      </div>
      <div class="quick">${quick.map(
        (q) => html`<button class="gl" aria-pressed=${mins === q} ?disabled=${off} @click=${() => this.setTime(id, q)}>${this.clockText(q).main}${this.clockText(q).ampm ? ` ${this.clockText(q).ampm}` : ''}</button>`,
      )}</div>
    </div>`;
  }

  render() {
    if (!this.hass) return nothing;
    const ids = this.ids;
    if (!ids.vehicle && !ids.soc && !ids.target && !ids.time) {
      return html`<div class="panel sub wrapnote">
        No charger controls found. Give the chip an entity from the charger's device, or set vehicle_entity, soc_entity, target_soc_entity and target_time_entity on the chip.
      </div>`;
    }
    return html`
      ${this.battery(ids)}
      <div class="pair">
        ${ids.time ? this.readyBy(ids.time) : nothing}
        ${ids.vehicle ? this.vehicle(ids.vehicle) : nothing}
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
      .wrapnote {
        white-space: normal;
        line-height: 1.4;
      }
      .bhead {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        gap: 12px;
      }
      .bhead .sub {
        font-weight: 600;
      }
      /* A battery drawn as the charge: solid to the current level, lighter up to the target, a line at the target. */
      .battery {
        display: flex;
        align-items: center;
        gap: 6px;
        margin-bottom: 18px;
      }
      .cell {
        position: relative;
        flex: 1;
        height: 84px;
        border-radius: 22px;
        overflow: hidden;
        background: var(--_glass-hi);
      }
      .charge,
      .goal {
        position: absolute;
        left: 0;
        top: 0;
        bottom: 0;
        transition: width 0.3s ease;
      }
      .charge {
        z-index: 1;
        background: #4cd07d;
      }
      .goal {
        background: repeating-linear-gradient(135deg, rgba(76, 208, 125, 0.32) 0 10px, rgba(76, 208, 125, 0.18) 10px 20px);
      }
      .mark {
        position: absolute;
        z-index: 2;
        top: 10px;
        bottom: 10px;
        width: 3px;
        margin-left: -1.5px;
        border-radius: 2px;
        background: var(--_ink);
      }
      .now {
        position: absolute;
        z-index: 3;
        left: 22px;
        top: 50%;
        transform: translateY(-50%);
        font-size: 44px;
        font-weight: 700;
        letter-spacing: -0.03em;
        color: #fff;
        text-shadow: 0 1px 8px rgba(0, 0, 0, 0.35);
      }
      .now span {
        font-size: 22px;
        margin-left: 2px;
      }
      .nub {
        width: 10px;
        height: 30px;
        border-radius: 0 6px 6px 0;
        background: var(--_glass-hi);
      }
      .rows {
        display: flex;
        flex-direction: column;
        gap: 12px;
      }
      .nrow {
        display: grid;
        grid-template-columns: 60px minmax(0, 1fr) 60px;
        align-items: center;
        gap: 12px;
      }
      .pm {
        width: 60px;
        height: 60px;
        --mdc-icon-size: 26px;
      }
      .pair {
        display: grid;
        grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
        gap: 20px;
      }
      .pair > :only-child {
        grid-column: 1 / -1;
      }
      .clock {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 18px;
      }
      .col {
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      .big {
        width: 60px;
        height: 60px;
        --mdc-icon-size: 30px;
      }
      .time {
        min-width: 210px;
        text-align: center;
        font-size: 76px;
        font-weight: 600;
        letter-spacing: -0.03em;
        font-variant-numeric: tabular-nums;
      }
      .ampm {
        font-size: 24px;
        margin-left: 6px;
        color: var(--_ink2);
      }
      .quick {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 10px;
        margin-top: 18px;
      }
      .quick button,
      .pills button {
        position: relative;
        min-height: 54px;
        border: 0;
        border-radius: 18px;
        color: var(--_ink);
        font: inherit;
        font-size: 18px;
        font-weight: 600;
        cursor: pointer;
      }
      .quick button[aria-pressed='true'],
      .pills button[aria-checked='true'] {
        background: var(--_ink);
        color: var(--_inv);
      }
      .pills {
        display: flex;
        flex-direction: column;
        gap: 10px;
        max-height: 300px;
        overflow: auto;
      }
      .pills button {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 0 18px;
        text-align: left;
        background: var(--_glass-hi);
        --mdc-icon-size: 24px;
      }
      .pills button span {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      button[disabled] {
        opacity: 0.4;
        cursor: default;
      }
      @container (max-width: 760px) {
        .pair {
          grid-template-columns: minmax(0, 1fr);
        }
      }
      @container (max-width: 480px) {
        .panel {
          padding: 18px;
        }
        .nrow {
          grid-template-columns: 52px minmax(0, 1fr) 52px;
          gap: 8px;
        }
        .pm,
        .big {
          width: 52px;
          height: 52px;
        }
        .time {
          min-width: 0;
          font-size: 56px;
        }
        .quick {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
      }
    `,
  ];
}

defineElement('homeview-ev-popup', HomeViewEvPopup);
