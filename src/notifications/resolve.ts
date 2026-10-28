import { isTemplate } from './templates';
import type {
  FullscreenNotificationCardConfig,
  HomeAssistant,
  NotificationConfig,
  NotificationType,
  ResolvedNotification,
  ThemeMode,
} from './types';

export const DEFAULTS = {
  style: 'fullscreen',
  theme: 'auto' as ThemeMode,
  duration: 5,
  backdrop_blur: 14,
  backdrop_opacity: 0.6,
  pill_backdrop: false,
  gap: 0.4,
  hold_expiry: 0,
  max_held: 10,
  dismiss_on_tap: true,
  respect_reduced_motion: true,
} as const;

export const TYPE_COLOR: Record<NotificationType, string> = {
  success: 'var(--success-color, #43a047)',
  warning: 'var(--warning-color, #ffa600)',
  progress: 'var(--primary-color, #03a9f4)',
};

/**
 * Home Assistant's colour picker yields theme tokens ("red", "primary") rather
 * than CSS colours, so map those onto the matching theme variable. Anything
 * else is passed through untouched, which keeps hex, rgb() and var() working.
 */
const HA_COLOR_TOKENS = new Set([
  'primary',
  'accent',
  'disabled',
  'red',
  'pink',
  'purple',
  'deep-purple',
  'indigo',
  'blue',
  'light-blue',
  'cyan',
  'teal',
  'green',
  'light-green',
  'lime',
  'yellow',
  'amber',
  'orange',
  'deep-orange',
  'brown',
  'light-grey',
  'grey',
  'dark-grey',
  'blue-grey',
  'black',
  'white',
]);

export const normalizeColor = (color: string): string =>
  HA_COLOR_TOKENS.has(color) ? `var(--${color}-color)` : color;

export const notificationKey = (
  notification: NotificationConfig,
  index: number,
): string => notification.id ?? `${notification.type}:${notification.title}:${index}`;

/** Whether the overlay should use its near-black or near-white palette. */
export const isDarkMode = (mode: ThemeMode, hass?: HomeAssistant): boolean => {
  if (mode === 'dark') {
    return true;
  }
  if (mode === 'light') {
    return false;
  }
  if (typeof hass?.themes?.darkMode === 'boolean') {
    return hass.themes.darkMode;
  }
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
};

export const prefersReducedMotion = (): boolean =>
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

type TemplateLookup = (template: string) => unknown;

const text = (
  value: string | undefined,
  template: TemplateLookup,
): string | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (!isTemplate(value)) {
    return value;
  }
  const result = template(value);
  return result === undefined || result === null ? '' : String(result);
};

/**
 * Turn a progress setting into a number. Accepts a literal, an entity id whose
 * state carries the value, or a Jinja template.
 */
const numeric = (
  value: number | string | undefined,
  hass: HomeAssistant | undefined,
  template: TemplateLookup,
): number | undefined => {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (isTemplate(value)) {
    const parsed = Number(template(value));
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  const literal = Number(value);
  if (Number.isFinite(literal)) {
    return literal;
  }
  const parsed = Number(hass?.states[value]?.state);
  return Number.isFinite(parsed) ? parsed : undefined;
};

export const resolveNotification = (
  notification: NotificationConfig,
  key: string,
  config: FullscreenNotificationCardConfig,
  hass: HomeAssistant | undefined,
  template: TemplateLookup,
): ResolvedNotification => {
  const stateObj = notification.entity ? hass?.states[notification.entity] : undefined;
  const color = notification.color
    ? normalizeColor(notification.color)
    : TYPE_COLOR[notification.type];

  let tint: string | undefined;
  if (notification.tint === true) {
    tint = color;
  } else if (typeof notification.tint === 'string' && notification.tint !== '') {
    tint = normalizeColor(notification.tint);
  }

  let progress = 0;
  if (notification.type === 'progress') {
    const value =
      numeric(notification.progress, hass, template) ??
      (stateObj ? Number(stateObj.state) : undefined) ??
      0;
    const max =
      numeric(notification.progress_max, hass, template) ??
      Number(stateObj?.attributes?.max) ??
      100;
    const span = Number.isFinite(max) && max !== 0 ? max : 100;
    progress = Math.max(0, Math.min(100, (value / span) * 100));
  }

  return {
    key,
    config: notification,
    type: notification.type,
    title: text(notification.title, template) ?? '',
    message: text(notification.message, template) || undefined,
    icon: text(notification.icon, template) || undefined,
    stateObj,
    color,
    tint,
    duration: notification.duration ?? config.duration ?? DEFAULTS.duration,
    progress,
    firedAt: Date.now(),
  };
};
