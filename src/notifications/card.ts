import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import './overlay';
import type { FsnOverlay, Presentation } from './overlay';
import {
  canDeliver,
  checkNotification,
  collectCardTemplates,
  collectTemplates,
  type EvaluationContext,
} from './conditions';
import { TemplateSubscriber } from './templates';
import {
  DEFAULTS,
  isDarkMode,
  notificationKey,
  prefersReducedMotion,
  resolveNotification,
} from './resolve';
import type {
  ActionConfig,
  FullscreenNotificationCardConfig,
  HomeAssistant,
  NotificationConfig,
  ResolvedNotification,
} from './types';

interface TriggerState {
  /** Result of the previous evaluation; undefined until the first one. */
  last?: boolean;
  lastFiredAt: number;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

@customElement('homeview-notification-card')
export class FullscreenNotificationCard extends LitElement {
  @property({ attribute: false }) public preview = false;

  @state() private _config?: FullscreenNotificationCardConfig;
  @state() private _editMode = false;

  private _hass?: HomeAssistant;
  private _overlay?: FsnOverlay;
  private _templates = new TemplateSubscriber(() => this._evaluate());
  private _triggers = new Map<string, TriggerState>();
  private _queue: ResolvedNotification[] = [];
  /** Triggered but not yet allowed on screen, oldest first. */
  private _held: ResolvedNotification[] = [];
  private _running = false;
  private _current?: { key: string; presentation: Presentation };

  public static async getConfigElement(): Promise<HTMLElement> {
    await import('./editor');
    return document.createElement('homeview-notification-card-editor');
  }

  public static getStubConfig(): FullscreenNotificationCardConfig {
    return {
      type: 'custom:homeview-notification-card',
      style: 'fullscreen',
      duration: 5,
      notifications: [],
    };
  }

  public setConfig(config: FullscreenNotificationCardConfig): void {
    if (!config) {
      throw new Error('Invalid configuration');
    }
    const notifications = config.notifications ?? [];
    if (!Array.isArray(notifications)) {
      throw new Error('`notifications` must be a list');
    }
    notifications.forEach((notification, index) => {
      if (!notification || typeof notification !== 'object') {
        throw new Error(`Notification ${index + 1} is not a mapping`);
      }
      if (!['success', 'warning', 'progress'].includes(notification.type)) {
        throw new Error(
          `Notification ${index + 1} needs a \`type\` of success, warning or progress`,
        );
      }
      if (!notification.title) {
        throw new Error(`Notification ${index + 1} needs a \`title\``);
      }
    });

    this._config = { ...config, notifications };
    // Everything pending belongs to the old config: its keys may no longer
    // exist, and its snapshots were resolved against settings that have since
    // changed. Re-baseline rather than deliver something orphaned.
    this._triggers.clear();
    this._queue = [];
    this._held = [];
    this._syncTemplates();
  }

  public set hass(hass: HomeAssistant) {
    this._hass = hass;
    this._templates.setHass(hass);
    this._evaluate();
  }

  public get hass(): HomeAssistant | undefined {
    return this._hass;
  }

  public getCardSize(): number {
    return 1;
  }

  public getGridOptions(): Record<string, unknown> {
    return { rows: 1, columns: 12, min_rows: 1 };
  }

  public connectedCallback(): void {
    super.connectedCallback();
    this._editMode = this._detectEditMode();
    this._ensureOverlay();
  }

  /**
   * Portalled out of the dashboard so the surface is measured against the
   * viewport rather than a transformed Sections container. Created on demand as
   * well as on connect, so a notification that fires before the card is
   * attached is not silently dropped.
   */
  private _ensureOverlay(): FsnOverlay {
    if (!this._overlay) {
      this._overlay = document.createElement('homeview-notification-overlay');
    }
    if (!this._overlay.isConnected) {
      document.body.appendChild(this._overlay);
    }
    return this._overlay;
  }

  private _log(...args: unknown[]): void {
    if (this._config?.debug) {
      // eslint-disable-next-line no-console
      console.debug('[homeview-notification-card]', ...args);
    }
  }

  public disconnectedCallback(): void {
    super.disconnectedCallback();
    this._current?.presentation.dismiss();
    this._queue = [];
    this._held = [];
    this._running = false;
    this._templates.destroy();
    this._overlay?.abort();
    this._overlay?.remove();
  }

  // --- triggering --------------------------------------------------------

  private _syncTemplates(): void {
    const config = this._config;
    if (!config) {
      this._templates.sync([]);
      return;
    }
    this._templates.sync([
      ...collectCardTemplates(config),
      ...(config.notifications ?? []).flatMap(collectTemplates),
    ]);
  }

