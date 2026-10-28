import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import './overlay';
import type { FsnOverlay } from './overlay';
import { collectTemplates } from './conditions';
import { TemplateSubscriber } from './templates';
import {
  DEFAULTS,
  isDarkMode,
  notificationKey,
  prefersReducedMotion,
  resolveNotification,
} from './resolve';
import type {
  FullscreenNotificationCardConfig,
  HomeAssistant,
  NotificationConfig,
} from './types';

type ProgressMode = 'entity' | 'value';

const ENTITY_ID = /^[a-z_]+\.[a-z0-9_]+$/;

const LABELS: Record<string, string> = {
  style: 'Notification style',
  theme: 'Colour scheme',
  duration: 'Visible for',
  gap: 'Gap between notifications',
  backdrop_blur: 'Backdrop blur',
  backdrop_opacity: 'Backdrop opacity',
  pill_backdrop: 'Show backdrop behind pill notifications',
  dismiss_on_tap: 'Dismiss when tapped',
  respect_reduced_motion: 'Respect "reduce motion"',
  debug: 'Log trigger evaluation to the console',
  deliver_entity: 'Only show notifications when this entity',
  deliver_state: 'is in this state',
  hold_expiry: 'Discard held notifications after',
  max_held: 'Most notifications to hold',
  type: 'Type',
  title: 'Title',
  message: 'Message',
  entity: 'Trigger entity',
  icon: 'Icon',
  color: 'Colour',
  state: 'Trigger when the entity state is',
  cooldown: 'Minimum time between repeats',
  trigger_on_load: 'Also trigger if already true when the page loads',
  cancel_if_condition_clears: 'Hide early if the condition stops being true',
  progress: 'Progress value',
  progress_max: 'Value that means 100%',
  tint: 'Tint the backdrop with the notification colour',
  tap_action: 'Tap action',
};

const HELPERS: Record<string, string> = {
  duration: 'Seconds each notification stays on screen.',
  entity: 'The subject of the simple trigger below, and the source of the icon.',
  icon: "Leave empty to use the trigger entity's icon.",
  state: 'Pick a known state, or type any value. Leave empty to use the advanced conditions below.',
  progress_max: 'Defaults to the entity max attribute, or 100.',
  deliver_entity:
    'Leave empty to show every notification the moment it triggers. Otherwise they wait here until this is true, then play in sequence.',
  hold_expiry: 'Seconds. 0 keeps a held notification until it is delivered.',
  max_held: 'When more pile up than this, the oldest are dropped.',
};

const GLOBAL_SCHEMA = [
  {
    type: 'grid',
    name: '',
    schema: [
      {
        name: 'style',
        selector: {
          select: {
            mode: 'dropdown',
            options: [
              { value: 'fullscreen', label: 'Fullscreen' },
              { value: 'pill', label: 'Pill' },
            ],
          },
        },
      },
      {
        name: 'theme',
        selector: {
          select: {
            mode: 'dropdown',
            options: [
              { value: 'auto', label: 'Match Home Assistant' },
              { value: 'light', label: 'Light' },
              { value: 'dark', label: 'Dark' },
            ],
          },
        },
      },
      {
        name: 'duration',
        selector: { number: { min: 0.5, step: 0.5, mode: 'box', unit_of_measurement: 's' } },
      },
      {
        name: 'gap',
        selector: { number: { min: 0, step: 0.1, mode: 'box', unit_of_measurement: 's' } },
      },
    ],
  },
  {
    type: 'expandable',
    name: '',
    title: 'Backdrop',
    icon: 'mdi:blur',
    schema: [
      { name: 'backdrop_blur', selector: { number: { min: 0, max: 60, step: 1, mode: 'slider' } } },
      {
        name: 'backdrop_opacity',
        selector: { number: { min: 0, max: 1, step: 0.05, mode: 'slider' } },
      },
      { name: 'pill_backdrop', selector: { boolean: {} } },
    ],
  },
  {
    type: 'expandable',
    name: '',
    title: 'Behaviour',
    icon: 'mdi:tune',
    schema: [
      { name: 'dismiss_on_tap', selector: { boolean: {} } },
      { name: 'respect_reduced_motion', selector: { boolean: {} } },
      { name: 'debug', selector: { boolean: {} } },
    ],
  },
];

