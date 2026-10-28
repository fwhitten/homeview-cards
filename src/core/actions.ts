import type { ActionConfig, HomeAssistant } from './types';
import { fireEvent, haptic, navigate } from './events';
import { openPopup } from './popup-bus';

export interface ActionContext {
  /** The element the action came from. Events bubble from here. */
  node: HTMLElement;
  hass: HomeAssistant;
  /** The card's main entity, used when the action names none. */
  entity?: string;
  /** The pop-up a `homeview-popup` action opens when it names none. */
  popup?: string;
  /** The full card config, handed to the pop-up. */
  config?: Record<string, unknown>;
}

const confirmed = async (action: ActionConfig): Promise<boolean> => {
  if (!action.confirmation) return true;
  const text =
    typeof action.confirmation === 'object' && action.confirmation.text
      ? action.confirmation.text
      : 'Are you sure?';
  const helpers = await window.loadCardHelpers?.().catch(() => undefined);
  const dialog = (helpers as { showConfirmationDialog?: (el: HTMLElement, p: object) => Promise<boolean> } | undefined)
    ?.showConfirmationDialog;
  return dialog ? dialog(document.body, { text }) : window.confirm(text);
};

/** Run a HA action config. Mirrors the frontend's handle-action, plus `homeview-popup`. */
export const runAction = async (ctx: ActionContext, action: ActionConfig | undefined): Promise<void> => {
  if (!action || action.action === 'none') return;
  if (!(await confirmed(action))) return;
  const entity = action.entity ?? ctx.entity;
  switch (action.action) {
    case 'more-info':
      if (entity) fireEvent(ctx.node, 'hass-more-info', { entityId: entity });
      break;
    case 'toggle':
      if (entity) {
        haptic('light');
        await ctx.hass.callService('homeassistant', 'toggle', { entity_id: entity });
      }
      break;
    case 'navigate':
      if (action.navigation_path) navigate(action.navigation_path, action.navigation_replace);
      break;
    case 'url':
      if (action.url_path) window.open(action.url_path, '_blank', 'noopener');
      break;
    case 'perform-action':
    case 'call-service': {
      const name = action.perform_action ?? action.service;
      if (!name) break;
      const [domain, service] = name.split('.', 2);
      haptic('light');
      await ctx.hass.callService(domain, service, action.data ?? action.service_data, action.target);
      break;
    }
    case 'homeview-popup': {
      const popup = action.popup ?? ctx.popup;
      if (popup) openPopup(popup, { entity, config: ctx.config ?? {} });
      break;
    }
  }
};
