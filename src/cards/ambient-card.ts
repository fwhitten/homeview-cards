import { LitElement, css, html, nothing, type PropertyValues } from 'lit';
import { property, state } from 'lit/decorators.js';
import type { GridOptions, HomeAssistant, LovelaceCardConfig } from '../core/types';
import { tokens } from '../core/styles';
import { clockDigits, longDate } from '../core/format';
import { isNight } from '../core/store';
import { inEditMode } from '../core/edit-mode';
import { defineElement, registerCard } from '../core/register';
import type { DepthPhoto } from './clock-card';
import type { Chip } from './chips-card';

export interface AmbientConfig extends LovelaceCardConfig {
  photos?: DepthPhoto[];
  rotate_minutes?: number;
  /** A presence or motion sensor in front of the screen. */
  motion_entity?: string;
  /** Seconds after motion clears (and the screen was last touched) before the clock shows. */
  timeout?: number;
  /** Turns the night look on: an input_boolean, binary_sensor or sun.sun. */
  night_entity?: string;
  show_date?: boolean;
  chips?: Chip[];
}

const ACTIVITY = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;

/**
 * The full-screen depth clock with glance chips, shown when nobody is in front
 * of the panel: after the motion entity has been clear and the screen
 * untouched for `timeout` seconds. Any touch, or new motion, wakes it.
 */
export class HomeViewAmbientOverlay extends LitElement {
  @property({ attribute: false }) hass?: HomeAssistant;
  @property({ attribute: false }) config?: AmbientConfig;
  @property({ type: Boolean, reflect: true }) open = false;
  @property({ type: Boolean, reflect: true }) night = false;
  @state() private now = new Date();
  private ticker?: number;

  connectedCallback(): void {
    super.connectedCallback();
    this.ticker = window.setInterval(() => (this.now = new Date()), 10_000);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.clearInterval(this.ticker);
  }

  private get photo(): DepthPhoto | undefined {
    const list = this.config?.photos ?? [];
    if (!list.length) return undefined;
    const slot = Math.floor(this.now.getTime() / ((this.config?.rotate_minutes ?? 30) * 60_000));
    return list[slot % list.length];
  }

  protected updated(changed: PropertyValues): void {
    const chips = this.renderRoot.querySelector('homeview-chips-card') as (HTMLElement & { hass?: HomeAssistant; setConfig?: (c: unknown) => void }) | null;
    if (chips && (changed.has('config') || !chips.getAttribute('data-configured'))) {
      chips.setConfig?.({ type: 'custom:homeview-chips-card', style: 'glance', align: 'center', chips: this.config?.chips ?? [], appearance: 'dark' });
      chips.setAttribute('data-configured', '');
    }
    if (chips) chips.hass = this.hass;
  }

  render() {
    if (!this.hass || !this.config) return nothing;
    const p = this.photo;
    const digits = clockDigits(this.hass, this.now);
    const color = this.night ? 'rgba(216,195,171,.86)' : p?.color ?? 'rgba(255,232,216,.93)';
    const top = (p?.position ?? 0.19) * 100;
    return html`
      <div class="wrap" role="button" tabindex="-1" aria-label="${digits}. Tap to wake">
        ${p ? html`<img class="ph" src=${p.background} alt="" />` : html`<div class="ph fallback"></div>`}
        ${this.config.show_date !== false ? html`<div class="date" style="top:calc(${top}% - 52px)">${longDate(this.hass, this.now)}</div>` : nothing}
        <div class="digits" style="top:${top}%;color:${color}">${digits}</div>
        ${p?.foreground ? html`<img class="ph" src=${p.foreground} alt="" />` : nothing}
        ${this.config.chips?.length ? html`<div class="chips"><homeview-chips-card></homeview-chips-card></div>` : nothing}
      </div>
    `;
  }

  static styles = [
    tokens,
    css`
      :host {
        position: fixed;
        inset: 0;
        z-index: 1001;
        display: none;
        font-family: var(--_font);
        -webkit-font-smoothing: antialiased;
        color: #fff;
        background: #16131f;
        opacity: 0;
        transition: opacity 0.8s ease;
      }
      :host([open]) {
        display: block;
        opacity: 1;
      }
      .wrap {
        position: absolute;
        inset: 0;
        overflow: hidden;
        outline: none;
        container-type: size;
      }
      .ph {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        object-fit: cover;
        pointer-events: none;
      }
      .fallback {
        background: linear-gradient(180deg, #25335e 0%, #7a65a2 48%, #ec9d78 78%, #f6c891 100%);
      }
      :host([night]) .ph {
        filter: brightness(0.26) saturate(0.55);
      }
      .digits {
        position: absolute;
        left: 0;
        right: 0;
        text-align: center;
        font-family: var(--_font-rounded);
        font-weight: 600;
        font-size: min(22cqw, 30cqh);
        letter-spacing: -0.02em;
        line-height: 1;
        font-variant-numeric: tabular-nums;
        text-shadow: 0 6px 60px rgba(40, 30, 70, 0.28);
      }
      :host([night]) .digits {
        text-shadow: none;
      }
      .date {
        position: absolute;
        left: 0;
        right: 0;
        text-align: center;
        font-size: max(20px, 2.2cqw);
        font-weight: 600;
        color: rgba(255, 255, 255, 0.9);
      }
      :host([night]) .date {
        color: rgba(216, 195, 171, 0.7);
      }
      .chips {
        position: absolute;
        left: 40px;
        right: 40px;
        bottom: 40px;
      }
      :host([night]) .chips {
        opacity: 0.7;
      }
      @media (prefers-reduced-motion: reduce) {
        :host {
          transition: none;
        }
      }
    `,
  ];
}

