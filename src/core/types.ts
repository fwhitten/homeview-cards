/**
 * The subset of Home Assistant frontend types HomeView relies on.
 * Shapes follow the contributors docs' hass object reference.
 */

export interface HassEntity {
  entity_id: string;
  state: string;
  attributes: Record<string, any>;
  last_changed: string;
  last_updated: string;
}

export interface EntityRegistryDisplayEntry {
  entity_id: string;
  name?: string | null;
  icon?: string;
  device_id?: string;
  area_id?: string;
  hidden?: boolean;
  entity_category?: 'config' | 'diagnostic' | null;
  translation_key?: string;
  platform?: string;
}

export interface DeviceRegistryEntry {
  id: string;
  name?: string | null;
  name_by_user?: string | null;
  area_id?: string | null;
}

export interface AreaRegistryEntry {
  area_id: string;
  name: string;
  icon?: string | null;
  floor_id?: string | null;
}

export interface HassConfig {
  time_zone: string;
  unit_system: { temperature: string; length: string };
  currency?: string;
}

export interface FrontendLocale {
  language: string;
  number_format?: string;
  time_format?: 'language' | 'system' | '12' | '24';
  first_weekday?: 'language' | 'monday' | 'sunday' | 'saturday';
}

export type UnsubscribeFunc = () => Promise<void> | void;

export interface HomeAssistant {
  states: Record<string, HassEntity>;
  entities: Record<string, EntityRegistryDisplayEntry>;
  devices: Record<string, DeviceRegistryEntry>;
  areas: Record<string, AreaRegistryEntry>;
  config: HassConfig;
  user?: { id: string; name: string; is_admin: boolean };
  themes: { darkMode: boolean; theme: string };
  language: string;
  locale: FrontendLocale;
  connection: {
    subscribeMessage<T>(
      callback: (message: T) => void,
      subscribeMessage: Record<string, unknown>,
      options?: { resubscribe?: boolean },
    ): Promise<() => Promise<void>>;
  };
  callService(
    domain: string,
    service: string,
    serviceData?: Record<string, unknown>,
    target?: Record<string, unknown>,
    notifyOnError?: boolean,
    returnResponse?: boolean,
  ): Promise<unknown>;
  callWS<T>(message: Record<string, unknown>): Promise<T>;
  callApi<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, parameters?: Record<string, unknown>): Promise<T>;
  hassUrl(path?: string): string;
  localize(key: string, values?: Record<string, unknown>): string;
  formatEntityState(stateObj: HassEntity, state?: string): string;
  formatEntityAttributeValue(stateObj: HassEntity, attribute: string, value?: unknown): string;
  formatEntityName?(stateObj: HassEntity, name?: unknown): string;
}

/** HA's standard action config, plus HomeView's own pop-up action. */
export interface ActionConfig {
  action:
    | 'none'
    | 'more-info'
    | 'toggle'
    | 'navigate'
    | 'url'
    | 'perform-action'
    | 'call-service'
    | 'homeview-popup';
  entity?: string;
  navigation_path?: string;
  navigation_replace?: boolean;
  url_path?: string;
  perform_action?: string;
  service?: string;
  data?: Record<string, unknown>;
  service_data?: Record<string, unknown>;
  target?: Record<string, unknown>;
  confirmation?: boolean | { text?: string };
  /** For `homeview-popup`: which pop-up to open (defaults to the card's own). */
  popup?: string;
}

export interface LovelaceCardConfig {
  type: string;
  view_layout?: Record<string, unknown>;
  [key: string]: any;
}

export interface GridOptions {
  columns?: number | 'full';
  rows?: number | 'auto';
  min_columns?: number;
  max_columns?: number;
  min_rows?: number;
  max_rows?: number;
}

export interface LovelaceCard extends HTMLElement {
  hass?: HomeAssistant;
  preview?: boolean;
  setConfig(config: LovelaceCardConfig): void;
  getCardSize?(): number | Promise<number>;
  getGridOptions?(): GridOptions;
}

export interface CustomCardEntry {
  type: string;
  name: string;
  description: string;
  preview?: boolean;
  documentationURL?: string;
  getEntitySuggestion?: (hass: HomeAssistant, entityId: string) => unknown;
}

declare global {
  interface Window {
    customCards?: CustomCardEntry[];
    loadCardHelpers?: () => Promise<{
      createCardElement(config: LovelaceCardConfig): LovelaceCard;
    }>;
  }
  interface HTMLElementEventMap {
    'hass-more-info': CustomEvent<{ entityId: string }>;
    'config-changed': CustomEvent<{ config: LovelaceCardConfig }>;
  }
}
