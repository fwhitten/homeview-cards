import { css, html, nothing } from 'lit';
import { state } from 'lit/decorators.js';
import { HomeViewCard, type BaseCardConfig } from '../core/base-card';
import type { GridOptions, HassEntity } from '../core/types';
import { areaName } from '../core/areas';
import { numericState } from '../core/format';
import { defineElement, registerCard } from '../core/register';
import { haptic } from '../core/events';

export interface VacuumCardConfig extends BaseCardConfig {
  entity: string;
  /** A: state first with quick actions. B: pick areas and suction, then clean. */
  style?: 'status' | 'areas';
  /** The vacuum's battery sensor. The vacuum entity no longer carries battery itself. */
  battery_entity?: string;
  /** Home Assistant areas mapped to the vacuum's segments, for vacuum.clean_area. */
  areas?: string[];
}

/** VacuumEntityFeature bits from Home Assistant core. */
const F = { PAUSE: 4, STOP: 8, RETURN_HOME: 16, FAN_SPEED: 32, LOCATE: 512, CLEAN_SPOT: 1024, START: 8192, CLEAN_AREA: 16384 };
const has = (st: HassEntity, f: number) => ((st.attributes.supported_features ?? 0) & f) !== 0;

const LABEL: Record<string, string> = {
  cleaning: 'Cleaning',
  docked: 'Docked',
  idle: 'Idle',
  paused: 'Paused',
  returning: 'Returning',
  error: 'Error',
};

/**
 * Robot vacuum, built on the standard vacuum entity: state, start / pause /
 * stop, return to dock, locate, suction, and cleaning by Home Assistant area.
 */
export class HomeViewVacuumCard extends HomeViewCard<VacuumCardConfig> {
  @state() private picked: string[] = [];

  static getConfigForm() {
    return {
      schema: [
        { name: 'entity', required: true, selector: { entity: { domain: 'vacuum' } } },
        { name: 'name', selector: { text: {} } },
        { name: 'style', default: 'status', selector: { select: { options: [{ value: 'status', label: 'A: state and quick actions' }, { value: 'areas', label: 'B: clean by area, set suction' }] } } },
        { name: 'battery_entity', selector: { entity: { domain: 'sensor', device_class: 'battery' } } },
        { name: 'areas', selector: { area: { multiple: true } } },
        { name: 'tap_action', selector: { ui_action: {} } },
      ],
      computeHelper: (s: { name: string }) =>
        s.name === 'areas'
          ? 'Areas you have mapped to the vacuum (entity settings → Map vacuum segments to areas)'
          : undefined,
    };
  }

  static getStubConfig(_hass: unknown, entities: string[], fallback: string[]) {
    return { entity: [...entities, ...fallback].find((e) => e.startsWith('vacuum.')) ?? '' };
  }

  protected validate(config: VacuumCardConfig): void {
    if (!config.entity) throw new Error('Set a vacuum entity');
  }

  protected defaults(): Partial<VacuumCardConfig> {
    return { style: 'status' };
  }

  protected watched() {
    return [this.config.entity, this.config.battery_entity];
  }

  private svc(service: string, data: Record<string, unknown> = {}) {
    return (ev: Event) => {
      ev.stopPropagation();
      if (this.preview) return;
      haptic('light');
      void this.hass!.callService('vacuum', service, data, { entity_id: this.config.entity });
    };
  }

  private get battery(): number | undefined {
    if (this.config.battery_entity) return numericState(this.stateObj(this.config.battery_entity));
    return numericState(this.stateObj(), 'battery_level');
  }

  private toggleArea(id: string): void {
    this.picked = this.picked.includes(id) ? this.picked.filter((a) => a !== id) : [...this.picked, id];
    haptic('selection');
  }

  private clean = (ev: Event): void => {
    ev.stopPropagation();
    const st = this.stateObj();
    if (!st || this.preview) return;
    haptic('success');
    if (this.picked.length && has(st, F.CLEAN_AREA)) {
      void this.hass!.callService('vacuum', 'clean_area', { cleaning_area_id: this.picked }, { entity_id: this.config.entity });
      this.picked = [];
    } else {
      void this.hass!.callService('vacuum', 'start', {}, { entity_id: this.config.entity });
    }
  };

  private batteryChip() {
    const b = this.battery;
    if (b == null) return nothing;
    const icon = b > 90 ? 'mdi:battery' : `mdi:battery-${Math.max(10, Math.round(b / 10) * 10)}`;
    return html`<div class="batt"><ha-icon .icon=${icon}></ha-icon>${Math.round(b)}%</div>`;
  }

