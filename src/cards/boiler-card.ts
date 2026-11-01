import { css, html, nothing } from 'lit';
import { HomeViewCard, type BaseCardConfig } from '../core/base-card';
import type { GridOptions } from '../core/types';
import { BOILER_ENTITY_SCHEMA, MODE_STYLE, boilerEntities, boilerMode, tempOf, type BoilerEntities } from '../core/boiler';
import { fixed } from '../core/format';
import { defineElement, registerCard } from '../core/register';
import { actionsSection, appearanceSection, editorFor, layoutSection, type EditorSpec } from '../core/editor';

export interface BoilerCardConfig extends BaseCardConfig, BoilerEntities {}

const EDITOR: EditorSpec = {
  schema: () => [{ name: 'name', selector: { text: {} } }, ...BOILER_ENTITY_SCHEMA, appearanceSection, actionsSection(), layoutSection],
  labels: {
    flow_temp_entity: 'Flow temperature',
    flow_target_entity: 'Flow target',
    return_temp_entity: 'Return temperature',
    flame_entity: 'Flame',
    pump_entity: 'Pump',
    dhw_temp_entity: 'Hot water temperature',
    dhw_target_entity: 'Hot water target',
    dhw_active_entity: 'Hot water active',
    infer_hot_water: 'Assume hot water when the flame is on and no zone is calling',
    zones: 'Heating zones',
    outdoor_entity: 'Outdoor temperature',
    indoor_entity: 'Indoor temperature',
    heating_energy_entity: 'Gas used for heating',
    hot_water_energy_entity: 'Gas used for hot water',
  },
  helpers: { tap_action: 'Default: opens the boiler pop-up', zones: 'A zone shows Heating while its heat-call entity is on, or its thermostat reports heating' },
};

/**
 * Boiler (design A): the mode and flow temperature, kept simple for the home
 * page. Tap opens the boiler pop-up with the flow diagram, zones and history.
 */
export class HomeViewBoilerCard extends HomeViewCard<BoilerCardConfig> {
  static getConfigElement() {
    return editorFor(EDITOR);
  }

  static getStubConfig() {
    return {};
  }

  protected validate(config: BoilerCardConfig): void {
    if (!config.flow_temp_entity && !config.flame_entity && !config.zones?.length) {
      throw new Error('Set at least a flow temperature, a flame entity or a heating zone');
    }
  }

  protected popupName(): string {
    return 'boiler';
  }

  protected watched() {
    return boilerEntities(this.config);
  }

  render() {
    if (!this.hass) return nothing;
    const mode = boilerMode(this.hass, this.config);
    const s = MODE_STYLE[mode];
    const flow = tempOf(this.hass, this.config.flow_temp_entity);
    const ret = tempOf(this.hass, this.config.return_temp_entity);
    const dhw = tempOf(this.hass, this.config.dhw_temp_entity);
    const dhwTarget = tempOf(this.hass, this.config.dhw_target_entity);
    const hot = mode === 'hot_water';
    const big = hot ? dhw : flow;
    const bigUnit = hot ? (dhwTarget != null ? `of ${Math.round(dhwTarget)}°` : 'hot water') : 'flow';
    const line = hot
      ? 'Heating water'
      : flow != null && ret != null
        ? `Return ${Math.round(ret)}° · ΔT ${fixed(this.hass, flow - ret, 0)}°`
        : '';
    const animated = mode === 'heating' || mode === 'hot_water';
    const name = this.config.name ?? 'Boiler';
    return html`
      <ha-card class="tile clickable" tabindex="0" role="button" aria-label="${name}, ${s.label}${big != null ? `, ${Math.round(big)} degrees` : ''}">
        <div class="in">
          <div class="head corner-tl">
            <span class="round badge ${mode === 'idle' ? 'gl' : ''}" style="background:${s.color};color:${s.ink}">
              <ha-icon class=${animated ? `anim ${hot ? 'drip' : 'flick'}` : ''} .icon=${s.icon}></ha-icon>
            </span>
            <div class="text">
              <div class="name">${name}</div>
              <div class="state" style="color:${s.text}">${s.label}</div>
            </div>
          </div>
          <div>
            <div class="reading"><span class="value">${big != null ? `${Math.round(big)}°` : '—'}</span><span class="sub">${bigUnit}</span></div>
            <div class="sub small">${line}</div>
          </div>
        </div>
      </ha-card>
    `;
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
      .head {
        display: flex;
        align-items: center;
        gap: 12px;
      }
      .text {
        min-width: 0;
      }
      .name {
        font-size: 19px;
      }
      .state {
        font-size: 16px;
        font-weight: 600;
      }
      .badge {
        width: 44px;
        height: 44px;
        cursor: default;
      }
      .reading {
        display: flex;
        align-items: baseline;
        gap: 6px;
      }
      .small {
        font-size: 16px;
      }
      .flick {
        animation: flick 1.4s ease-in-out infinite;
      }
      .drip {
        animation: drip 1.6s ease-in-out infinite;
      }
      @keyframes flick {
        40% {
          transform: scale(1.08) translateY(-1px);
        }
        70% {
          transform: scale(0.96);
        }
      }
      @keyframes drip {
        50% {
          transform: translateY(1.5px);
        }
      }
    `,
  ];
}

defineElement('homeview-boiler-card', HomeViewBoilerCard);
registerCard({
  type: 'homeview-boiler-card',
  name: 'HomeView Boiler',
  description: 'Boiler mode and flow temperature. Tap for the flow diagram, zones, gas use and history.',
  docs: 'boiler',
});