/**
 * Card that runs the ambient clock. It takes no space on a live dashboard;
 * in the editor it shows a small placeholder so it can be selected.
 */
export class HomeViewAmbientCard extends LitElement {
  @property({ attribute: false }) hass?: HomeAssistant;
  @property({ type: Boolean }) preview = false;
  @state() private config?: AmbientConfig;
  @state() private editMode = false;
  private overlay?: HomeViewAmbientOverlay;
  private idleTimer?: number;
  private lastActivity = Date.now();
  private motionClearedAt = Date.now();

  static getConfigForm() {
    return {
      schema: [
        { name: 'motion_entity', selector: { entity: { domain: 'binary_sensor' } } },
        { name: 'timeout', default: 120, selector: { number: { min: 10, max: 3600, unit_of_measurement: 's' } } },
        { name: 'night_entity', selector: { entity: { domain: ['input_boolean', 'binary_sensor', 'sun'] } } },
        { name: 'show_date', default: true, selector: { boolean: {} } },
        {
          name: 'photos',
          selector: {
            object: {
              multiple: true,
              label_field: 'background',
              fields: {
                background: { label: 'Background photo URL', required: true, selector: { text: {} } },
                foreground: { label: 'Foreground cut-out URL', selector: { text: {} } },
                color: { label: 'Numeral colour', selector: { text: {} } },
                position: { label: 'Numeral position (0 top – 1 bottom)', selector: { number: { min: 0, max: 0.8, step: 0.01 } } },
              },
            },
          },
        },
        { name: 'rotate_minutes', default: 30, selector: { number: { min: 1, max: 1440, unit_of_measurement: 'min' } } },
      ],
      computeHelper: (s: { name: string }) =>
        s.name === 'motion_entity'
          ? 'Leave empty to use touch inactivity only. Chips are set in YAML with the same options as the status chips card.'
          : undefined,
    };
  }

  static getStubConfig() {
    return { timeout: 120 };
  }

  setConfig(config: AmbientConfig): void {
    if (!config) throw new Error('Invalid configuration');
    this.config = { timeout: 120, ...config };
    if (this.overlay) this.overlay.config = this.config;
  }

  private onActivity = (): void => {
    this.lastActivity = Date.now();
    if (this.overlay?.open) this.overlay.open = false;
    this.schedule();
  };

  connectedCallback(): void {
    super.connectedCallback();
    this.editMode = inEditMode(this);
    this.hidden = !this.editMode && !this.preview;
    if (this.editMode || this.preview) return;
    this.overlay ??= document.createElement('homeview-ambient-overlay') as HomeViewAmbientOverlay;
    this.overlay.config = this.config;
    this.overlay.hass = this.hass;
    if (!this.overlay.isConnected) document.body.appendChild(this.overlay);
    ACTIVITY.forEach((e) => window.addEventListener(e, this.onActivity, { passive: true, capture: true }));
    this.schedule();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    ACTIVITY.forEach((e) => window.removeEventListener(e, this.onActivity, { capture: true }));
    window.clearTimeout(this.idleTimer);
    this.overlay?.remove();
  }

  /** Check again when the timeout would next elapse. */
  private schedule(): void {
    window.clearTimeout(this.idleTimer);
    if (!this.config || this.editMode) return;
    const ms = (this.config.timeout ?? 120) * 1000;
    const since = Math.max(this.lastActivity, this.motionClearedAt);
    const wait = Math.max(500, since + ms - Date.now());
    this.idleTimer = window.setTimeout(() => this.evaluate(), wait);
  }

  private evaluate(): void {
    if (!this.overlay || !this.config) return;
    const ms = (this.config.timeout ?? 120) * 1000;
    const motion = this.config.motion_entity ? this.hass?.states[this.config.motion_entity]?.state === 'on' : false;
    const idle = Date.now() - this.lastActivity >= ms && Date.now() - this.motionClearedAt >= ms;
    this.overlay.open = !motion && idle;
    if (!this.overlay.open) this.schedule();
  }

  protected willUpdate(changed: PropertyValues): void {
    if (!changed.has('hass') || !this.hass || !this.config) return;
    const old = changed.get('hass') as HomeAssistant | undefined;
    const id = this.config.motion_entity;
    if (id && old && old.states[id] !== this.hass.states[id]) {
      if (this.hass.states[id]?.state === 'on') {
        if (this.overlay) this.overlay.open = false;
      } else {
        this.motionClearedAt = Date.now();
      }
      this.schedule();
    }
    if (this.overlay) {
      this.overlay.hass = this.hass;
      this.overlay.night = isNight(this.hass, this.config.night_entity);
    }
  }

  render() {
    if (!this.editMode && !this.preview) return nothing;
    return html`<ha-card class="ph"><ha-icon icon="mdi:clock-time-four-outline"></ha-icon><span>Ambient clock · shows after ${this.config?.timeout ?? 120}s without motion or touch</span></ha-card>`;
  }

  getCardSize(): number {
    return 1;
  }

  getGridOptions(): GridOptions {
    return { columns: 12, rows: 1, min_rows: 1 };
  }

  static styles = css`
    .ph {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 12px 16px;
      font-size: 14px;
      color: var(--secondary-text-color);
    }
  `;
}

defineElement('homeview-ambient-overlay', HomeViewAmbientOverlay);
defineElement('homeview-ambient-card', HomeViewAmbientCard);
registerCard({
  type: 'homeview-ambient-card',
  name: 'HomeView Ambient clock',
  description: 'Full-screen depth-photo clock and glance chips when nobody is in front of the panel.',
  preview: false,
  docs: 'ambient',
});