  private _evaluate(): void {
    const config = this._config;
    const hass = this._hass;
    if (!config || !hass || this._editMode || this.preview) {
      return;
    }
    // Hold off until every template has reported once, otherwise a
    // half-resolved condition can fire a spurious notification on page load.
    if (!this._templates.isReady()) {
      return;
    }

    const ctx = {
      hass,
      template: (template: string) => this._templates.get(template),
    };

    (config.notifications ?? []).forEach((notification, index) => {
      const key = notificationKey(notification, index);
      const trigger = this._triggers.get(key) ?? { lastFiredAt: 0 };
      const now = checkNotification(notification, ctx);
      const first = trigger.last === undefined;

      const rising = first
        ? now && notification.trigger_on_load === true
        : now && !trigger.last;

      trigger.last = now;
      this._triggers.set(key, trigger);

      this._log('evaluate', key, { now, first, rising });

      if (rising) {
        this._fire(notification, key, trigger, ctx);
      } else if (
        !now &&
        notification.cancel_if_condition_clears &&
        this._current?.key === key
      ) {
        this._current.presentation.dismiss();
      }
    });

    this._reconcile(config, ctx);
  }

  /**
   * Move notifications between the hold and the display queue as the delivery
   * gate opens and closes, then drop anything that has waited too long.
   *
   * Runs on every state update rather than only on the gate's rising edge, so a
   * card that is reconfigured, or one whose gate was already open when a
   * notification was held, still catches up.
   */
  private _reconcile(
    config: FullscreenNotificationCardConfig,
    ctx: EvaluationContext,
  ): void {
    const deliverable = (notification: ResolvedNotification): boolean =>
      canDeliver(config, notification.config, ctx);

    // Anything queued but not yet shown goes back on hold if its gate shut -
    // walking out of the room should stop the rest of the sequence.
    const staying = this._queue.filter((notification) => {
      if (deliverable(notification)) {
        return true;
      }
      this._log('re-hold', notification.key);
      this._held.push(notification);
      return false;
    });
    this._queue = staying;

    // Age the hold out before releasing anything: a notification that sat past
    // its expiry must be dropped, not delivered the moment the gate opens.
    this._trimHeld(config);

    const releasing = this._held.filter(deliverable);
    if (releasing.length) {
      this._held = this._held.filter((n) => !releasing.includes(n));
      // Oldest first, so a backlog plays back in the order it happened.
      releasing.sort((a, b) => a.firedAt - b.firedAt);
      this._queue.push(...releasing);
      this._log('release', releasing.map((n) => n.key));
    }

    if (this._queue.length) {
      void this._pump();
    }
  }

  private _trimHeld(config: FullscreenNotificationCardConfig): void {
    const expiry = (config.hold_expiry ?? DEFAULTS.hold_expiry) * 1000;
    if (expiry > 0) {
      const cutoff = Date.now() - expiry;
      this._held = this._held.filter((notification) => {
        if (notification.firedAt >= cutoff) {
          return true;
        }
        this._log('expired', notification.key);
        return false;
      });
    }

    const max = config.max_held ?? DEFAULTS.max_held;
    if (max > 0 && this._held.length > max) {
      const dropped = this._held.splice(0, this._held.length - max);
      this._log('dropped', dropped.map((n) => n.key));
    }
  }

  private _fire(
    notification: NotificationConfig,
    key: string,
    trigger: TriggerState,
    ctx: EvaluationContext,
  ): void {
    const cooldown = (notification.cooldown ?? 0) * 1000;
    if (cooldown && Date.now() - trigger.lastFiredAt < cooldown) {
      return;
    }
    // Already on screen, waiting its turn, or already on hold: no duplicates.
    if (
      this._current?.key === key ||
      this._queue.some((q) => q.key === key) ||
      this._held.some((q) => q.key === key)
    ) {
      return;
    }
    trigger.lastFiredAt = Date.now();
    this._log('fire', key);
    this.enqueue(notification, key, ctx);
  }

  /**
   * Take a notification that has just triggered and either queue it for display
   * or put it on hold.
   *
   * It is resolved here rather than at delivery time on purpose: a held
   * notification is a record of something that already happened, so its title,
   * message and progress are a snapshot of the moment it fired, not of whenever
   * somebody finally walks into the room.
   */
  public enqueue(
    notification: NotificationConfig,
    key: string,
    ctx?: EvaluationContext,
  ): void {
    const config = this._config;
    if (!config) {
      return;
    }

    const resolved = resolveNotification(notification, key, config, this._hass, (template) =>
      this._templates.get(template),
    );

    const context =
      ctx ??
      (this._hass
        ? { hass: this._hass, template: (t: string) => this._templates.get(t) }
        : undefined);

    if (context && !canDeliver(config, notification, context)) {
      this._held.push(resolved);
      this._trimHeld(config);
      this._log('held', key, { held: this._held.length });
      return;
    }

    this._queue.push(resolved);
    void this._pump();
  }

  // --- presentation ------------------------------------------------------

  private async _pump(): Promise<void> {
    if (this._running) {
      return;
    }
    this._running = true;
    try {
      while (this._queue.length) {
        const next = this._queue.shift()!;
        await this._present(next);
        if (this._queue.length) {
          await sleep((this._config?.gap ?? DEFAULTS.gap) * 1000);
        }
      }
    } finally {
      this._running = false;
      this._current = undefined;
    }
  }

