import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, state, query } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';
import { styleMap } from 'lit/directives/style-map.js';
import './animated-icon';
import { EFFECT_DURATION, type FsnAnimatedIcon } from './animated-icon';
import type { CardStyle, HomeAssistant, ResolvedNotification } from './types';

const BACKDROP_FADE = 320;
const ICON_RISE = 460;
const PILL_IN = 460;
const PILL_OUT = 380;
const CONTENT_FADE_OUT = 300;

export interface PresentOptions {
  hass?: HomeAssistant;
  style: CardStyle;
  dark: boolean;
  backdrop: boolean;
  blur: number;
  opacity: number;
  reduced: boolean;
  dismissOnTap: boolean;
  onTap?: () => void;
}

export interface Presentation {
  done: Promise<void>;
  dismiss(): void;
}

class Cancelled extends Error {}

/**
 * Wait for one painted frame, but never longer than a moment.
 *
 * The opening transitions need a frame at the initial state to animate from,
 * yet a hidden or throttled tab never paints - and a bare
 * `requestAnimationFrame` there would hang the whole sequence, leaving the
 * queue stuck and the card silent even after the tab came back.
 */
const nextFrame = (): Promise<void> =>
  new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    requestAnimationFrame(finish);
    setTimeout(finish, 50);
  });

/**
 * A run token. `wake` lets a dismissal cut short whatever timer the sequence is
 * currently sitting on, instead of the tap only taking effect once the full
 * hold has elapsed.
 */
interface RunToken {
  cancelled: boolean;
  wake?: () => void;
}

const cancelRun = (token: RunToken): void => {
  token.cancelled = true;
  token.wake?.();
};

/**
 * The notification surface itself. The card portals one of these into
 * `document.body` so that `position: fixed` is measured against the viewport;
 * left inside the dashboard it would be clipped by any ancestor carrying a
 * `transform`, `filter` or `contain`, which the Sections layout does use.
 */
@customElement('homeview-notification-overlay')
export class FsnOverlay extends LitElement {
  @state() private _notification?: ResolvedNotification;
  @state() private _options?: PresentOptions;
  @state() private _visible = false;
  @state() private _backdropOn = false;
  @state() private _iconOn = false;
  @state() private _textOn = false;
  @state() private _pillOn = false;
  @state() private _exiting = false;

  @query('homeview-notification-icon') private _icon?: FsnAnimatedIcon;

  private _token: RunToken = { cancelled: false };
  private _inTopLayer = false;

  public connectedCallback(): void {
    super.connectedCallback();
    // Promote the surface to the top layer. That sidesteps z-index entirely -
    // nothing on the dashboard and no dialog Home Assistant opens can paint
    // over it - and it also means an ancestor `transform`, `filter` or
    // `contain` cannot capture the fixed positioning. `manual` rather than a
    // modal <dialog> so the page underneath stays interactive, which matters
    // for pill notifications.
    if (!this.hasAttribute('popover') && typeof this.showPopover === 'function') {
      this.setAttribute('popover', 'manual');
    }
  }

  private _enterTopLayer(): void {
    if (this._inTopLayer || !this.hasAttribute('popover')) {
      return;
    }
    try {
      this.showPopover();
      this._inTopLayer = true;
    } catch {
      // Already open, or the element is not connected yet; the fixed-position
      // fallback below still renders it.
    }
  }

  private _leaveTopLayer(): void {
    if (!this._inTopLayer) {
      return;
    }
    this._inTopLayer = false;
    try {
      this.hidePopover();
    } catch {
      // Already closed.
    }
  }

  public present(
    notification: ResolvedNotification,
    options: PresentOptions,
  ): Presentation {
    cancelRun(this._token);
    const token: RunToken = { cancelled: false };
    this._token = token;

    this._notification = notification;
    this._options = options;

    return {
      done: this._run(notification, options, token),
      dismiss: () => cancelRun(token),
    };
  }

  /** Tear everything down immediately, e.g. when the card is removed. */
  public abort(): void {
    cancelRun(this._token);
    this._reset();
  }

