import { LitElement, css, html, nothing, render, type PropertyValues } from 'lit';
import { property, state } from 'lit/decorators.js';
import { tokens } from '../core/styles';
import { popupTag, type PopupHostElement, type PopupProps } from '../core/popup-bus';
import { resolveMode, store, type Mode } from '../core/store';
import type { HomeAssistant } from '../core/types';
import { defineElement } from '../core/register';
import { prefersReducedMotion } from '../core/events';

/** A pop-up's content class can ask for `media`: edge to edge, sized to its aspect ratio, title over the picture. */
interface PopupContentClass {
  layout?: 'sheet' | 'media';
  /** Width ÷ height of a media pop-up, from the opening card's config. */
  aspectFor?(config: Record<string, unknown>): number;
}

export interface PopupContentElement extends HTMLElement {
  hass?: HomeAssistant;
  props?: PopupProps;
  mode?: Mode;
  /** Title for the sheet header. */
  popupTitle?(): string;
  popupSubtitle?(): string;
  /** Buttons for the header, beside the close button. */
  popupActions?(): unknown;
}

/**
 * The single overlay that hosts every HomeView pop-up. It lives in
 * document.body, follows the shared hass from the store, closes on the
 * browser back button, Escape or a tap on the scrim.
 */
export class HomeViewPopupHost extends LitElement implements PopupHostElement {
  @state() private name?: string;
  @state() private props?: PopupProps;
  @state() private hass?: HomeAssistant;
  @property({ reflect: true }) mode: Mode = 'dark';
  @property({ type: Boolean, reflect: true }) open = false;
  /** Still catching taps for a moment after closing, so the tap that closed it can't land on a card beneath. */
  @property({ type: Boolean, reflect: true }) closing = false;
  private content?: PopupContentElement;
  private unsub?: () => void;
  private pushed = false;
  /** Marks the history entry this opening pushed, so entries left over from a reload aren't mistaken for it. */
  private token = '';
  private autoTimer?: number;

  constructor() {
    super();
    this.addEventListener('context-request', this.forwardContext);
    // Any touch, scroll or key restarts the idle countdown.
    for (const type of ['pointerdown', 'pointermove', 'wheel', 'keydown']) this.addEventListener(type, this.activity, { passive: true });
    this.addEventListener('scroll', this.activity, { capture: true, passive: true });
    // Content asks for its title, subtitle and header buttons to be redrawn when it changes.
    this.addEventListener('hv-popup-refresh', () => this.syncHeader());
  }

  /** Seconds of no interaction before the pop-up closes: the view's popup_timeout, default 60, 0 for never. */
  private get idleMs(): number {
    const s = store.settings.popup_timeout;
    return (typeof s === 'number' && s >= 0 ? s : 60) * 1000;
  }

  private armIdle(ms: number): void {
    window.clearTimeout(this.autoTimer);
    if (ms > 0 && this.open) this.autoTimer = window.setTimeout(() => this.close(), ms);
  }

  private lastActivity = 0;
  private activity = (): void => {
    if (!this.open) return;
    // pointermove fires constantly: re-arm at most once a second.
    const now = Date.now();
    if (now - this.lastActivity < 1000) return;
    this.lastActivity = now;
    this.armIdle(this.media ? 0 : this.idleMs);
  };

  /** A live camera isn't closed for want of a touch, unless it opened by itself. */
  private get media(): boolean {
    const kind = this.name ? (customElements.get(popupTag(this.name)) as PopupContentClass | undefined) : undefined;
    return kind?.layout === 'media';
  }

  /**
   * Home Assistant's own elements in a pop-up (the camera stream, its players)
   * read the connection and settings through Lit context, which Home
   * Assistant provides on its <home-assistant> element. This host lives in
   * document.body, outside that tree, so their requests would go unanswered.
   * Pass each one on from inside Home Assistant's tree, unchanged: the
   * provider answers the original element through its callback.
   */
  private forwardContext = (ev: Event): void => {
    const ha = document.querySelector('home-assistant');
    if (!ha) return;
    const req = ev as Event & { context: unknown; contextTarget?: Element; callback: unknown; subscribe?: boolean };
    ev.stopPropagation();
    const proxy = new Event('context-request', { bubbles: true, composed: true });
    Object.assign(proxy, {
      context: req.context,
      contextTarget: req.contextTarget ?? (ev.composedPath()[0] as Element),
      callback: req.callback,
      subscribe: req.subscribe,
    });
    (ha.shadowRoot?.firstElementChild ?? ha).dispatchEvent(proxy);
  };

  show(name: string, props: PopupProps): void {
    this.name = name;
    this.props = props;
    this.hass = store.hass;
    this.open = true;
    this.lastActivity = 0;
    this.armIdle(props.autoClose ?? (this.media ? 0 : this.idleMs));
    if (!this.pushed) {
      this.token = `${name}:${Date.now()}`;
      history.pushState({ ...(history.state ?? {}), homeviewPopup: this.token }, '');
      this.pushed = true;
    }
  }

