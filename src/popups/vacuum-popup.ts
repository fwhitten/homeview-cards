import { css, html, nothing } from 'lit';
import { state } from 'lit/decorators.js';
import { PopupContent } from './popup-base';
import { areaName } from '../core/areas';
import { haptic } from '../core/events';
import { isUnavailable, numericState, time } from '../core/format';
import { defineElement } from '../core/register';
import type { HassEntity } from '../core/types';

/** VacuumEntityFeature bits from Home Assistant core. */
const F = { PAUSE: 4, STOP: 8, RETURN_HOME: 16, FAN_SPEED: 32, LOCATE: 512, CLEAN_SPOT: 1024, START: 8192, CLEAN_AREA: 16384 };
const has = (st: HassEntity, f: number) => ((st.attributes.supported_features ?? 0) & f) !== 0;

const LABEL: Record<string, string> = {
  cleaning: 'Cleaning',
  docked: 'Docked',
  idle: 'Idle',
  paused: 'Paused',
  returning: 'Returning to dock',
  error: 'Needs attention',
};

/** Parts that wear out, by name: brushes, filters, mops, sensors. */
const MAINTENANCE = /filter|brush|mop|pad|strainer|dirty|consumable|dust ?bag/i;
/** The last (or current) run: how much, how long. */
const LAST_RUN = /(clean(ing)?|last).*(area|time|duration)|(area|time|duration).*clean/i;

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, ' ');

/**
 * Vacuum pop-up: the state, battery and suction; big controls; cleaning by
 * area; the map, if the vacuum's device has one (an image or camera entity);
 * and the last run and the parts that wear out, from the device's sensors.
 */
export class HomeViewVacuumPopup extends PopupContent {
  @state() private picked: string[] = [];
  @state() private mapAt = Date.now();
  private refresh?: number;

  private get entity(): string | undefined {
    return this.props?.entity ?? this.cfg.entity;
  }

  popupTitle(): string {
    const st = this.st(this.entity);
    return this.cfg.name ?? st?.attributes.friendly_name ?? 'Vacuum';
  }

  popupSubtitle(): string {
    const st = this.st(this.entity);
    if (!st || !this.hass) return '';
    return `${LABEL[st.state] ?? this.hass.formatEntityState(st)} · updated ${time(this.hass, new Date())}`;
  }

  connectedCallback(): void {
    super.connectedCallback();
    // A camera map is a still: fetch it again now and then.
    this.refresh = window.setInterval(() => (this.mapAt = Date.now()), 15_000);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.clearInterval(this.refresh);
  }

  /** The other entities on the vacuum's device. */
  private get siblings(): string[] {
    const reg = this.hass?.entities ?? {};
    const device = this.entity ? reg[this.entity]?.device_id : undefined;
    if (!device) return [];
    return Object.values(reg)
      .filter((e) => e.device_id === device && e.entity_id !== this.entity && !e.hidden && this.hass!.states[e.entity_id])
      .map((e) => e.entity_id);
  }

  private get mapEntity(): string | undefined {
    return this.cfg.map_entity ?? this.siblings.find((id) => id.startsWith('image.') || id.startsWith('camera.'));
  }

  private get battery(): number | undefined {
    const id = this.cfg.battery_entity ?? this.siblings.find((s) => this.st(s)?.attributes.device_class === 'battery');
    return id ? numericState(this.st(id)) : numericState(this.st(this.entity), 'battery_level');
  }

  private svc(service: string, data: Record<string, unknown> = {}) {
    return () => {
      haptic('light');
      void this.hass!.callService('vacuum', service, data, { entity_id: this.entity });
    };
  }

  private toggleArea(id: string): void {
    haptic('selection');
    this.picked = this.picked.includes(id) ? this.picked.filter((a) => a !== id) : [...this.picked, id];
  }

  private clean = (): void => {
    const st = this.st(this.entity);
    if (!st) return;
    haptic('success');
    if (this.picked.length && has(st, F.CLEAN_AREA)) {
      void this.hass!.callService('vacuum', 'clean_area', { cleaning_area_id: this.picked }, { entity_id: this.entity });
      this.picked = [];
    } else {
      void this.hass!.callService('vacuum', 'start', {}, { entity_id: this.entity });
    }
  };

  // ---------------------------------------------------------------- parts

