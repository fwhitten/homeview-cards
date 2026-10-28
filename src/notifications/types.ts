/** Minimal subset of the Home Assistant frontend types we actually rely on. */

export interface HassEntity {
  entity_id: string;
  state: string;
  attributes: Record<string, any>;
  last_changed: string;
  last_updated: string;
}

export interface HomeAssistant {
  states: Record<string, HassEntity>;
  user?: { id: string; name: string; is_admin: boolean };
  themes?: { darkMode?: boolean };
  language?: string;
  connection: {
    subscribeMessage<T>(
      callback: (message: T) => void,
      subscribeMessage: Record<string, unknown>,
    ): Promise<() => Promise<void>>;
  };
  callService(
    domain: string,
    service: string,
    serviceData?: Record<string, unknown>,
    target?: Record<string, unknown>,
  ): Promise<unknown>;
  formatEntityState?(entity: HassEntity): string;
}

export type NotificationType = 'success' | 'warning' | 'progress';
export type CardStyle = 'fullscreen' | 'pill';
export type ThemeMode = 'auto' | 'light' | 'dark';

export interface ActionConfig {
  action:
    | 'none'
    | 'navigate'
    | 'url'
    | 'call-service'
    | 'perform-action'
    | 'more-info'
    | 'toggle';
  navigation_path?: string;
  url_path?: string;
  service?: string;
  perform_action?: string;
  data?: Record<string, unknown>;
  service_data?: Record<string, unknown>;
  target?: Record<string, unknown>;
  entity?: string;
}

/** HA-compatible condition schema (subset) plus a `template` condition. */
export interface ConditionConfig {
  condition?:
    | 'state'
    | 'numeric_state'
    | 'screen'
    | 'user'
    | 'template'
    | 'and'
    | 'or'
    | 'not';
  entity?: string;
  attribute?: string;
  state?: string | number | (string | number)[];
  state_not?: string | number | (string | number)[];
  above?: number | string;
  below?: number | string;
  media_query?: string;
  users?: string[];
  value_template?: string;
  conditions?: ConditionConfig[];
}

export interface NotificationConfig {
  /** Stable identity. Auto-derived from the index when omitted. */
  id?: string;
  type: NotificationType;
  title: string;
  message?: string;
  /** Icon override. Defaults to the icon of `entity`, then a per-type fallback. */
  icon?: string;
  /** Entity used for the default icon/title and for shorthand conditions. */
  entity?: string;
  /** Any CSS colour. Defaults to a per-type theme colour. */
  color?: string;
  /** `true` to tint the backdrop with `color`, or an explicit CSS colour. */
  tint?: boolean | string;
  /** Per-notification override of the global visible duration, in seconds. */
  duration?: number;
  /** Progress ring target: a number, an entity id, or a Jinja template. */
  progress?: number | string;
  /** Value that represents 100%. Defaults to 100, or the entity's `max` attribute. */
  progress_max?: number | string;
  /** Shorthand condition: required state of `entity`. */
  state?: string | number | (string | number)[];
  /** Full condition list. ANDed together. */
  condition?: ConditionConfig | ConditionConfig[];
  /** Minimum seconds between two showings of this notification. */
  cooldown?: number;
  /** Show immediately if the condition is already true when the page loads. */
  trigger_on_load?: boolean;
  /** Abort a showing notification if its condition stops being true. */
  cancel_if_condition_clears?: boolean;
  tap_action?: ActionConfig;
  /** Set false to always deliver immediately, ignoring the card's gate. */
  hold?: boolean;
  /** Delivery gate for this notification, replacing the card-level one. */
  deliver_when?: ConditionConfig | ConditionConfig[];
}

export interface FullscreenNotificationCardConfig {
  type: string;
  /** Presentation style for every notification on this card. */
  style?: CardStyle;
  /** Overlay/pill colour scheme. */
  theme?: ThemeMode;
  /** Seconds each notification stays on screen. */
  duration?: number;
  /** Backdrop blur radius in px. */
  backdrop_blur?: number;
  /** Backdrop opacity, 0 to 1. */
  backdrop_opacity?: number;
  /** Show the blurred/dimmed backdrop behind pill notifications too. */
  pill_backdrop?: boolean;
  /** Seconds of quiet between queued notifications. */
  gap?: number;
  /** Tapping a notification dismisses it early. */
  dismiss_on_tap?: boolean;
  /** Honour the OS "reduce motion" setting. */
  respect_reduced_motion?: boolean;
  /** Log trigger evaluation to the browser console. */
  debug?: boolean;

  /** Shorthand delivery gate: the entity whose state releases held notifications. */
  deliver_entity?: string;
  /** Shorthand delivery gate: the state of `deliver_entity` that releases them. */
  deliver_state?: string | number | (string | number)[];
  /** Full delivery gate. ANDed with the shorthand above. */
  deliver_when?: ConditionConfig | ConditionConfig[];
  /** Seconds a held notification stays valid. 0, the default, means forever. */
  hold_expiry?: number;
  /** Most notifications to hold at once. The oldest are dropped first. */
  max_held?: number;

  notifications?: NotificationConfig[];
}

/** A notification resolved against current state, ready to be displayed. */
export interface ResolvedNotification {
  key: string;
  config: NotificationConfig;
  type: NotificationType;
  title: string;
  message?: string;
  /** Explicit icon, if one was configured or resolved from a template. */
  icon?: string;
  /** Entity to draw the icon from when no explicit icon was given. */
  stateObj?: HassEntity;
  color: string;
  tint?: string;
  duration: number;
  progress: number;
  /** When the notification was triggered, which is what held ones are aged by. */
  firedAt: number;
}

export interface LovelaceCard extends HTMLElement {
  hass?: HomeAssistant;
  setConfig(config: Record<string, unknown>): void;
  getCardSize?(): number | Promise<number>;
}

export interface LovelaceCardEditor extends HTMLElement {
  hass?: HomeAssistant;
  setConfig(config: Record<string, unknown>): void;
}