const S_DELIVER_ENTITY = [{ name: 'deliver_entity', selector: { entity: {} } }];
const S_DELIVER_STATE_TEXT = [{ name: 'deliver_state', selector: { text: {} } }];
const S_HOLD_LIMITS = [
  {
    type: 'grid',
    name: '',
    schema: [
      {
        name: 'hold_expiry',
        selector: { number: { min: 0, step: 60, mode: 'box', unit_of_measurement: 's' } },
      },
      { name: 'max_held', selector: { number: { min: 1, step: 1, mode: 'box' } } },
    ],
  },
];

const S_TYPE = [
  {
    name: 'type',
    required: true,
    selector: {
      select: {
        mode: 'dropdown',
        options: [
          { value: 'success', label: 'Success' },
          { value: 'warning', label: 'Warning' },
          { value: 'progress', label: 'Progress' },
        ],
      },
    },
  },
];
const S_TITLE = [{ name: 'title', required: true, selector: { text: {} } }];
const S_MESSAGE = [{ name: 'message', selector: { text: { multiline: true } } }];

const S_ICON_COLOUR = [
  {
    type: 'grid',
    name: '',
    schema: [
      { name: 'icon', selector: { icon: {} } },
      { name: 'color', selector: { ui_color: {} } },
    ],
  },
];

const S_ENTITY = [{ name: 'entity', selector: { entity: {} } }];
const S_STATE_TEXT = [{ name: 'state', selector: { text: {} } }];

const S_TIMING = [
  {
    type: 'grid',
    name: '',
    schema: [
      {
        name: 'cooldown',
        selector: { number: { min: 0, step: 1, mode: 'box', unit_of_measurement: 's' } },
      },
      {
        name: 'duration',
        selector: { number: { min: 0, step: 0.5, mode: 'box', unit_of_measurement: 's' } },
      },
    ],
  },
];

const S_TRIGGER_ON_LOAD = [{ name: 'trigger_on_load', selector: { boolean: {} } }];
const S_CANCEL_ON_CLEAR = [
  { name: 'cancel_if_condition_clears', selector: { boolean: {} } },
];

const S_PROGRESS_ENTITY = [{ name: 'progress', selector: { entity: {} } }];
const S_PROGRESS_TEXT = [{ name: 'progress', selector: { text: {} } }];
const S_PROGRESS_MAX = [{ name: 'progress_max', selector: { text: {} } }];

const S_TINT = [{ name: 'tint', selector: { boolean: {} } }];
const S_TAP_ACTION = [{ name: 'tap_action', selector: { ui_action: {} } }];

const fireConfigChanged = (element: HTMLElement, config: unknown): void => {
  element.dispatchEvent(
    new CustomEvent('config-changed', {
      detail: { config },
      bubbles: true,
      composed: true,
    }),
  );
};

@customElement('homeview-notification-card-editor')
export class FullscreenNotificationCardEditor extends LitElement {
  @state() private _config?: FullscreenNotificationCardConfig;
  @state() private _expanded = new Set<number>();
  @state() private _progressModes = new Map<number, ProgressMode>();

  private _hass?: HomeAssistant;
  private _overlay?: FsnOverlay;
  private _templates = new TemplateSubscriber(() => undefined);

  public setConfig(config: FullscreenNotificationCardConfig): void {
    this._config = { ...config, notifications: config.notifications ?? [] };
    this._templates.sync((this._config.notifications ?? []).flatMap(collectTemplates));
  }

  public set hass(hass: HomeAssistant) {
    this._hass = hass;
    this._templates.setHass(hass);
    this.requestUpdate();
  }

  public get hass(): HomeAssistant | undefined {
    return this._hass;
  }