  private hero(st: HassEntity) {
    const s = st.state;
    const cleaning = s === 'cleaning';
    const error = s === 'error';
    const b = this.battery;
    const fan = st.attributes.fan_speed as string | undefined;
    const charging = s === 'docked' && b != null && b < 100;
    const note = error ? (st.attributes.status as string | undefined) ?? 'Check the vacuum' : charging ? 'Charging' : fan ? `${cap(fan)} suction` : '';
    return html`<div class="panel vhero ${error ? 'err' : ''}">
      <span class="robot ${cleaning ? 'on' : ''}"><ha-icon class=${cleaning ? 'anim spin' : ''} icon="mdi:robot-vacuum"></ha-icon></span>
      <div class="htext">
        <div class="state">${LABEL[s] ?? this.hass!.formatEntityState(st)}</div>
        ${note ? html`<div class="hnote">${note}</div>` : nothing}
      </div>
      ${b != null
        ? html`<div class="batt" role="img" aria-label="Battery ${Math.round(b)}%${charging ? ', charging' : ''}">
            <div class="bcell"><i style="width:${b}%;background:${b <= 20 ? '#e5484d' : b <= 40 ? '#ffb340' : '#4cd07d'}"></i></div>
            <div class="bval">${charging ? html`<ha-icon icon="mdi:lightning-bolt"></ha-icon>` : nothing}${Math.round(b)}%</div>
          </div>`
        : nothing}
    </div>`;
  }

  private controls(st: HassEntity) {
    const s = st.state;
    const cleaning = s === 'cleaning';
    const big = (icon: string, label: string, run: () => void, primary = false) =>
      html`<button class="ctl ${primary ? 'primary' : 'gl'}" @click=${run}><ha-icon .icon=${icon}></ha-icon><span>${label}</span></button>`;
    const n = this.picked.length;
    const buttons = [
      cleaning && has(st, F.PAUSE)
        ? big('mdi:pause', 'Pause', this.svc('pause'), true)
        : has(st, F.START)
          ? big('mdi:play', s === 'paused' ? 'Resume' : n ? `Clean ${n} ${n === 1 ? 'area' : 'areas'}` : 'Clean everywhere', s === 'paused' ? this.svc('start') : this.clean, true)
          : nothing,
      (cleaning || s === 'paused' || s === 'returning') && has(st, F.STOP) ? big('mdi:stop', 'Stop', this.svc('stop')) : nothing,
      s !== 'docked' && s !== 'returning' && has(st, F.RETURN_HOME) ? big('mdi:home-import-outline', 'Dock', this.svc('return_to_base')) : nothing,
      !cleaning && has(st, F.CLEAN_SPOT) ? big('mdi:target', 'Spot clean', this.svc('clean_spot')) : nothing,
      has(st, F.LOCATE) ? big('mdi:map-marker-radius-outline', 'Locate', this.svc('locate')) : nothing,
    ];
    return html`<div class="ctls">${buttons}</div>`;
  }

  private areas(st: HassEntity) {
    const areas = (this.cfg.areas as string[] | undefined) ?? [];
    if (!areas.length || !has(st, F.CLEAN_AREA)) return nothing;
    return html`<div class="block">
      <div class="bhead"><h3 class="sec">Clean by area</h3>${this.picked.length ? html`<button class="link" @click=${() => (this.picked = [])}>Clear</button>` : nothing}</div>
      <div class="pills">${areas.map((a) => {
        const on = this.picked.includes(a);
        return html`<button class="pill ${on ? 'on' : 'gl'}" aria-pressed=${on} @click=${() => this.toggleArea(a)}>${on ? html`<ha-icon icon="mdi:check"></ha-icon>` : nothing}${areaName(this.hass!, a) ?? a}</button>`;
      })}</div>
    </div>`;
  }

  private suction(st: HassEntity) {
    const speeds = (st.attributes.fan_speed_list as string[] | undefined) ?? [];
    if (!speeds.length || !has(st, F.FAN_SPEED)) return nothing;
    const fan = st.attributes.fan_speed as string | undefined;
    return html`<div class="block">
      <h3 class="sec">Suction</h3>
      <div class="speeds" role="radiogroup" aria-label="Suction">${speeds.map(
        (f) => html`<button role="radio" aria-checked=${f === fan} @click=${() => {
          haptic('selection');
          void this.hass!.callService('vacuum', 'set_fan_speed', { fan_speed: f }, { entity_id: this.entity });
        }}>${cap(f)}</button>`,
      )}</div>
    </div>`;
  }