  close(): void {
    if (!this.open) return;
    if (this.pushed && history.state?.homeviewPopup === this.token) {
      history.back();
      return;
    }
    this.dismiss();
  }

  private dismiss(): void {
    window.clearTimeout(this.autoTimer);
    this.open = false;
    this.closing = true;
    this.pushed = false;
    window.setTimeout(() => (this.closing = false), 400);
    window.setTimeout(() => {
      if (this.open) return;
      this.content?.remove();
      this.content = undefined;
      this.name = undefined;
    }, prefersReducedMotion() ? 0 : 260);
  }

  private onPop = (): void => {
    if (this.open && history.state?.homeviewPopup !== this.token) {
      this.pushed = false;
      this.dismiss();
    }
  };

  private onKey = (ev: KeyboardEvent): void => {
    if (this.open && ev.key === 'Escape') this.close();
  };

  connectedCallback(): void {
    super.connectedCallback();
    this.unsub = store.subscribe('hass', () => (this.hass = store.hass));
    window.addEventListener('popstate', this.onPop);
    window.addEventListener('keydown', this.onKey);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.unsub?.();
    window.removeEventListener('popstate', this.onPop);
    window.removeEventListener('keydown', this.onKey);
  }

  protected willUpdate(changed: PropertyValues): void {
    if (changed.has('hass') || changed.has('props')) {
      const cfg = (this.props?.config ?? {}) as { appearance?: never; night_entity?: string };
      this.mode = resolveMode(this.hass, cfg.appearance, cfg.night_entity);
    }
  }

  protected updated(): void {
    if (!this.name) return;
    const slot = this.renderRoot.querySelector('.body');
    if (!slot) return;
    const tag = popupTag(this.name);
    if (!this.content || this.content.localName !== tag) {
      this.content?.remove();
      this.content = document.createElement(tag) as PopupContentElement;
      slot.appendChild(this.content);
    }
    this.content.hass = this.hass;
    this.content.props = this.props;
    this.content.mode = this.mode;
    this.syncHeader();
  }

  private syncHeader(): void {
    const c = this.content;
    if (!c) return;
    const title = this.renderRoot.querySelector('.title');
    const sub = this.renderRoot.querySelector('.subtitle');
    const actions = this.renderRoot.querySelector('.actions') as HTMLElement | null;
    if (title) title.textContent = c.popupTitle?.() ?? '';
    if (sub) sub.textContent = c.popupSubtitle?.() ?? '';
    if (actions) render(c.popupActions?.() ?? nothing, actions);
  }

  render() {
    if (!this.name) return nothing;
    const kind = customElements.get(popupTag(this.name)) as PopupContentClass | undefined;
    const media = kind?.layout === 'media';
    const aspect = media ? kind?.aspectFor?.(this.props?.config ?? {}) ?? 16 / 9 : undefined;
    return html`
      <div class="scrim" @click=${() => this.close()}></div>
      <section class="sheet ${media ? 'media' : ''}" style=${aspect ? `--_aspect:${aspect}` : ''} role="dialog" aria-modal="true" aria-labelledby="hv-popup-title">
        <header>
          <div class="heading">
            <h2 class="title" id="hv-popup-title"></h2>
            <div class="subtitle"></div>
          </div>
          <div class="actions"></div>
          <button class="close" aria-label="Close" @click=${() => this.close()}>
            <ha-icon icon="mdi:close"></ha-icon>
          </button>
        </header>
        <div class="body"></div>
      </section>
    `;
  }