  public disconnectedCallback(): void {
    super.disconnectedCallback();
    this._templates.destroy();
    this._overlay?.abort();
    this._overlay?.remove();
    this._overlay = undefined;
  }

  private _label = (schema: { name: string; title?: string }): string =>
    LABELS[schema.name] ?? schema.title ?? schema.name;

  private _helper = (schema: { name: string }): string | undefined => HELPERS[schema.name];

  protected render(): TemplateResult | typeof nothing {
    const config = this._config;
    if (!config || !this._hass) {
      return nothing;
    }

    const globals = {
      style: config.style ?? DEFAULTS.style,
      theme: config.theme ?? DEFAULTS.theme,
      duration: config.duration ?? DEFAULTS.duration,
      gap: config.gap ?? DEFAULTS.gap,
      backdrop_blur: config.backdrop_blur ?? DEFAULTS.backdrop_blur,
      backdrop_opacity: config.backdrop_opacity ?? DEFAULTS.backdrop_opacity,
      pill_backdrop: config.pill_backdrop ?? DEFAULTS.pill_backdrop,
      dismiss_on_tap: config.dismiss_on_tap ?? DEFAULTS.dismiss_on_tap,
      respect_reduced_motion:
        config.respect_reduced_motion ?? DEFAULTS.respect_reduced_motion,
      debug: config.debug ?? false,
    };

    return html`
      <ha-form
        .hass=${this._hass}
        .data=${globals}
        .schema=${GLOBAL_SCHEMA}
        .computeLabel=${this._label}
        .computeHelper=${this._helper}
        @value-changed=${this._globalsChanged}
      ></ha-form>

      ${this._renderDelivery(config)}

      <div class="section-title">Notifications</div>
      ${(config.notifications ?? []).map((notification, index) =>
        this._renderNotification(notification, index),
      )}

      <button class="add" type="button" @click=${this._add}>
        <ha-icon icon="mdi:plus"></ha-icon> Add notification
      </button>
    `;
  }

  private _renderDelivery(config: FullscreenNotificationCardConfig): TemplateResult {
    const data = {
      deliver_entity: config.deliver_entity,
      deliver_state: config.deliver_state,
      hold_expiry: config.hold_expiry ?? DEFAULTS.hold_expiry,
      max_held: config.max_held ?? DEFAULTS.max_held,
    };

    const form = (schema: unknown): TemplateResult => html`
      <ha-form
        .hass=${this._hass}
        .data=${data}
        .schema=${schema}
        .computeLabel=${this._label}
        .computeHelper=${this._helper}
        @value-changed=${this._globalsChanged}
      ></ha-form>
    `;

    return html`
      <ha-expansion-panel
        outlined
        left-chevron
        header="Delivery"
        @expanded-changed=${this._stopEvent}
      >
        <div class="fields">
          ${form(S_DELIVER_ENTITY)}
          ${form(this._deliverStateSchema(config.deliver_entity))}
          ${form(S_HOLD_LIMITS)}
        </div>

        <div class="yaml-label">
          Advanced delivery conditions
          <span class="yaml-hint">
            Home Assistant condition syntax. ANDed with the simple gate above.
          </span>
        </div>
        <ha-yaml-editor
          .hass=${this._hass}
          .defaultValue=${config.deliver_when ?? []}
          @value-changed=${this._deliverWhenChanged}
        ></ha-yaml-editor>
      </ha-expansion-panel>
    `;
  }

  private _deliverStateSchemas = new Map<string, unknown>();

  private _deliverStateSchema(entity?: string): unknown {
    if (!entity) {
      return S_DELIVER_STATE_TEXT;
    }
    let schema = this._deliverStateSchemas.get(entity);
    if (!schema) {
      schema = [{ name: 'deliver_state', selector: { state: { entity_id: entity } } }];
      this._deliverStateSchemas.set(entity, schema);
    }
    return schema;
  }

  private _deliverWhenChanged(ev: CustomEvent): void {
    ev.stopPropagation();
    if (ev.detail.isValid === false) {
      return;
    }
    const value = ev.detail.value;
    const empty = !value || (Array.isArray(value) && value.length === 0);
    this._emit(this._config?.notifications ?? [], {
      deliver_when: empty ? undefined : value,
    });
  }