  private map() {
    const id = this.mapEntity;
    const st = this.st(id);
    const pic = st?.attributes.entity_picture as string | undefined;
    if (!st || !pic || isUnavailable(st)) return nothing;
    const url = this.hass!.hassUrl(pic) + (id!.startsWith('camera.') ? `${pic.includes('?') ? '&' : '?'}t=${this.mapAt}` : '');
    return html`<div class="panel mappanel"><img class="map" src=${url} alt="Map from ${st.attributes.friendly_name ?? id}" /></div>`;
  }

  /** The device's sensors, as the last run and the parts that wear out. */
  private details() {
    const rows = this.siblings
      .filter((id) => id.startsWith('sensor.') && this.st(id)?.attributes.device_class !== 'battery' && !isUnavailable(this.st(id)))
      .map((id) => {
        const st = this.st(id)!;
        const name = String(st.attributes.friendly_name ?? id).replace(new RegExp(`^${this.popupTitle()}\\s*`, 'i'), '');
        return { id, st, name: cap(name || id) };
      });
    // Judge by name (falling back to the object id), not the "sensor." prefix.
    const key = (r: { id: string; name: string }) => `${r.name} ${r.id.split('.')[1] ?? ''}`.replace(/_/g, ' ');
    const maint = rows.filter((r) => MAINTENANCE.test(key(r))).slice(0, 8);
    const last = rows.filter((r) => !maint.includes(r) && LAST_RUN.test(key(r))).slice(0, 4);
    if (!maint.length && !last.length) return nothing;
    const value = (st: HassEntity) => this.hass!.formatEntityState(st);
    return html`<div class="details">
      ${last.length
        ? html`<div class="panel">
            <h3 class="sec">Last clean</h3>
            <div class="stats">${last.map((r) => html`<div><div class="sv">${value(r.st)}</div><div class="sl">${r.name}</div></div>`)}</div>
          </div>`
        : nothing}
      ${maint.length
        ? html`<div class="panel">
            <h3 class="sec">Maintenance</h3>
            <div class="parts">${maint.map((r) => {
              const pct = r.st.attributes.unit_of_measurement === '%' ? numericState(r.st) : undefined;
              return html`<div class="part">
                <div class="pl"><span>${r.name}</span><b style="color:${pct != null && pct <= 10 ? 'var(--hv-c-alert, #e5484d)' : 'inherit'}">${value(r.st)}</b></div>
                ${pct != null ? html`<div class="pbar"><i style="width:${pct}%;background:${pct <= 10 ? '#e5484d' : pct <= 25 ? '#ffb340' : 'var(--hv-c-clean)'}"></i></div>` : nothing}
              </div>`;
            })}</div>
          </div>`
        : nothing}
    </div>`;
  }