  static styles = [
    tokens,
    css`
      :host {
        position: fixed;
        inset: 0;
        z-index: 1000;
        box-sizing: border-box;
        padding: 24px;
        display: grid;
        grid-template: minmax(0, 1fr) / minmax(0, 1fr);
        place-items: center;
        pointer-events: none;
        font-family: var(--_font);
        -webkit-font-smoothing: antialiased;
        font-variant-numeric: tabular-nums;
        color: var(--_ink);
      }
      :host([open]),
      :host([closing]) {
        pointer-events: auto;
      }
      .scrim {
        position: absolute;
        inset: 0;
        background: rgba(6, 8, 14, 0.38);
        -webkit-backdrop-filter: blur(16px) saturate(140%);
        backdrop-filter: blur(16px) saturate(140%);
        opacity: 0;
        transition: opacity 0.25s ease;
      }
      :host([mode='light']) .scrim {
        background: rgba(220, 228, 236, 0.4);
      }
      :host([open]) .scrim {
        opacity: 1;
      }
      .sheet {
        position: relative;
        box-sizing: border-box;
        /* Sized from the host's box, not viewport units, which some app web views misreport. */
        width: 100%;
        max-width: 1180px;
        max-height: 100%;
        display: flex;
        flex-direction: column;
        gap: 22px;
        padding: 30px 36px 34px;
        border-radius: 40px;
        overflow: auto;
        background: radial-gradient(120% 60% at 0% 0%, rgba(255, 255, 255, 0.12), rgba(255, 255, 255, 0) 50%),
          var(--hv-popup-background, rgba(30, 32, 44, 0.58));
        box-shadow: inset 1.5px 1.5px 0 rgba(255, 255, 255, 0.35), inset -1px -1px 0 rgba(255, 255, 255, 0.12),
          0 40px 120px rgba(0, 0, 0, 0.45);
        -webkit-backdrop-filter: blur(40px) saturate(180%);
        backdrop-filter: blur(40px) saturate(180%);
        transform: translateY(24px) scale(0.98);
        opacity: 0;
        transition: transform 0.28s cubic-bezier(0.2, 0.9, 0.3, 1), opacity 0.2s ease;
      }
      :host([mode='light']) .sheet {
        background: radial-gradient(120% 60% at 0% 0%, rgba(255, 255, 255, 0.6), rgba(255, 255, 255, 0) 50%),
          var(--hv-popup-background, rgba(255, 255, 255, 0.55));
      }
      :host([mode='night']) .sheet {
        background: rgba(10, 9, 12, 0.82);
        box-shadow: inset 1px 1px 0 rgba(255, 255, 255, 0.08);
      }
      :host([open]) .sheet {
        transform: none;
        opacity: 1;
      }
      header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
      }
      .title {
        margin: 0;
        font-size: 34px;
        font-weight: 700;
        letter-spacing: -0.02em;
      }
      .subtitle {
        font-size: 18px;
        font-weight: 500;
        color: var(--_ink2);
        margin-top: 2px;
      }
      .close {
        width: 56px;
        height: 56px;
        flex: none;
        display: grid;
        place-items: center;
        border: 0;
        border-radius: 999px;
        background: var(--_glass-hi);
        color: var(--_ink);
        cursor: pointer;
        --mdc-icon-size: 26px;
      }
      .heading {
        flex: 1;
        min-width: 0;
      }
      .actions {
        display: flex;
        gap: 10px;
      }
      .actions:empty {
        display: none;
      }
      /* A header button from the content (e.g. All off): a pill as tall as the close button. */
      .hbtn {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        height: 56px;
        padding: 0 22px;
        border: 0;
        border-radius: 999px;
        background: var(--_glass-hi);
        color: var(--_ink);
        font: inherit;
        font-size: 18px;
        font-weight: 600;
        cursor: pointer;
        --mdc-icon-size: 22px;
      }
      .hbtn[disabled] {
        opacity: 0.4;
        cursor: default;
      }
      .hbtn:focus-visible,
      .close:focus-visible {
        outline: 3px solid var(--_ink);
        outline-offset: 2px;
      }
      .body {
        min-height: 0;
      }
      /* Media: the picture fills the sheet edge to edge, at its own aspect ratio, as large as the screen allows. */
      .sheet.media {
        width: 100%;
        max-width: min(1600px, calc((100vh - 48px) * var(--_aspect)));
        max-width: min(1600px, calc((100dvh - 48px) * var(--_aspect)));
        aspect-ratio: var(--_aspect);
        max-height: none;
        padding: 0;
        gap: 0;
        overflow: hidden;
        background: #000;
        color: #fff;
        -webkit-backdrop-filter: none;
        backdrop-filter: none;
        transform: none;
      }
      .sheet.media header {
        position: absolute;
        z-index: 2;
        top: 0;
        left: 0;
        right: 0;
        padding: 22px 22px 48px 28px;
        background: linear-gradient(rgba(0, 0, 0, 0.55), rgba(0, 0, 0, 0));
        pointer-events: none;
      }
      .sheet.media header > * {
        pointer-events: auto;
      }
      .sheet.media .title {
        font-size: 26px;
        text-shadow: 0 1px 8px rgba(0, 0, 0, 0.4);
      }
      .sheet.media .subtitle {
        color: rgba(255, 255, 255, 0.8);
      }
      .sheet.media .close {
        width: 48px;
        height: 48px;
        color: #fff;
        background: rgba(20, 20, 24, 0.45);
        -webkit-backdrop-filter: blur(12px);
        backdrop-filter: blur(12px);
      }
      .sheet.media .body {
        position: absolute;
        inset: 0;
      }
      @media (max-width: 700px) {
        :host {
          padding: 0;
          place-items: end center;
        }
        .sheet {
          width: 100%;
          max-height: 92%;
          border-radius: 32px 32px 0 0;
          padding: 22px 18px 28px;
        }
        .sheet.media {
          padding: 0;
        }
      }
      @media (prefers-reduced-motion: reduce) {
        .scrim,
        .sheet {
          transition: none;
        }
      }
    `,
  ];
}

defineElement('homeview-popup-host', HomeViewPopupHost);