  /**
   * One `ha-form` per field. ha-form hard-codes `margin-bottom: 24px` on every
   * `.root` child except the last, so a form holding a single item carries no
   * margin at all and this editor's own flex `gap` decides the spacing. The
   * obvious shortcut - retuning `--ha-space-6`, which ha-form-grid uses for its
   * row gap - is not safe: it is a global spacing token that ha-textarea and
   * friends also use for their internal padding.
   */
  private _form(
    notification: NotificationConfig,
    index: number,
    schema: unknown,
  ): TemplateResult {
    return html`
      <ha-form
        .hass=${this._hass}
        .data=${this._formData(notification)}
        .schema=${schema}
        .computeLabel=${this._label}
        .computeHelper=${this._helper}
        @value-changed=${(ev: CustomEvent) => this._notificationChanged(index, ev)}
      ></ha-form>
    `;
  }

  /**
   * Schemas are handed to ha-form by reference, so build the entity-dependent
   * ones once per entity rather than on every render - a fresh object each time
   * would rebuild the picker while someone is using it.
   */
  private _stateSchemas = new Map<string, unknown>();

  private _stateSchema(entity?: string): unknown {
    if (!entity) {
      return S_STATE_TEXT;
    }
    let schema = this._stateSchemas.get(entity);
    if (!schema) {
      schema = [{ name: 'state', selector: { state: { entity_id: entity } } }];
      this._stateSchemas.set(entity, schema);
    }
    return schema;
  }

  private _formData(notification: NotificationConfig): Record<string, unknown> {
    return {
      ...notification,
      // `tint` also accepts an explicit colour in YAML; the toggle only says
      // whether tinting is on, and an existing colour survives a change.
      tint: notification.tint !== undefined && notification.tint !== false,
    };
  }

  private _renderNotification(
    notification: NotificationConfig,
    index: number,
  ): TemplateResult {
    const last = (this._config?.notifications?.length ?? 1) - 1;

    return html`
      <ha-expansion-panel
        outlined
        .expanded=${this._expanded.has(index)}
        @expanded-changed=${(ev: CustomEvent) => this._panelToggled(index, ev)}
      >
        <div slot="header" class="header">
          <ha-icon class=${notification.type} icon=${this._headerIcon(notification)}></ha-icon>
          <span class="header-title">${notification.title || 'Untitled notification'}</span>
        </div>

        <div class="toolbar">
          <button type="button" title="Preview" @click=${() => this._preview(notification, index)}>
            <ha-icon icon="mdi:play-circle-outline"></ha-icon>
          </button>
          <span class="spacer"></span>
          <button type="button" title="Duplicate" @click=${() => this._duplicate(index)}>
            <ha-icon icon="mdi:content-copy"></ha-icon>
          </button>
          <button
            type="button"
            title="Move up"
            ?disabled=${index === 0}
            @click=${() => this._move(index, -1)}
          >
            <ha-icon icon="mdi:arrow-up"></ha-icon>
          </button>
          <button
            type="button"
            title="Move down"
            ?disabled=${index === last}
            @click=${() => this._move(index, 1)}
          >
            <ha-icon icon="mdi:arrow-down"></ha-icon>
          </button>
          <button type="button" title="Delete" class="danger" @click=${() => this._remove(index)}>
            <ha-icon icon="mdi:delete-outline"></ha-icon>
          </button>
        </div>

        <div class="fields">
          ${this._form(notification, index, S_TYPE)}
          ${this._form(notification, index, S_TITLE)}
          ${this._form(notification, index, S_MESSAGE)}
          ${this._form(notification, index, S_ICON_COLOUR)}
        </div>

        ${this._renderTrigger(notification, index)}
        ${notification.type === 'progress' ? this._renderProgress(notification, index) : nothing}

        <ha-expansion-panel
          class="sub"
          outlined
          left-chevron
          header="Extras"
          @expanded-changed=${this._stopEvent}
        >
          <div class="fields">
            ${this._form(notification, index, S_TINT)}
            ${this._form(notification, index, S_TAP_ACTION)}
          </div>
        </ha-expansion-panel>
      </ha-expansion-panel>
    `;
  }

