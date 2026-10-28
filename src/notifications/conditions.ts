import type {
  ConditionConfig,
  FullscreenNotificationCardConfig,
  HomeAssistant,
  NotificationConfig,
} from './types';
import { isTemplate } from './templates';

const asArray = <T>(value: T | T[] | undefined): T[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];

const truthy = (value: unknown): boolean =>
  value === true ||
  value === 1 ||
  (typeof value === 'string' && ['true', 'on', 'yes', '1'].includes(value.trim().toLowerCase()));

/** Resolve a bound that may be a literal number or an entity id holding one. */
const resolveBound = (
  bound: number | string | undefined,
  hass: HomeAssistant,
): number | undefined => {
  if (bound === undefined) {
    return undefined;
  }
  if (typeof bound === 'number') {
    return bound;
  }
  const numeric = Number(bound);
  if (!Number.isNaN(numeric) && bound.trim() !== '') {
    return numeric;
  }
  const state = hass.states[bound]?.state;
  const fromEntity = Number(state);
  return Number.isNaN(fromEntity) ? undefined : fromEntity;
};

const currentValue = (
  hass: HomeAssistant,
  entityId: string | undefined,
  attribute?: string,
): unknown => {
  if (!entityId) {
    return undefined;
  }
  const entity = hass.states[entityId];
  if (!entity) {
    return undefined;
  }
  return attribute ? entity.attributes?.[attribute] : entity.state;
};

/**
 * Normalise the shorthand forms (`entity` + `state`, `entity` + `above`) into
 * an explicit condition so the evaluator only has to handle one shape.
 */
const inferCondition = (condition: ConditionConfig): ConditionConfig['condition'] => {
  if (condition.condition) {
    return condition.condition;
  }
  if (condition.above !== undefined || condition.below !== undefined) {
    return 'numeric_state';
  }
  if (condition.value_template !== undefined) {
    return 'template';
  }
  if (condition.media_query !== undefined) {
    return 'screen';
  }
  if (condition.users !== undefined) {
    return 'user';
  }
  return 'state';
};

export interface EvaluationContext {
  hass: HomeAssistant;
  /** Resolved values for any Jinja templates, keyed by the template source. */
  template: (template: string) => unknown;
}

export const checkCondition = (
  condition: ConditionConfig,
  ctx: EvaluationContext,
): boolean => {
  const { hass } = ctx;

  switch (inferCondition(condition)) {
    case 'and':
      return (condition.conditions ?? []).every((c) => checkCondition(c, ctx));

    case 'or':
      return (condition.conditions ?? []).some((c) => checkCondition(c, ctx));

    case 'not':
      return !(condition.conditions ?? []).some((c) => checkCondition(c, ctx));

    case 'screen':
      return condition.media_query
        ? window.matchMedia(condition.media_query).matches
        : true;

    case 'user':
      return !condition.users?.length || condition.users.includes(hass.user?.id ?? '');

    case 'template':
      return condition.value_template
        ? truthy(ctx.template(condition.value_template))
        : false;

    case 'numeric_state': {
      const raw = currentValue(hass, condition.entity, condition.attribute);
      const value = Number(raw);
      if (Number.isNaN(value)) {
        return false;
      }
      const above = resolveBound(condition.above, hass);
      const below = resolveBound(condition.below, hass);
      if (above !== undefined && !(value > above)) {
        return false;
      }
      if (below !== undefined && !(value < below)) {
        return false;
      }
      return above !== undefined || below !== undefined;
    }

    case 'state':
    default: {
      const raw = currentValue(hass, condition.entity, condition.attribute);
      if (raw === undefined) {
        return false;
      }
      const actual = String(raw);
      const wanted = asArray(condition.state).map(String);
      const unwanted = asArray(condition.state_not).map(String);

      if (wanted.length && !wanted.includes(actual)) {
        return false;
      }
      if (unwanted.length && unwanted.includes(actual)) {
        return false;
      }
      return wanted.length > 0 || unwanted.length > 0;
    }
  }
};

/** Every condition attached to a notification, including the shorthand form. */
export const conditionsFor = (notification: NotificationConfig): ConditionConfig[] => {
  // Copy first: for a list-valued `condition`, asArray hands back the caller's
  // own array, and unshifting into that would mutate the stored config - adding
  // another copy of the shorthand condition on every single state update.
  const conditions = [...asArray(notification.condition)];
  if (notification.state !== undefined && notification.entity) {
    conditions.unshift({
      condition: 'state',
      entity: notification.entity,
      state: notification.state,
    });
  }
  return conditions;
};

export const checkNotification = (
  notification: NotificationConfig,
  ctx: EvaluationContext,
): boolean => {
  const conditions = conditionsFor(notification);
  // A notification with no condition can never fire on its own; it is only
  // reachable through the editor preview or a manual trigger.
  return conditions.length > 0 && conditions.every((c) => checkCondition(c, ctx));
};

/**
 * The gate a notification has to pass before it is allowed on screen. A
 * notification's own `deliver_when` replaces the card's gate rather than adding
 * to it, so a single notification can opt into a different rule entirely.
 */
export const deliveryConditions = (
  config: FullscreenNotificationCardConfig,
  notification?: NotificationConfig,
): ConditionConfig[] => {
  if (notification?.deliver_when !== undefined) {
    return asArray(notification.deliver_when);
  }

  const conditions = [...asArray(config.deliver_when)];
  if (config.deliver_state !== undefined && config.deliver_entity) {
    conditions.unshift({
      condition: 'state',
      entity: config.deliver_entity,
      state: config.deliver_state,
    });
  }
  return conditions;
};

/**
 * Unlike a trigger, an empty gate means "deliver now": a card with no delivery
 * conditions must behave exactly as it did before the gate existed.
 */
export const canDeliver = (
  config: FullscreenNotificationCardConfig,
  notification: NotificationConfig | undefined,
  ctx: EvaluationContext,
): boolean => {
  if (notification?.hold === false) {
    return true;
  }
  return deliveryConditions(config, notification).every((c) => checkCondition(c, ctx));
};

/** Every Jinja template referenced by the card-level delivery gate. */
export const collectCardTemplates = (
  config: FullscreenNotificationCardConfig,
): string[] => {
  const found: string[] = [];
  const walk = (condition: ConditionConfig): void => {
    if (condition.value_template && isTemplate(condition.value_template)) {
      found.push(condition.value_template);
    }
    condition.conditions?.forEach(walk);
  };
  deliveryConditions(config).forEach(walk);
  return found;
};

/** Collect every Jinja template referenced anywhere in a notification. */
export const collectTemplates = (notification: NotificationConfig): string[] => {
  const found: string[] = [];

  const walk = (condition: ConditionConfig): void => {
    if (condition.value_template && isTemplate(condition.value_template)) {
      found.push(condition.value_template);
    }
    condition.conditions?.forEach(walk);
  };
  conditionsFor(notification).forEach(walk);
  asArray(notification.deliver_when).forEach(walk);

  for (const value of [
    notification.title,
    notification.message,
    notification.icon,
    notification.progress,
    notification.progress_max,
  ]) {
    if (isTemplate(value)) {
      found.push(value);
    }
  }

  return found;
};