  private actions(st: HassEntity) {
    const s = st.state;
    const out = [];
    if (s === 'cleaning' && has(st, F.PAUSE)) out.push(html`<button class="btn gl" @click=${this.svc('pause')}><ha-icon icon="mdi:pause"></ha-icon>Pause</button>`);
    if ((s === 'paused' || s === 'idle' || s === 'docked' || s === 'error') && has(st, F.START))
      out.push(html`<button class="btn primary" @click=${this.svc('start')}><ha-icon icon="mdi:play"></ha-icon>${s === 'paused' ? 'Resume' : 'Start'}</button>`);
    if (s !== 'docked' && s !== 'returning' && has(st, F.RETURN_HOME)) out.push(html`<button class="btn gl" @click=${this.svc('return_to_base')}><ha-icon icon="mdi:home-import-outline"></ha-icon>Dock</button>`);
    if (s === 'paused' && has(st, F.STOP)) out.push(html`<button class="btn gl" @click=${this.svc('stop')}>Stop</button>`);
    if (has(st, F.LOCATE)) out.push(html`<button class="btn gl" aria-label="Locate" @click=${this.svc('locate')}><ha-icon icon="mdi:map-marker-radius-outline"></ha-icon>${this.size === 'w' && out.length < 2 ? 'Locate' : ''}</button>`);
    return out.slice(0, 3);
  }

  render() {
    if (!this.hass) return nothing;
    const st = this.stateObj();
    const name = this.config.name ?? st?.attributes.friendly_name ?? 'Vacuum';
    if (!st) return html`<ha-card class="tile"><div class="warn">Entity not found: ${this.config.entity}</div></ha-card>`;
    const s = st.state;
    const cleaning = s === 'cleaning';
    const error = s === 'error';
    const label = LABEL[s] ?? this.hass.formatEntityState(st);
    const fan = st.attributes.fan_speed as string | undefined;
    const iconBg = cleaning ? 'var(--hv-c-clean)' : error ? '#fff' : s === 'paused' ? 'rgba(64,200,192,.3)' : 'var(--_glass-hi)';
    const iconInk = cleaning ? '#04302d' : error ? '#b3262b' : s === 'paused' ? 'var(--_clean-ink)' : 'var(--_ink2)';
    const sub = [error ? (st.attributes.status as string | undefined) ?? 'Check the vacuum' : undefined, fan && !error ? fan[0].toUpperCase() + fan.slice(1) : undefined, s === 'docked' && this.battery != null && this.battery < 100 ? 'Charging' : undefined]
      .filter(Boolean)
      .join(' · ');
    const badge = html`<button class="round badge ${cleaning || error || s === 'paused' ? '' : 'gl'}" style="background:${iconBg};color:${iconInk}" aria-label=${cleaning ? 'Pause' : 'Start'} @click=${cleaning ? this.svc('pause') : this.svc('start')}>
      <ha-icon class=${cleaning ? 'anim spin' : ''} icon="mdi:robot-vacuum"></ha-icon>
    </button>`;
    const cardStyle = error ? 'background:radial-gradient(130% 80% at 0% 0%, rgba(255,255,255,.14), rgba(255,255,255,0) 52%), rgba(229,72,77,.5);color:#fff' : '';

    if (this.config.style === 'areas' && (this.size === 'l' || this.size === 't')) {
      const areas = this.config.areas ?? [];
      const speeds = (st.attributes.fan_speed_list as string[] | undefined) ?? [];
      const n = this.picked.length;
      return html`<ha-card class="tile" style=${cardStyle}>
        <div class="in big">
          <div class="head"><div class="hl">${badge}<div><div class="name">${name}</div><div class="sub">${label}${sub ? ` · ${sub}` : ''}</div></div></div>${this.batteryChip()}</div>
          ${areas.length && has(st, F.CLEAN_AREA)
            ? html`<div><div class="cap lbl">Areas</div><div class="areas">${areas.map((a) => {
                const on = this.picked.includes(a);
                return html`<button class="pill ${on ? 'on' : 'gl'}" aria-pressed=${on} @click=${(e: Event) => {
                  e.stopPropagation();
                  this.toggleArea(a);
                }}>${areaName(this.hass!, a) ?? a}</button>`;
              })}</div></div>`
            : nothing}
          ${speeds.length && has(st, F.FAN_SPEED)
            ? html`<div><div class="cap lbl">Suction</div><div class="seg gl" style="grid-template-columns:repeat(${Math.min(speeds.length, 5)},minmax(0,1fr))">${speeds.slice(0, 5).map(
                (f) => html`<button aria-pressed=${f === fan} @click=${this.svc('set_fan_speed', { fan_speed: f })}>${f[0].toUpperCase() + f.slice(1)}</button>`,
              )}</div></div>`
            : nothing}
          <div class="acts">
            ${cleaning
              ? html`<button class="btn primary grow" @click=${this.svc('pause')}><ha-icon icon="mdi:pause"></ha-icon>Pause</button>`
              : html`<button class="btn primary grow" @click=${this.clean}><ha-icon icon="mdi:play"></ha-icon>${n ? `Clean ${n} ${n === 1 ? 'area' : 'areas'}` : 'Clean everywhere'}</button>`}
            ${has(st, F.RETURN_HOME) && s !== 'docked' ? html`<button class="btn gl" aria-label="Return to dock" @click=${this.svc('return_to_base')}><ha-icon icon="mdi:home-import-outline"></ha-icon></button>` : nothing}
            ${has(st, F.LOCATE) ? html`<button class="btn gl" aria-label="Locate" @click=${this.svc('locate')}><ha-icon icon="mdi:map-marker-radius-outline"></ha-icon></button>` : nothing}
          </div>
        </div>
      </ha-card>`;
    }

    if (this.size === 's') {
      return html`<ha-card class="tile clickable" style=${cardStyle} tabindex="0" role="button" aria-label="${name}, ${label}">
        <div class="in">${badge}<div><div class="name sm">${label}</div><div class="sub sm">${[fan && !error ? fan : '', this.battery != null ? `${Math.round(this.battery)}%` : ''].filter(Boolean).join(' · ') || name}</div></div></div>
      </ha-card>`;
    }

    return html`<ha-card class="tile clickable" style=${cardStyle} tabindex="0" role="button" aria-label="${name}, ${label}">
      <div class="in wide">
        <div class="head"><div class="hl">${badge}<div class="tx"><div class="name">${label}</div><div class="sub st" style="color:${cleaning ? 'var(--_clean-ink)' : error ? 'rgba(255,255,255,.86)' : 'var(--_ink2)'}">${sub || name}</div></div></div>${this.batteryChip()}</div>
        <div class="acts">${this.actions(st)}</div>
      </div>
    </ha-card>`;
  }