  private _renderTrigger(
    notification: NotificationConfig,
    index: number,
  ): TemplateResult {
    return html`
      <ha-expansion-panel
        class="sub"
        outlined
        left-chevron
        header="Trigger"
        @expanded-changed=${this._stopEvent}
      >
        <div class="fields">
          ${this._form(notification, index, S_ENTITY)}
          ${
            // With an entity chosen, hand the state field HA's own state
            // selector: it lists that entity's known states and passes
            // allow-custom-value through to the picker, so anything typed -
            // including a number - still works.
            this._form(notification, index, this._stateSchema(notification.entity))
          }
          ${this._form(notification, index, S_TIMING)}
          ${this._form(notification, index, S_TRIGGER_ON_LOAD)}
          ${this._form(notification, index, S_CANCEL_ON_CLEAR)}
        </div>

        <div class="yaml-label">
          Advanced conditions
          <span class="yaml-hint">
            Home Assistant condition syntax. ANDed with the simple trigger above.
          </span>
        </div>
        <ha-yaml-editor
          .hass=${this._hass}
          .defaultValue=${notification.condition ?? []}
          @value-changed=${(ev: CustomEvent) => this._conditionChanged(index, ev)}
        ></ha-yaml-editor>
      </ha-expansion-panel>
    `;
  }

  private _renderProgress(
    notification: NotificationConfig,
    index: number,
  ): TemplateResult {
    const mode = this._progressMode(notification, index);

    return html`
      <ha-expansion-panel
        class="sub"
        outlined
        left-chevron
        header="Progress ring"
        @expanded-changed=${this._stopEvent}
      >
        <div class="segmented" role="tablist">
          ${(['entity', 'value'] as ProgressMode[]).map(
            (option) => html`
              <button
                type="button"
                role="tab"
                class=${mode === option ? 'selected' : ''}
                aria-selected=${mode === option}
                @click=${() => this._setProgressMode(index, option)}
              >
                ${option === 'entity' ? 'From an entity' : 'Number or template'}
              </button>
            `,
          )}
        </div>
        <div class="fields">
          ${
            // HA's entity selector has no free-text mode, so switching the field
            // is the only way to offer an entity search without losing literals
            // and templates.
            this._form(
              notification,
              index,
              mode === 'entity' ? S_PROGRESS_ENTITY : S_PROGRESS_TEXT,
            )
          }
          ${this._form(notification, index, S_PROGRESS_MAX)}
        </div>
      </ha-expansion-panel>
    `;
  }

  private _headerIcon(notification: NotificationConfig): string {
    switch (notification.type) {
      case 'warning':
        return 'mdi:alert-outline';
      case 'progress':
        return 'mdi:progress-helper';
      default:
        return 'mdi:check-circle-outline';
    }
  }

  /**
   * HA fires component events with `bubbles` and `composed` set, so a nested
   * panel's expanded-changed would otherwise reach the notification panel's
   * handler and collapse the wrong thing.
   */
  private _stopEvent = (ev: Event): void => {
    ev.stopPropagation();
  };

  private _panelToggled(index: number, ev: CustomEvent): void {
    if (ev.target !== ev.currentTarget) {
      return;
    }
    this._toggle(index, ev.detail.expanded);
  }

  private _toggle(index: number, expanded: boolean): void {
    const next = new Set(this._expanded);
    if (expanded) {
      next.add(index);
    } else {
      next.delete(index);
    }
    this._expanded = next;
  }

  private _progressMode(
    notification: NotificationConfig,
    index: number,
  ): ProgressMode {
    const chosen = this._progressModes.get(index);
    if (chosen) {
      return chosen;
    }
    const value = notification.progress;
    return typeof value === 'string' && ENTITY_ID.test(value) ? 'entity' : 'value';
  }

