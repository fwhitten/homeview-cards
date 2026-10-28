import type { HassEntity, HomeAssistant } from './types';
import { numericState } from './format';

export interface BoilerZone {
  name?: string;
  climate_entity: string;
  /** On while the zone calls for heat. The most reliable signal when available. */
  heat_call_entity?: string;
  humidity_entity?: string;
  icon?: string;
}

export interface BoilerEntities {
  flow_temp_entity?: string;
  flow_target_entity?: string;
  return_temp_entity?: string;
  dhw_temp_entity?: string;
  dhw_target_entity?: string;
  flame_entity?: string;
  pump_entity?: string;
  dhw_active_entity?: string;
  /** Without dhw_active_entity, assume hot water when the flame is on and no zone is calling. */
  infer_hot_water?: boolean;
  zones?: BoilerZone[];
  outdoor_entity?: string;
  indoor_entity?: string;
  heating_energy_entity?: string;
  hot_water_energy_entity?: string;
}

export type BoilerMode = 'heating' | 'hot_water' | 'overrun' | 'idle';

const on = (st?: HassEntity): boolean => !!st && ['on', 'true', 'heating', 'running'].includes(st.state.toLowerCase());

/** A zone is heating if it calls for heat, reports hvac_action heating, or sits below target in heat mode. */
export const zoneHeating = (hass: HomeAssistant, zone: BoilerZone): boolean => {
  if (zone.heat_call_entity) return on(hass.states[zone.heat_call_entity]);
  const st = hass.states[zone.climate_entity];
  if (!st) return false;
  const action = st.attributes.hvac_action as string | undefined;
  if (action) return action === 'heating' || action === 'preheating';
  const cur = numericState(st, 'current_temperature');
  const tgt = numericState(st, 'temperature');
  return ['heat', 'auto', 'heat_cool'].includes(st.state) && cur != null && tgt != null && cur < tgt;
};

export const pumpState = (st?: HassEntity): 'on' | 'off' | 'overrun' => {
  if (!st) return 'off';
  const s = st.state.toLowerCase();
  if (/overrun|run-on|post-run/.test(s)) return 'overrun';
  return on(st) ? 'on' : 'off';
};

export const boilerMode = (hass: HomeAssistant, cfg: BoilerEntities): BoilerMode => {
  const anyZone = (cfg.zones ?? []).some((z) => zoneHeating(hass, z));
  const flame = on(cfg.flame_entity ? hass.states[cfg.flame_entity] : undefined);
  const dhw = cfg.dhw_active_entity
    ? on(hass.states[cfg.dhw_active_entity])
    : (cfg.infer_hot_water ?? true) && flame && !anyZone && !!cfg.zones?.length;
  if (dhw) return 'hot_water';
  if (anyZone) return 'heating';
  if (pumpState(cfg.pump_entity ? hass.states[cfg.pump_entity] : undefined) === 'overrun') return 'overrun';
  return 'idle';
};

export const MODE_STYLE: Record<BoilerMode, { label: string; color: string; ink: string; icon: string; text: string }> = {
  heating: { label: 'Heating', color: '#FF8A3D', ink: '#fff', icon: 'mdi:fire', text: 'var(--_heat-ink)' },
  hot_water: { label: 'Hot water', color: '#5AC8FA', ink: '#03283a', icon: 'mdi:water', text: 'var(--_dhw-ink)' },
  overrun: { label: 'Pump overrun', color: '#B497F5', ink: '#1c0f3a', icon: 'mdi:fan', text: 'var(--_ink2)' },
  idle: { label: 'Idle', color: 'var(--_glass-hi)', ink: 'var(--_ink2)', icon: 'mdi:fire-off', text: 'var(--_ink2)' },
};

/** Every entity a boiler config refers to, for selective re-rendering. */
export const boilerEntities = (cfg: BoilerEntities): string[] =>
  [
    cfg.flow_temp_entity,
    cfg.flow_target_entity,
    cfg.return_temp_entity,
    cfg.dhw_temp_entity,
    cfg.dhw_target_entity,
    cfg.flame_entity,
    cfg.pump_entity,
    cfg.dhw_active_entity,
    cfg.outdoor_entity,
    cfg.indoor_entity,
    cfg.heating_energy_entity,
    cfg.hot_water_energy_entity,
    ...(cfg.zones ?? []).flatMap((z) => [z.climate_entity, z.heat_call_entity, z.humidity_entity]),
  ].filter((e): e is string => !!e);

/** A temperature reading from a sensor, number, water_heater or climate entity. */
export const tempOf = (hass: HomeAssistant, id?: string): number | undefined => {
  const st = id ? hass.states[id] : undefined;
  if (!st) return undefined;
  if (id!.startsWith('climate.') || id!.startsWith('water_heater.')) {
    return numericState(st, id!.startsWith('water_heater.') ? 'temperature' : 'current_temperature');
  }
  return numericState(st);
};

export const BOILER_ENTITY_SCHEMA = [
  {
    type: 'expandable',
    name: '',
    title: 'Boiler sensors',
    schema: [
      { name: 'flow_temp_entity', selector: { entity: { domain: ['sensor', 'number'] } } },
      { name: 'flow_target_entity', selector: { entity: { domain: ['sensor', 'number'] } } },
      { name: 'return_temp_entity', selector: { entity: { domain: ['sensor', 'number'] } } },
      { name: 'flame_entity', selector: { entity: {} } },
      { name: 'pump_entity', selector: { entity: {} } },
    ],
  },
  {
    type: 'expandable',
    name: '',
    title: 'Hot water',
    schema: [
      { name: 'dhw_temp_entity', selector: { entity: { domain: ['sensor', 'number', 'water_heater'] } } },
      { name: 'dhw_target_entity', selector: { entity: { domain: ['sensor', 'number', 'water_heater'] } } },
      { name: 'dhw_active_entity', selector: { entity: {} } },
      { name: 'infer_hot_water', default: true, selector: { boolean: {} } },
    ],
  },
  {
    name: 'zones',
    selector: {
      object: {
        multiple: true,
        label_field: 'name',
        fields: {
          name: { label: 'Name', selector: { text: {} } },
          climate_entity: { label: 'Thermostat', required: true, selector: { entity: { domain: 'climate' } } },
          heat_call_entity: { label: 'Heat call (optional)', selector: { entity: {} } },
          humidity_entity: { label: 'Humidity (optional)', selector: { entity: { domain: 'sensor' } } },
          icon: { label: 'Icon', selector: { icon: {} } },
        },
      },
    },
  },
  {
    type: 'expandable',
    name: '',
    title: 'Temperatures and gas (pop-up)',
    schema: [
      { name: 'outdoor_entity', selector: { entity: { domain: ['sensor', 'weather'] } } },
      { name: 'indoor_entity', selector: { entity: { domain: ['sensor', 'climate'] } } },
      { name: 'heating_energy_entity', selector: { entity: { domain: 'sensor' } } },
      { name: 'hot_water_energy_entity', selector: { entity: { domain: 'sensor' } } },
    ],
  },
];