  getGridOptions(): GridOptions {
    return this.config?.style === 'areas' ? { columns: 12, rows: 6, min_columns: 6, min_rows: 5 } : { columns: 12, rows: 3, min_columns: 6, min_rows: 3 };
  }

  getCardSize(): number {
    return this.config?.style === 'areas' ? 7 : 3;
  }

  static styles = [
    ...HomeViewCard.styles,
    css`
      .head {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: 12px;
      }
      .hl {
        display: flex;
        align-items: center;
        gap: 14px;
        min-width: 0;
      }
      .tx {
        min-width: 0;
      }
      .badge {
        width: 52px;
        height: 52px;
        --mdc-icon-size: 28px;
      }
      .name.sm {
        font-size: 19px;
      }
      .sub.sm {
        font-size: 16px;
      }
      .st {
        font-weight: 600;
      }
      .batt {
        display: flex;
        align-items: center;
        gap: 4px;
        font-size: 20px;
        font-weight: 600;
        color: var(--_ink);
        --mdc-icon-size: 22px;
      }
      .batt ha-icon {
        color: var(--_ink2);
      }
      .acts {
        display: flex;
        gap: 10px;
      }
      .btn.primary {
        background: var(--hv-c-clean);
        color: #04302d;
      }
      .grow {
        flex: 1;
      }
      .big {
        padding: 20px 22px;
      }
      .wide {
        padding: 20px 22px;
      }
      .lbl {
        margin-bottom: 10px;
      }
      .areas {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 8px;
      }
      .pill {
        height: 46px;
        padding: 0 12px;
        border: 0;
        border-radius: 999px;
        font: inherit;
        font-size: 17px;
        font-weight: 600;
        color: var(--_ink);
        cursor: pointer;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .pill.on {
        background: var(--hv-c-clean);
        color: #04302d;
      }
      .seg {
        display: grid;
        gap: 4px;
        padding: 4px;
        border-radius: 999px;
      }
      .seg button {
        height: 40px;
        border: 0;
        border-radius: 999px;
        font: inherit;
        font-size: 16px;
        font-weight: 600;
        cursor: pointer;
        background: none;
        color: var(--_ink);
      }
      .seg button[aria-pressed='true'] {
        background: var(--_ink);
        color: var(--_inv);
      }
      .spin {
        animation: spin 3s linear infinite;
      }
      @keyframes spin {
        to {
          transform: rotate(360deg);
        }
      }
    `,
  ];
}

defineElement('homeview-vacuum-card', HomeViewVacuumCard);
registerCard({
  type: 'homeview-vacuum-card',
  name: 'HomeView Vacuum',
  description: 'Robot vacuum state and controls, with cleaning by Home Assistant area.',
  getEntitySuggestion: (_hass, entityId) =>
    entityId.startsWith('vacuum.') ? { config: { type: 'custom:homeview-vacuum-card', entity: entityId } } : null,
  docs: 'vacuum',
});