  private async _present(notification: ResolvedNotification): Promise<void> {
    const config = this._config;
    if (!config) {
      return;
    }
    const overlay = this._ensureOverlay();

    const reduced =
      (config.respect_reduced_motion ?? DEFAULTS.respect_reduced_motion) &&
      prefersReducedMotion();

    const presentation = overlay.present(notification, {
      hass: this._hass,
      style: config.style ?? DEFAULTS.style,
      dark: isDarkMode(config.theme ?? DEFAULTS.theme, this._hass),
      backdrop: config.pill_backdrop ?? DEFAULTS.pill_backdrop,
      blur: config.backdrop_blur ?? DEFAULTS.backdrop_blur,
      opacity: config.backdrop_opacity ?? DEFAULTS.backdrop_opacity,
      reduced,
      dismissOnTap: config.dismiss_on_tap ?? DEFAULTS.dismiss_on_tap,
      onTap: notification.config.tap_action
        ? () => this._runAction(notification.config.tap_action!, notification)
        : undefined,
    });

    this._current = { key: notification.key, presentation };
    this._log('present', notification.key, {
      style: config.style ?? DEFAULTS.style,
      duration: notification.duration,
      attached: overlay.isConnected,
    });

    try {
      await presentation.done;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[homeview-notification-card] failed to show', notification.key, err);
    }
    this._current = undefined;
  }

  // --- tap actions -------------------------------------------------------

  private _runAction(action: ActionConfig, notification: ResolvedNotification): void {
    const hass = this._hass;
    const entityId = action.entity ?? notification.config.entity;

    switch (action.action) {
      case 'navigate':
        if (action.navigation_path) {
          history.pushState(null, '', action.navigation_path);
          this.dispatchEvent(
            new CustomEvent('location-changed', { bubbles: true, composed: true }),
          );
        }
        break;

      case 'url':
        if (action.url_path) {
          window.open(action.url_path, '_blank', 'noreferrer');
        }
        break;

      case 'toggle':
        if (hass && entityId) {
          void hass.callService('homeassistant', 'toggle', { entity_id: entityId });
        }
        break;

      case 'more-info':
        if (entityId) {
          // Fired from the card, which still sits inside <home-assistant>; the
          // portalled overlay is a sibling of it and would not be heard.
          this.dispatchEvent(
            new CustomEvent('hass-more-info', {
              detail: { entityId },
              bubbles: true,
              composed: true,
            }),
          );
        }
        break;

      case 'call-service':
      case 'perform-action': {
        const target = action.perform_action ?? action.service;
        if (hass && target?.includes('.')) {
          const [domain, service] = target.split('.', 2);
          void hass.callService(
            domain,
            service,
            action.data ?? action.service_data ?? {},
            action.target,
          );
        }
        break;
      }

      default:
        break;
    }
  }

  // --- edit mode ---------------------------------------------------------

  /**
   * The card is invisible in normal use, which makes it impossible to select
   * while editing a dashboard. `hui-card-options` only wraps cards in edit
   * mode, so its presence up the (shadow-crossing) tree is a reliable signal.
   */
  private _detectEditMode(): boolean {
    let node: Node | null = this;
    for (let depth = 0; node && depth < 20; depth++) {
      const name = (node as HTMLElement).localName;
      if (name === 'hui-card-options' || name === 'hui-card-edit-mode') {
        return true;
      }
      node =
        (node as HTMLElement).parentElement ??
        ((node.getRootNode() as ShadowRoot).host as Node | undefined) ??
        null;
    }
    return false;
  }

  protected updated(): void {
    // `hidden` is how the built-in conditional card disappears, and both the
    // masonry and sections layouts already collapse a hidden card's slot.
    this.hidden = !this._editMode && !this.preview;
  }

  protected render(): TemplateResult | typeof nothing {
    if (!this._editMode && !this.preview) {
      return nothing;
    }

    const count = this._config?.notifications?.length ?? 0;
    return html`
      <ha-card>
        <div class="placeholder">
          <ha-icon icon="mdi:bell-badge-outline"></ha-icon>
          <div>
            <div class="name">Fullscreen Notification</div>
            <div class="hint">
              ${count} notification${count === 1 ? '' : 's'} &middot; hidden on the live
              dashboard
            </div>
          </div>
        </div>
      </ha-card>
    `;
  }

  static styles = css`
    :host {
      display: block;
    }

    :host([hidden]) {
      display: none !important;
    }

    .placeholder {
      display: flex;
      align-items: center;
      gap: 14px;
      padding: 14px 16px;
    }

    .placeholder ha-icon {
      color: var(--secondary-text-color);
      --mdc-icon-size: 26px;
    }

    .name {
      font-weight: 500;
    }

    .hint {
      font-size: 12px;
      color: var(--secondary-text-color);
    }
  `;
}

declare global {
  interface HTMLElementTagNameMap {
    'homeview-notification-card': FullscreenNotificationCard;
  }
}
