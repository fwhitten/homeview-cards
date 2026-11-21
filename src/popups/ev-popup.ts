import { css, html, nothing } from 'lit';
import { state } from 'lit/decorators.js';
import { PopupContent } from './popup-base';
import { haptic } from '../core/events';
import { isUnavailable, numericState, use24h } from '../core/format';
import { defineElement } from '../core/register';
import type { HassEntity, HomeAssistant } from '../core/types';

interface EvEntities {
  vehicle?: string;
  /** The charge the car started at (Ohme's "State of charge" number). */
  soc?: string;
  target?: string;
  /** The car's actual battery level now, if something reports it. */
  current?: string;
  time?: string;
  slots?: string;
  status?: string;
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
    current: cfg.current_soc_entity,
    slots: cfg.slots_entity ?? find(['sensor'], ['slot_list', 'charge_slots', 'slots']),
    status: cfg.status_entity ?? find(['sensor'], ['status']) ?? cfg.entity,
  };
};

/** "22:00-23:01, 23:25-00:00" as minutes past midnight. */
const parseSlots = (text: string): Array<{ from: number; to: number }> => {
  const out: Array<{ from: number; to: number }> = [];
  for (const m of text.matchAll(/(\d{1,2}):(\d{2})\s*[-–]\s*(\d{1,2}):(\d{2})/g)) {
    out.push({ from: Number(m[1]) * 60 + Number(m[2]), to: Number(m[3]) * 60 + Number(m[4]) });
  }
  return out;
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

  /** A handle on the battery is being dragged: which one, and where to. */
  @state() private dragging?: { id: string; value: number };
  private dragFrame = 0;

  /** Drag a handle straight to a level: the bar is the scale. */
  private grab(id: string) {
    return (ev: PointerEvent) => {
      const st = this.st(id);
      if (!st || isUnavailable(st)) return;
      ev.preventDefault();
      const handle = ev.currentTarget as HTMLElement;
      const cell = this.renderRoot.querySelector('.cell') as HTMLElement;
      const rect = cell.getBoundingClientRect();
      const { min, max, step } = this.range(st);
      handle.setPointerCapture(ev.pointerId);
      haptic('selection');
      const at = (x: number) => Math.min(max, Math.max(min, Math.round((((x - rect.left) / rect.width) * 100) / step) * step));
      let value = at(ev.clientX);
      this.dragging = { id, value };
      const move = (e: PointerEvent) => {
        value = at(e.clientX);
        if (this.dragFrame) return;
        // One redraw per frame however fast the finger moves.
        this.dragFrame = requestAnimationFrame(() => {
          this.dragFrame = 0;
          if (this.dragging?.value !== value) this.dragging = { id, value };
        });
      };
      const end = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', end);
        handle.removeEventListener('pointercancel', end);
        cancelAnimationFrame(this.dragFrame);
        this.dragFrame = 0;
        this.dragging = undefined;
        this.setNumber(id, value);
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', end);
      handle.addEventListener('pointercancel', end);
    };
  }

  private level(id?: string): number | undefined {
    return id && this.dragging?.id === id ? this.dragging.value : this.num(id);
  }

  /** "−  Initial 24%  +": the number with its steppers, on one line. */
  private stepper(id: string, label: string) {
    const st = this.st(id);
    const v = this.level(id);
    const off = !st || isUnavailable(st);
    return html`<div class="stepper">
      <button class="round gl pm" aria-label="Lower ${label}" ?disabled=${off} @click=${() => this.nudge(id, -1)}><ha-icon icon="mdi:minus"></ha-icon></button>
      <div class="sval"><span>${label}</span><b>${v != null ? `${Math.round(v)}%` : '—'}</b></div>
      <button class="round gl pm" aria-label="Raise ${label}" ?disabled=${off} @click=${() => this.nudge(id, 1)}><ha-icon icon="mdi:plus"></ha-icon></button>
    </div>`;
  }

  private get charging(): boolean {
    const st = this.st(this.ids.status);
    return !!st && /^charging$/i.test(st.state);
  }

  /**
   * One battery: dim up to the charge it started at, bright from there to
   * where it is now, striped on to the target. White handles mark the
   * initial and target levels; drag either one. While charging, light runs
   * along the charged part.
   */
  private battery(ids: EvEntities) {
    if (!ids.soc && !ids.target) return nothing;
    const initial = this.level(ids.soc);
    const target = this.level(ids.target);
    const current = ids.current ? numericState(this.st(ids.current)) : undefined;
    const now = current ?? initial;
    const charged = initial != null && current != null && current > initial ? current : undefined;
    const toAdd = now != null && target != null ? Math.max(0, target - now) : undefined;
    const handle = (id: string | undefined, v: number | undefined, label: string) =>
      id && v != null
        ? html`<div class="handle ${this.dragging?.id === id ? 'held' : ''}" style="left:${v}%" role="slider" aria-label=${label} aria-valuemin="0" aria-valuemax="100" aria-valuenow=${Math.round(v)} @pointerdown=${this.grab(id)}><i></i><span>${label}</span></div>`
        : nothing;
    return html`<div class="panel">
      <div class="bhead">
        <h3 class="sec">Battery</h3>
        ${toAdd != null ? html`<div class="sub">${toAdd > 0 ? `${Math.round(toAdd)}% to add` : 'At or above target'}</div>` : nothing}
      </div>
      <div class="battery">
        <div class="cell" role="img" aria-label="Battery${now != null ? ` at ${Math.round(now)}%` : ''}${target != null ? `, charging to ${Math.round(target)}%` : ''}">
          ${initial != null ? html`<div class="start" style="width:${initial}%"></div>` : nothing}
          ${charged != null ? html`<div class="charged ${this.charging ? 'flow' : ''}" style="left:${initial}%;width:${charged - initial!}%"></div>` : nothing}
          ${target != null && now != null && target > now ? html`<div class="goal" style="left:${now}%;width:${target - now}%"></div>` : nothing}
          ${charged == null && this.charging && initial != null ? html`<div class="charged flow" style="left:0;width:${initial}%"></div>` : nothing}
          <div class="now">${now != null ? html`${Math.round(now)}<span>%</span>` : '—'}</div>
        </div>
        <div class="nub"></div>
        <div class="scale">
          ${handle(ids.soc, initial, 'Initial')}
          ${handle(ids.target, target, 'Target')}
        </div>
      </div>
      <div class="steppers">
        ${ids.soc ? this.stepper(ids.soc, 'Initial') : nothing}
        ${ids.target ? this.stepper(ids.target, 'Target') : nothing}
      </div>
    </div>`;
  }

  /**
   * The charge slots on a noon-to-noon timeline (charging is usually
   * overnight), with now marked and the slots listed underneath.
   */
  private slots(id: string) {
    const st = this.st(id);
    if (!st) return nothing;
    const slots = isUnavailable(st) ? [] : parseSlots(st.state);
    const now = new Date();
    const nowMin = now.getHours() * 60 + now.getMinutes();
    // Minutes since the window opened at noon: noon is 0, midnight 720, 11:59 1439.
    const pos = (m: number) => ((m - 720 + 1440) % 1440) / 1440;
    const total = slots.reduce((n, sl) => n + ((sl.to - sl.from + 1440) % 1440 || 1440), 0);
    const fmt = (m: number) => this.clockText(m % 1440).main + (this.clockText(m % 1440).ampm ? ` ${this.clockText(m % 1440).ampm}` : '');
    return html`<div class="panel">
      <div class="bhead">
        <h3 class="sec">Charge slots</h3>
        <div class="sub">${slots.length ? `${slots.length} ${slots.length === 1 ? 'slot' : 'slots'} · ${Math.floor(total / 60)} h ${total % 60} m` : 'None scheduled'}</div>
      </div>
      <div class="timeline" role="img" aria-label=${slots.length ? `Charging ${slots.map((sl) => `${fmt(sl.from)} to ${fmt(sl.to)}`).join(', ')}` : 'No charge slots'}>
        ${slots.map((sl) => {
          const a = pos(sl.from);
          let b = pos(sl.to);
          if (b <= a) b = 1;
          return html`<i style="left:${a * 100}%;width:${Math.max(0.4, (b - a) * 100)}%"></i>`;
        })}
        <b class="nowmark" style="left:${pos(nowMin) * 100}%"></b>
      </div>
      <div class="ticks">${[720, 1080, 0, 360, 720].map((m) => html`<span>${fmt(m)}</span>`)}</div>
      ${slots.length ? html`<div class="slotlist">${slots.map((sl) => html`<span>${fmt(sl.from)}–${fmt(sl.to)}</span>`)}</div>` : nothing}
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
      ${ids.slots ? this.slots(ids.slots) : nothing}
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
      /* One battery: dim to the starting charge, bright for what's been added, striped on to the target. */
      .battery {
        position: relative;
        display: flex;
        align-items: center;
        gap: 6px;
        margin: 8px 0 34px;
      }
      .cell {
        position: relative;
        flex: 1;
        height: 96px;
        border-radius: 24px;
        overflow: hidden;
        background: var(--_glass-hi);
      }
      .start,
      .charged,
      .goal {
        position: absolute;
        top: 0;
        bottom: 0;
        transition: width 0.25s ease, left 0.25s ease;
      }
      .start {
        left: 0;
        background: rgba(76, 208, 125, 0.5);
      }
      .charged {
        background: #4cd07d;
      }
      /* Charging: light sweeps along the charged part, left to right. */
      .charged.flow {
        background: linear-gradient(90deg, #4cd07d 0%, #4cd07d 35%, #9df0b9 50%, #4cd07d 65%, #4cd07d 100%) 0 0 / 200% 100%;
        animation: flow 2.4s linear infinite;
      }
      @keyframes flow {
        from {
          background-position: 100% 0;
        }
        to {
          background-position: -100% 0;
        }
      }
      .goal {
        background: repeating-linear-gradient(135deg, rgba(76, 208, 125, 0.3) 0 10px, rgba(76, 208, 125, 0.14) 10px 20px);
      }
      .now {
        position: absolute;
        left: 24px;
        top: 50%;
        transform: translateY(-50%);
        font-size: 48px;
        font-weight: 700;
        letter-spacing: -0.03em;
        color: #fff;
        text-shadow: 0 1px 8px rgba(0, 0, 0, 0.35);
        pointer-events: none;
      }
      .now span {
        font-size: 24px;
        margin-left: 2px;
      }
      .nub {
        width: 10px;
        height: 34px;
        border-radius: 0 6px 6px 0;
        background: var(--_glass-hi);
      }
      /* The handles' scale: the cell's width, not the nub's. */
      .scale {
        position: absolute;
        top: 0;
        bottom: 0;
        left: 0;
        right: 16px;
        pointer-events: none;
      }
      /* A white bar on the battery, with a wide invisible grip and its name underneath. */
      .handle {
        position: absolute;
        top: -8px;
        bottom: -30px;
        width: 48px;
        margin-left: -24px;
        display: flex;
        flex-direction: column;
        align-items: center;
        touch-action: none;
        cursor: ew-resize;
        pointer-events: auto;
      }
      .handle i {
        width: 8px;
        height: 112px;
        border-radius: 4px;
        background: #fff;
        box-shadow: 0 2px 10px rgba(0, 0, 0, 0.45);
        transition: transform 0.15s ease;
      }
      .handle.held i {
        transform: scaleX(1.4);
      }
      .handle span {
        margin-top: 4px;
        font-size: 13px;
        font-weight: 700;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        color: var(--_ink2);
        white-space: nowrap;
      }
      .steppers {
        display: flex;
        justify-content: space-between;
        gap: 16px;
        flex-wrap: wrap;
      }
      .stepper {
        display: flex;
        align-items: center;
        gap: 14px;
      }
      .sval {
        min-width: 96px;
        text-align: center;
      }
      .sval span {
        display: block;
        font-size: 14px;
        font-weight: 700;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        color: var(--_ink2);
      }
      .sval b {
        font-size: 34px;
        font-weight: 600;
        letter-spacing: -0.02em;
      }
      .pm {
        width: 60px;
        height: 60px;
        --mdc-icon-size: 26px;
      }
      .timeline {
        position: relative;
        height: 40px;
        border-radius: 12px;
        overflow: hidden;
        background: var(--_glass-hi);
      }
      .timeline i {
        position: absolute;
        top: 0;
        bottom: 0;
        background: #4cd07d;
      }
      .nowmark {
        position: absolute;
        top: -4px;
        bottom: -4px;
        width: 3px;
        margin-left: -1.5px;
        background: var(--_ink);
      }
      .ticks {
        display: flex;
        justify-content: space-between;
        margin-top: 8px;
        font-size: 14px;
        font-weight: 600;
        color: var(--_ink2);
      }
      .slotlist {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-top: 14px;
      }
      .slotlist span {
        padding: 8px 14px;
        border-radius: 999px;
        background: var(--_glass-hi);
        font-size: 16px;
        font-weight: 600;
      }
      @media (prefers-reduced-motion: reduce) {
        .charged.flow {
          animation: none;
        }
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
        .stepper {
          gap: 8px;
        }
        .sval {
          min-width: 72px;
        }
        .sval b {
          font-size: 28px;
        }
        .now {
          font-size: 38px;
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
