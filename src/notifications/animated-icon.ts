import { LitElement, html, css, svg, nothing, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { styleMap } from 'lit/directives/style-map.js';
import { TRIANGLE_PATH } from './geometry';
import type { HassEntity, HomeAssistant, NotificationType } from './types';

const RING_RADIUS = 51;
const RING_WIDTH = 10;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

export const FALLBACK_ICON: Record<NotificationType, string> = {
  success: 'mdi:bell',
  warning: 'mdi:alert-outline',
  progress: 'mdi:timer-sand',
};

/** How long each type's icon effect takes, in ms, at full motion. */
export const EFFECT_DURATION: Record<NotificationType, number> = {
  success: 900,
  warning: 1060,
  progress: 1200,
};

/**
 * The notification glyph: a coloured shape with the entity icon composited
 * *out* of it.
 *
 * The cut-out is done with `mix-blend-mode: destination-out` inside an
 * isolated stacking context rather than an SVG `<mask>`, which means the shape
 * can be punched through by a live `<ha-icon>` element. That keeps every MDI
 * icon and every custom icon pack available without bundling any path data.
 *
 * Layer order inside `.stack`:
 *   1. the shape            (normal)
 *   2. the icon             (destination-out -> punches the icon hole)
 *   3. the mark's halo      (normal        -> paints shape colour back)
 *   4. the mark             (destination-out -> punches the tick / bang)
 */
@customElement('homeview-notification-icon')
export class FsnAnimatedIcon extends LitElement {
  @property({ attribute: false }) public type: NotificationType = 'success';
  @property({ attribute: false }) public icon?: string;
  @property({ attribute: false }) public stateObj?: HassEntity;
  @property({ attribute: false }) public hass?: HomeAssistant;
  @property({ attribute: false }) public color = '#43a047';
  @property({ attribute: false }) public progress = 0;
  @property({ type: Number }) public size = 160;
  /** Multiplier applied to every duration. Near-zero for reduced motion. */
  @property({ type: Number }) public motion = 1;

  @state() private _playing = false;

  /** Restart the icon effect from the top. */
  public async play(): Promise<void> {
    this._playing = false;
    await this.updateComplete;

    // Dropping the class is not enough on its own. Both updates land inside a
    // single frame, so the browser never recomputes style between them and
    // carries the already-finished animations straight over - which would show
    // the second notification in a queue with its effect already played out.
    // Cancel them explicitly, then force a style flush before re-arming.
    const stack = this.renderRoot.querySelector('.stack');
    stack?.getAnimations({ subtree: true }).forEach((animation) => animation.cancel());
    void this.offsetWidth;

    this._playing = true;
    await this.updateComplete;
  }

  public reset(): void {
    this._playing = false;
  }

  protected render(): TemplateResult {
    const clamped = Math.max(0, Math.min(100, this.progress));
    const styles = styleMap({
      '--hvn-size': `${this.size}px`,
      '--hvn-color': this.color,
      '--hvn-motion': String(this.motion),
      '--hvn-ring-circumference': `${RING_CIRCUMFERENCE.toFixed(3)}`,
      '--hvn-ring-offset': `${(RING_CIRCUMFERENCE * (1 - clamped / 100)).toFixed(3)}`,
    });

    return html`
      <div class="stack ${this.type} ${this._playing ? 'play' : ''}" style=${styles}>
        ${this.type === 'progress' ? this._renderRing() : this._renderShape()}
        <div class="layer icon-layer">${this._renderGlyph()}</div>
        ${this.type === 'success' ? this._renderMark(this._tick()) : nothing}
        ${this.type === 'warning' ? this._renderMark(this._bang()) : nothing}
      </div>
    `;
  }

  /**
   * Prefer `ha-state-icon` when we only have an entity: it applies the same
   * domain and device_class defaults the rest of the dashboard uses, so the
   * notification matches what the entity looks like everywhere else.
   */
  private _renderGlyph(): TemplateResult {
    if (this.icon) {
      return html`<ha-icon .icon=${this.icon}></ha-icon>`;
    }
    if (this.stateObj) {
      return html`<ha-state-icon .hass=${this.hass} .stateObj=${this.stateObj}></ha-state-icon>`;
    }
    return html`<ha-icon .icon=${FALLBACK_ICON[this.type]}></ha-icon>`;
  }

  private _renderShape(): TemplateResult {
    return html`
      <svg class="layer shape" viewBox="0 0 120 120" aria-hidden="true">
        ${this.type === 'success'
          ? svg`<circle cx="60" cy="60" r="56"></circle>`
          : svg`<path d=${TRIANGLE_PATH}></path>`}
      </svg>
    `;
  }

  private _renderRing(): TemplateResult {
    return html`
      <svg class="layer ring" viewBox="0 0 120 120" aria-hidden="true">
        <circle class="track" cx="60" cy="60" r=${RING_RADIUS}></circle>
        <circle class="value" cx="60" cy="60" r=${RING_RADIUS}></circle>
      </svg>
    `;
  }

  /**
   * The mark is drawn twice: once fat in the shape colour to carve a gap out
   * of the icon behind it, once at its true weight as a cut-out.
   */
  private _renderMark(path: TemplateResult): TemplateResult {
    return html`
      <svg class="layer mark-halo" viewBox="0 0 120 120" aria-hidden="true">${path}</svg>
      <svg class="layer mark-cut" viewBox="0 0 120 120" aria-hidden="true">${path}</svg>
    `;
  }

  private _tick(): TemplateResult {
    return svg`<path class="tick" pathLength="100" d="M 37 63 L 53 79 L 84 44"></path>`;
  }

  private _bang(): TemplateResult {
    return svg`
      <g class="bang">
        <rect x="53.25" y="37" width="13.5" height="39" rx="6.75"></rect>
        <circle cx="60" cy="88" r="7.25"></circle>
      </g>
    `;
  }

  static styles = css`
    :host {
      display: block;
      line-height: 0;
    }

    .stack {
      position: relative;
      width: var(--hvn-size);
      height: var(--hvn-size);
      /* Confines destination-out compositing to this element. */
      isolation: isolate;
    }

    .layer {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
      /*
       * border-box matters: the warning layer is nudged with padding, and under
       * content-box that padding would be added to the declared 100% height and
       * shift the icon by the whole amount instead of insetting it.
       */
      box-sizing: border-box;
    }

    .shape {
      fill: var(--hvn-color);
    }

    /* --- the punched-out icon ------------------------------------------- */

    .icon-layer {
      display: flex;
      align-items: center;
      justify-content: center;
      mix-blend-mode: destination-out;
      color: #000;
    }

    .stack.success .icon-layer ha-icon,
    .stack.success .icon-layer ha-state-icon {
      --mdc-icon-size: calc(var(--hvn-size) * 0.44);
    }

    .stack.warning .icon-layer {
      /*
       * Sit the icon between the triangle's optical centre (60) and its
       * centroid (71.5). Padding on a centred flex box moves the content centre
       * by half the padding, so 0.133 lands it on y=68 of the 120-unit viewBox -
       * low enough to look settled in the triangle, high enough that there is
       * still width to hold it.
       */
      padding-top: calc(var(--hvn-size) * 0.133);
    }

    .stack.warning .icon-layer ha-icon,
    .stack.warning .icon-layer ha-state-icon {
      --mdc-icon-size: calc(var(--hvn-size) * 0.46);
    }

    /* Progress keeps its icon solid and tinted rather than cut out. */
    .stack.progress .icon-layer {
      mix-blend-mode: normal;
      color: var(--hvn-color);
    }

    .stack.progress .icon-layer ha-icon,
    .stack.progress .icon-layer ha-state-icon {
      --mdc-icon-size: calc(var(--hvn-size) * 0.4);
    }

    /* --- the tick / bang ------------------------------------------------- */

    .mark-halo {
      fill: var(--hvn-color);
      stroke: var(--hvn-color);
    }

    .mark-cut {
      fill: #000;
      stroke: #000;
      mix-blend-mode: destination-out;
    }

    .tick {
      fill: none;
      stroke-linecap: round;
      stroke-linejoin: round;
      stroke-dasharray: 100;
      stroke-dashoffset: 100;
    }

    .mark-halo .tick {
      stroke-width: 17;
    }

    .mark-cut .tick {
      stroke-width: 8.5;
    }

    .mark-halo .bang {
      stroke-width: 10;
      stroke-linejoin: round;
      paint-order: stroke;
    }

    .mark-cut .bang {
      stroke-width: 0;
    }

    .bang {
      opacity: 0;
      transform-origin: 60px 66px;
    }

    /* --- animations ------------------------------------------------------ */

    .stack.success.play .tick {
      animation: draw calc(560ms * var(--hvn-motion)) cubic-bezier(0.65, 0, 0.35, 1)
        calc(260ms * var(--hvn-motion)) forwards;
    }

    /*
     * Warning resolves the opposite way round from success: the bare triangle
     * is stamped with an exclamation mark, which then gives way to the entity
     * icon so you can see what is actually complaining.
     */
    .stack.warning .icon-layer {
      opacity: 0;
    }

    .stack.warning.play .icon-layer {
      animation: fade-in calc(300ms * var(--hvn-motion)) ease
        calc(740ms * var(--hvn-motion)) forwards;
    }

    .stack.warning.play .bang {
      animation:
        bang-in calc(340ms * var(--hvn-motion)) cubic-bezier(0.34, 1.3, 0.64, 1)
          calc(60ms * var(--hvn-motion)) forwards,
        bang-out calc(260ms * var(--hvn-motion)) ease calc(740ms * var(--hvn-motion))
          forwards;
    }

    .ring .track {
      fill: none;
      stroke: var(--hvn-color);
      opacity: 0.18;
      stroke-width: ${RING_WIDTH};
    }

    .ring .value {
      fill: none;
      stroke: var(--hvn-color);
      stroke-width: ${RING_WIDTH};
      stroke-linecap: round;
      stroke-dasharray: var(--hvn-ring-circumference);
      stroke-dashoffset: var(--hvn-ring-circumference);
      transform: rotate(-90deg);
      transform-origin: 50% 50%;
    }

    .stack.progress.play .value {
      animation: fill-ring calc(1100ms * var(--hvn-motion)) cubic-bezier(0.22, 1, 0.36, 1)
        calc(80ms * var(--hvn-motion)) forwards;
    }

    @keyframes draw {
      to {
        stroke-dashoffset: 0;
      }
    }

    @keyframes fade-in {
      to {
        opacity: 1;
      }
    }

    @keyframes bang-out {
      to {
        opacity: 0;
      }
    }

    @keyframes bang-in {
      from {
        opacity: 0;
        transform: scale(0.6);
      }
      to {
        opacity: 1;
        transform: scale(1);
      }
    }

    @keyframes fill-ring {
      to {
        stroke-dashoffset: var(--hvn-ring-offset);
      }
    }
  `;
}

declare global {
  interface HTMLElementTagNameMap {
    'homeview-notification-icon': FsnAnimatedIcon;
  }
}