  private _setProgressMode(index: number, mode: ProgressMode): void {
    const next = new Map(this._progressModes);
    next.set(index, mode);
    this._progressModes = next;

    // The old value is meaningless in the other mode, and a stale entity id in
    // a number field is more confusing than an empty one.
    const notifications = [...(this._config?.notifications ?? [])];
    if (notifications[index]?.progress !== undefined) {
      const updated = { ...notifications[index] };
      delete updated.progress;
      notifications[index] = updated;
      this._emit(notifications);
    }
  }

  // --- config mutation ---------------------------------------------------

  private _emit(
    notifications: NotificationConfig[],
    globals?: Partial<FullscreenNotificationCardConfig>,
  ): void {
    const config = {
      ...this._config,
      ...globals,
      notifications,
    } as Record<string, unknown>;

    // A cleared control reports '' or undefined; left in place those would be
    // written back out as empty keys.
    for (const [key, value] of Object.entries(config)) {
      if (value === undefined || value === '') {
        delete config[key];
      }
    }

    this._config = config as unknown as FullscreenNotificationCardConfig;
    fireConfigChanged(this, this._config);
  }

  private _globalsChanged(ev: CustomEvent): void {
    ev.stopPropagation();
    this._emit(this._config?.notifications ?? [], ev.detail.value);
  }

  private _notificationChanged(index: number, ev: CustomEvent): void {
    ev.stopPropagation();
    const notifications = [...(this._config?.notifications ?? [])];
    const previous = notifications[index];
    if (!previous) {
      return;
    }
    const value = { ...ev.detail.value } as NotificationConfig;

    // Restore the richer forms the plain controls cannot express.
    if (value.tint === true && typeof previous.tint === 'string') {
      value.tint = previous.tint;
    } else if (value.tint === false) {
      delete value.tint;
    }
    value.condition = previous.condition;

    for (const key of Object.keys(value) as (keyof NotificationConfig)[]) {
      if (value[key] === '' || value[key] === undefined || value[key] === null) {
        delete value[key];
      }
    }

    notifications[index] = value;
    this._emit(notifications);
  }

  private _conditionChanged(index: number, ev: CustomEvent): void {
    ev.stopPropagation();
    if (ev.detail.isValid === false) {
      return;
    }
    const notifications = [...(this._config?.notifications ?? [])];
    const value = ev.detail.value;
    const next = { ...notifications[index] };
    if (!value || (Array.isArray(value) && value.length === 0)) {
      delete next.condition;
    } else {
      next.condition = value;
    }
    notifications[index] = next;
    this._emit(notifications);
  }

  private _add(): void {
    const notifications = [
      ...(this._config?.notifications ?? []),
      { type: 'success', title: 'New notification' } as NotificationConfig,
    ];
    this._expanded = new Set([notifications.length - 1]);
    this._emit(notifications);
  }

  private _duplicate(index: number): void {
    const notifications = [...(this._config?.notifications ?? [])];
    const source = notifications[index];
    if (!source) {
      return;
    }
    const copy = JSON.parse(JSON.stringify(source)) as NotificationConfig;
    // Ids identify a notification's cooldown and edge state, so a copy must not
    // inherit one.
    delete copy.id;
    copy.title = `${copy.title} (copy)`;
    notifications.splice(index + 1, 0, copy);
    this._expanded = new Set([index + 1]);
    this._progressModes = new Map();
    this._emit(notifications);
  }

  private _remove(index: number): void {
    const notifications = [...(this._config?.notifications ?? [])];
    notifications.splice(index, 1);
    this._expanded = new Set();
    this._progressModes = new Map();
    this._emit(notifications);
  }

  private _move(index: number, delta: number): void {
    const notifications = [...(this._config?.notifications ?? [])];
    const target = index + delta;
    if (target < 0 || target >= notifications.length) {
      return;
    }
    [notifications[index], notifications[target]] = [
      notifications[target],
      notifications[index],
    ];
    this._expanded = new Set([target]);
    this._progressModes = new Map();
    this._emit(notifications);
  }