  render() {
    const st = this.st(this.entity);
    if (!this.hass || !st) return html`<div class="panel sub">Vacuum not found</div>`;
    const map = this.map();
    return html`
      <div class="top ${map === nothing ? 'nomap' : ''}">
        <div class="main">
          ${this.hero(st)}
          <div class="panel">
            ${this.controls(st)}
            ${this.areas(st)}
            ${this.suction(st)}
          </div>
        </div>
        ${map}
      </div>
      ${this.details()}
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
        grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr);
        gap: 20px;
      }
      .top.nomap {
        grid-template-columns: minmax(0, 1fr);
      }
      .main {
        display: flex;
        flex-direction: column;
        gap: 20px;
        min-width: 0;
      }
      .vhero {
        display: flex;
        align-items: center;
        gap: 18px;
      }
      .vhero.err {
        background: rgba(229, 72, 77, 0.45);
      }
      .robot {
        flex: none;
        width: 72px;
        height: 72px;
        display: grid;
        place-items: center;
        border-radius: 50%;
        background: var(--_glass-hi);
        color: var(--_ink2);
        --mdc-icon-size: 40px;
      }
      .robot.on {
        background: var(--hv-c-clean);
        color: #04302d;
      }
      .htext {
        flex: 1;
        min-width: 0;
      }
      .state {
        font-size: 32px;
        font-weight: 700;
        letter-spacing: -0.01em;
      }
      .hnote {
        font-size: 18px;
        font-weight: 600;
        color: var(--_ink2);
        margin-top: 2px;
      }
      .batt {
        flex: none;
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        gap: 6px;
      }
      .bcell {
        width: 86px;
        height: 30px;
        padding: 3px;
        box-sizing: border-box;
        border-radius: 10px;
        border: 2px solid var(--_ink3);
      }
      .bcell i {
        display: block;
        height: 100%;
        border-radius: 6px;
      }
      .bval {
        display: flex;
        align-items: center;
        gap: 2px;
        font-size: 24px;
        font-weight: 700;
        --mdc-icon-size: 20px;
      }
      .ctls {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
      }
      .ctl {
        position: relative;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 6px;
        flex: 1 1 88px;
        min-height: 84px;
        padding: 10px;
        border: 0;
        border-radius: 22px;
        color: var(--_ink);
        font: inherit;
        font-size: 16px;
        font-weight: 600;
        cursor: pointer;
        --mdc-icon-size: 28px;
      }
      .ctl.primary {
        flex: 2 1 180px;
        flex-direction: row;
        gap: 10px;
        font-size: 19px;
        background: var(--hv-c-clean);
        color: #04302d;
      }
      .block {
        margin-top: 22px;
      }
      .bhead {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
      }
      .link {
        border: 0;
        background: none;
        color: var(--_ink2);
        font: inherit;
        font-size: 16px;
        font-weight: 600;
        cursor: pointer;
        padding: 6px 0;
      }
      .pills {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
        gap: 10px;
      }
      .pill {
        position: relative;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        min-height: 54px;
        padding: 0 14px;
        border: 0;
        border-radius: 18px;
        color: var(--_ink);
        font: inherit;
        font-size: 17px;
        font-weight: 600;
        cursor: pointer;
        --mdc-icon-size: 20px;
      }
      .pill.on {
        background: var(--hv-c-clean);
        color: #04302d;
      }
      .speeds {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
        padding: 4px;
        border-radius: 22px;
        background: var(--_glass-hi);
      }
      .speeds button {
        flex: 1 0 auto;
        min-height: 50px;
        padding: 0 16px;
        border: 0;
        border-radius: 18px;
        background: none;
        color: var(--_ink2);
        font: inherit;
        font-size: 17px;
        font-weight: 600;
        cursor: pointer;
      }
      .speeds button[aria-checked='true'] {
        background: var(--_ink);
        color: var(--_inv);
      }
      .mappanel {
        display: grid;
        place-items: center;
        padding: 14px;
        min-height: 260px;
      }
      .map {
        width: 100%;
        height: 100%;
        max-height: 520px;
        object-fit: contain;
        border-radius: 18px;
      }
      .details {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
        gap: 20px;
      }
      .stats {
        display: flex;
        flex-wrap: wrap;
        gap: 16px 32px;
      }
      .sv {
        font-size: 30px;
        font-weight: 600;
        letter-spacing: -0.02em;
      }
      .sl {
        font-size: 15px;
        font-weight: 600;
        color: var(--_ink2);
      }
      .parts {
        display: flex;
        flex-direction: column;
        gap: 14px;
      }
      .pl {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        font-size: 17px;
        font-weight: 600;
      }
      .pl span {
        color: var(--_ink2);
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .pl b {
        white-space: nowrap;
      }
      .pbar {
        height: 8px;
        margin-top: 6px;
        border-radius: 4px;
        background: var(--_track);
        overflow: hidden;
      }
      .pbar i {
        display: block;
        height: 100%;
        border-radius: 4px;
      }
      .spin {
        animation: spin 3s linear infinite;
      }
      @keyframes spin {
        to {
          transform: rotate(360deg);
        }
      }
      @container (max-width: 820px) {
        .top {
          grid-template-columns: minmax(0, 1fr);
        }
      }
      @container (max-width: 480px) {
        .panel {
          padding: 18px;
        }
        .robot {
          width: 56px;
          height: 56px;
          --mdc-icon-size: 32px;
        }
        .state {
          font-size: 26px;
        }
        .bcell {
          width: 64px;
        }
        .ctl {
          min-height: 72px;
        }
        .ctl.primary {
          flex-basis: 100%;
        }
      }
    `,
  ];
}

defineElement('homeview-vacuum-popup', HomeViewVacuumPopup);