  private async _run(
    notification: ResolvedNotification,
    options: PresentOptions,
    token: RunToken,
  ): Promise<void> {
    const wait = async (ms: number): Promise<void> => {
      if (token.cancelled) {
        throw new Cancelled();
      }
      if (ms > 0) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            token.wake = undefined;
            resolve();
          }, ms);
          token.wake = () => {
            clearTimeout(timer);
            token.wake = undefined;
            resolve();
          };
        });
      }
      if (token.cancelled) {
        throw new Cancelled();
      }
    };

    const effect = EFFECT_DURATION[notification.type] * (options.reduced ? 0.6 : 1);
    const useBackdrop = options.style === 'fullscreen' || options.backdrop;

    this._enterTopLayer();
    this._visible = true;
    await this.updateComplete;
    // One frame at the initial state so the opening transitions actually run.
    await nextFrame();

    try {
      if (useBackdrop) {
        this._backdropOn = true;
        await wait(BACKDROP_FADE);
      }

      if (options.style === 'fullscreen') {
        this._iconOn = true;
        await wait(ICON_RISE * 0.75);
        void this._icon?.play();
        await wait(200);
        this._textOn = true;
        await wait(Math.max(effect - 200, 0));
      } else {
        this._pillOn = true;
        this._iconOn = true;
        this._textOn = true;
        await wait(PILL_IN * 0.8);
        void this._icon?.play();
        await wait(effect);
      }

      await wait(notification.duration * 1000);
      await this._exit(options, useBackdrop, wait);
    } catch (err) {
      if (!(err instanceof Cancelled)) {
        throw err;
      }
      // A dismissal still gets a graceful exit, just without the hold.
      await this._exit(options, useBackdrop, (ms) =>
        new Promise((resolve) => setTimeout(resolve, ms)),
      ).catch(() => undefined);
    }

    this._reset();
  }

  private async _exit(
    options: PresentOptions,
    useBackdrop: boolean,
    wait: (ms: number) => Promise<void>,
  ): Promise<void> {
    if (!this._visible) {
      return;
    }
    this._exiting = true;

    if (options.style === 'fullscreen') {
      this._iconOn = false;
      this._textOn = false;
      await wait(CONTENT_FADE_OUT);
    } else {
      this._pillOn = false;
      await wait(PILL_OUT);
    }

    if (useBackdrop) {
      this._backdropOn = false;
      await wait(BACKDROP_FADE);
    }
  }

  private _reset(): void {
    this._leaveTopLayer();
    this._visible = false;
    this._backdropOn = false;
    this._iconOn = false;
    this._textOn = false;
    this._pillOn = false;
    this._exiting = false;
    this._notification = undefined;
    this._icon?.reset();
  }

  private _handleTap = (): void => {
    if (!this._options) {
      return;
    }
    this._options.onTap?.();
    if (this._options.dismissOnTap) {
      cancelRun(this._token);
    }
  };

  protected render(): TemplateResult | typeof nothing {
    const notification = this._notification;
    const options = this._options;
    if (!notification || !options) {
      return nothing;
    }

    const tint = notification.tint;
    const hostStyles = styleMap({
      '--hvn-color': notification.color,
      '--hvn-blur': `${options.blur}px`,
      '--hvn-backdrop-opacity': String(options.opacity),
      '--hvn-tint': tint ?? 'transparent',
      '--hvn-tint-opacity': tint ? '0.15' : '0',
    });

    const classes = classMap({
      root: true,
      visible: this._visible,
      dark: options.dark,
      light: !options.dark,
      reduced: options.reduced,
      fullscreen: options.style === 'fullscreen',
      pill: options.style === 'pill',
      'backdrop-on': this._backdropOn,
      'icon-on': this._iconOn,
      'text-on': this._textOn,
      'pill-on': this._pillOn,
      exiting: this._exiting,
      interactive: options.dismissOnTap || !!options.onTap,
    });

    return html`
      <div class=${classes} style=${hostStyles}>
        <div class="backdrop" @click=${this._handleTap}>
          <div class="tint"></div>
        </div>
        ${options.style === 'fullscreen'
          ? this._renderFullscreen(notification)
          : this._renderPill(notification)}
      </div>
    `;
  }

  /** Scale the fullscreen glyph to the viewport so it reads well on phones. */
  private _glyphSize(): number {
    const shortest = Math.min(window.innerWidth, window.innerHeight);
    return Math.round(Math.max(132, Math.min(240, shortest * 0.3)));
  }

  private _renderFullscreen(notification: ResolvedNotification): TemplateResult {
    return html`
      <div class="content" role="alertdialog" aria-live="assertive" @click=${this._handleTap}>
        <homeview-notification-icon
          class="glyph"
          .hass=${this._options?.hass}
          .type=${notification.type}
          .icon=${notification.icon}
          .stateObj=${notification.stateObj}
          .color=${notification.color}
          .progress=${notification.progress}
          .size=${this._glyphSize()}
          .motion=${this._options?.reduced ? 0.6 : 1}
        ></homeview-notification-icon>
        <div class="text">
          <div class="title">${notification.title}</div>
          ${notification.message
            ? html`<div class="message">${notification.message}</div>`
            : nothing}
        </div>
      </div>
    `;
  }

  private _renderPill(notification: ResolvedNotification): TemplateResult {
    return html`
      <div class="pill-wrap">
        <div class="pill-body" role="alert" aria-live="assertive" @click=${this._handleTap}>
          <homeview-notification-icon
            class="glyph"
            .hass=${this._options?.hass}
            .type=${notification.type}
            .icon=${notification.icon}
            .stateObj=${notification.stateObj}
            .color=${notification.color}
            .progress=${notification.progress}
            .size=${68}
            .motion=${this._options?.reduced ? 0.6 : 1}
          ></homeview-notification-icon>
          <div class="text">
            <div class="title">${notification.title}</div>
            ${notification.message
              ? html`<div class="message">${notification.message}</div>`
              : nothing}
          </div>
        </div>
      </div>
    `;
  }

  static styles = css`
    /*
     * No display declaration here on purpose: the UA rule that hides a closed popover
     * must keep winning. Everything else undoes the UA's popover box so this is
     * a bare, click-through, full-viewport layer in both the top-layer and the
     * plain fixed-position fallback.
     */
    :host {
      position: fixed;
      inset: 0;
      z-index: 100000;
      width: auto;
      height: auto;
      max-width: none;
      max-height: none;
      margin: 0;
      padding: 0;
      border: 0;
      background: transparent;
      color: inherit;
      overflow: visible;
      pointer-events: none;
      font-family: var(--hv-font, -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'SF Pro Text', Inter, system-ui, sans-serif);
      -webkit-font-smoothing: antialiased;
    }

    :host::backdrop {
      background: transparent;
    }

    .root {
      position: fixed;
      inset: 0;
      z-index: 100000;
      pointer-events: none;
      display: none;
    }

    .root.visible {
      display: block;
    }

    /* --- backdrop --------------------------------------------------------- */

    .backdrop {
      position: absolute;
      inset: 0;
      opacity: 0;
      transition: opacity 320ms ease;
      backdrop-filter: blur(var(--hvn-blur)) saturate(120%);
      -webkit-backdrop-filter: blur(var(--hvn-blur)) saturate(120%);
    }

    .root.dark .backdrop {
      background: rgba(8, 9, 12, var(--hvn-backdrop-opacity));
    }

    .root.light .backdrop {
      background: rgba(248, 249, 251, var(--hvn-backdrop-opacity));
    }

    .backdrop-on .backdrop {
      opacity: 1;
      pointer-events: auto;
    }

    .tint {
      position: absolute;
      inset: 0;
      background: radial-gradient(60% 60% at 50% 45%, var(--hvn-tint), transparent 70%);
      opacity: calc(var(--hvn-tint-opacity) * 2);
    }

    /* --- fullscreen ------------------------------------------------------- */

    .content {
      position: absolute;
      inset: 0;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 32px;
      padding: 24px;
      box-sizing: border-box;
      text-align: center;
      /* Taps land on the backdrop underneath, which owns the tap handler. */
      pointer-events: none;
    }

    .interactive .content,
    .interactive .pill-body {
      cursor: pointer;
    }

    .fullscreen .glyph {
      opacity: 0;
      transform: translateY(36px) scale(0.94);
      transition:
        opacity 400ms ease,
        transform 460ms cubic-bezier(0.22, 1, 0.36, 1);
    }

    .fullscreen.icon-on .glyph {
      opacity: 1;
      transform: none;
    }

    .fullscreen.exiting .glyph {
      transition: opacity 300ms ease;
      transform: none;
    }

    .fullscreen .text {
      opacity: 0;
      transform: translateY(12px);
      transition:
        opacity 320ms ease,
        transform 320ms ease;
      max-width: 24em;
    }

    .fullscreen.text-on .text {
      opacity: 1;
      transform: none;
    }

    .fullscreen.exiting .text {
      transition: opacity 300ms ease;
      transform: none;
    }

    .fullscreen .title {
      font-size: clamp(26px, 5vw, 56px);
      font-weight: 700;
      letter-spacing: -0.02em;
      line-height: 1.2;
    }

    .fullscreen .message {
      margin-top: 10px;
      font-size: clamp(16px, 2.6vw, 28px);
      line-height: 1.45;
    }

    /* --- pill ------------------------------------------------------------- */

    .pill-wrap {
      position: absolute;
      top: calc(16px + env(safe-area-inset-top, 0px));
      left: 0;
      right: 0;
      display: flex;
      justify-content: center;
      padding: 0 12px;
      box-sizing: border-box;
    }

    .pill-body {
      pointer-events: none;
      display: flex;
      align-items: center;
      gap: 18px;
      min-height: 96px;
      max-width: min(640px, 100%);
      box-sizing: border-box;
      padding: 14px 30px 14px 14px;
      -webkit-backdrop-filter: blur(24px) saturate(180%);
      backdrop-filter: blur(24px) saturate(180%);
      border-radius: 999px;
      text-align: left;
      opacity: 0;
      transform: translateY(calc(-100% - 32px));
      transition:
        opacity 260ms ease,
        transform 440ms cubic-bezier(0.22, 1.1, 0.36, 1);
    }

    .pill.pill-on .pill-body {
      opacity: 1;
      transform: none;
      pointer-events: auto;
    }

    .pill.exiting .pill-body {
      transition:
        opacity 220ms ease 140ms,
        transform 380ms cubic-bezier(0.5, 0, 0.75, 0);
    }

    .root.dark .pill-body {
      background: rgba(20, 18, 32, 0.72);
      background: color-mix(in srgb, var(--hvn-color) 28%, rgba(20, 18, 32, 0.62));
      box-shadow: inset 1.5px 1.5px 0 rgba(255, 255, 255, 0.4), inset -1px -1px 0 rgba(255, 255, 255, 0.12),
        0 24px 60px rgba(0, 0, 0, 0.35);
    }

    .root.light .pill-body {
      background: rgba(255, 255, 255, 0.7);
      background: color-mix(in srgb, var(--hvn-color) 18%, rgba(255, 255, 255, 0.62));
      box-shadow: inset 1.5px 1.5px 0 #fff, inset -1px -1px 0 rgba(255, 255, 255, 0.5), 0 24px 60px rgba(30, 50, 80, 0.2);
    }

    .pill .title {
      font-size: 26px;
      font-weight: 700;
      letter-spacing: -0.01em;
      line-height: 1.25;
    }

    .pill .message {
      margin-top: 2px;
      font-size: 19px;
      line-height: 1.35;
    }

    .pill .text {
      min-width: 0;
    }

    .pill .title,
    .pill .message {
      overflow: hidden;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
    }

    /* --- shared text colours ---------------------------------------------- */

    .root.dark .title {
      color: #ffffff;
    }

    .root.dark .message {
      color: rgba(255, 255, 255, 0.72);
    }

    .root.light .title {
      color: #15181d;
    }

    .root.light .message {
      color: rgba(20, 24, 30, 0.65);
    }

    /* --- reduced motion ---------------------------------------------------- */

    .root.reduced .glyph,
    .root.reduced .text,
    .root.reduced .pill-body {
      transform: none !important;
    }

    .root.reduced .pill-body {
      transition: opacity 220ms ease;
    }
  `;
}

declare global {
  interface HTMLElementTagNameMap {
    'homeview-notification-overlay': FsnOverlay;
  }
}