  // --- preview -----------------------------------------------------------

  private _preview(notification: NotificationConfig, index: number): void {
    const config = this._config;
    if (!config) {
      return;
    }

    try {
      if (!this._overlay?.isConnected) {
        this._overlay = document.createElement('homeview-notification-overlay');
        document.body.appendChild(this._overlay);
      }

      const resolved = resolveNotification(
        notification,
        notificationKey(notification, index),
        config,
        this._hass,
        (template) => this._templates.get(template) ?? template,
      );

      this._overlay.present(resolved, {
        hass: this._hass,
        style: config.style ?? DEFAULTS.style,
        dark: isDarkMode(config.theme ?? DEFAULTS.theme, this._hass),
        backdrop: config.pill_backdrop ?? DEFAULTS.pill_backdrop,
        blur: config.backdrop_blur ?? DEFAULTS.backdrop_blur,
        opacity: config.backdrop_opacity ?? DEFAULTS.backdrop_opacity,
        reduced:
          (config.respect_reduced_motion ?? DEFAULTS.respect_reduced_motion) &&
          prefersReducedMotion(),
        dismissOnTap: true,
      }).done.catch((err) => {
        // eslint-disable-next-line no-console
        console.error('[homeview-notification-card] preview failed:', err);
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[homeview-notification-card] preview failed:', err);
    }
  }

  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    ha-form {
      display: block;
    }

    /* Every ha-form here holds one field, so spacing is entirely ours. */
    .fields {
      display: flex;
      flex-direction: column;
      gap: 10px;
      padding-bottom: 4px;
    }

    .section-title {
      font-weight: 500;
      margin-top: 4px;
    }

    ha-expansion-panel {
      --expansion-panel-summary-padding: 0 12px;
    }

    ha-expansion-panel.sub {
      margin-top: 4px;
    }

    .header {
      display: flex;
      align-items: center;
      gap: 10px;
      min-width: 0;
    }

    .header-title {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .header ha-icon.success {
      color: var(--success-color, #43a047);
    }

    .header ha-icon.warning {
      color: var(--warning-color, #ffa600);
    }

    .header ha-icon.progress {
      color: var(--primary-color, #03a9f4);
    }

    .toolbar {
      display: flex;
      align-items: center;
      gap: 2px;
      padding: 2px 4px 6px;
    }

    .spacer {
      flex: 1;
    }

    button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      background: none;
      border: none;
      border-radius: 50%;
      padding: 8px;
      cursor: pointer;
      color: var(--secondary-text-color);
      font: inherit;
    }

    button:hover:not([disabled]) {
      background: var(--secondary-background-color);
      color: var(--primary-text-color);
    }

    button[disabled] {
      opacity: 0.35;
      cursor: default;
    }

    button.danger:hover {
      color: var(--error-color, #db4437);
    }

    button.add {
      align-self: flex-start;
      border-radius: 8px;
      padding: 10px 14px;
      color: var(--primary-color);
    }

    .segmented {
      display: flex;
      gap: 4px;
      padding: 4px 0 10px;
    }

    .segmented button {
      flex: 1;
      border-radius: 8px;
      padding: 8px 10px;
      font-size: 13px;
      border: 1px solid var(--divider-color, #444);
    }

    .segmented button.selected {
      border-color: var(--primary-color);
      color: var(--primary-color);
      background: color-mix(in srgb, var(--primary-color) 12%, transparent);
    }

    ha-yaml-editor {
      display: block;
      padding-bottom: 4px;
    }

    .yaml-label {
      padding: 6px 0 4px;
      font-size: 13px;
      font-weight: 500;
    }

    .yaml-hint {
      display: block;
      font-weight: 400;
      color: var(--secondary-text-color);
      font-size: 12px;
    }
  `;
}

declare global {
  interface HTMLElementTagNameMap {
    'homeview-notification-card-editor': FullscreenNotificationCardEditor;
  }
}
