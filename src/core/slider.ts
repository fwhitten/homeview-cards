import { LitElement, css, html, nothing } from 'lit';
import { property, state } from 'lit/decorators.js';
import { tokens } from './styles';
import { fireEvent, haptic } from './events';
import { defineElement } from './register';

/**
 * A wide, finger-sized slider: a glass track the colour fills from the left,
 * the label and value inside it, and optionally a power button at its left
 * end. Drag anywhere along it to change the value (relative to where you
 * started, so a tap never jumps it); vertical swipes still scroll the page.
 *
 * Events: `slide` while dragging (detail: value), `value-change` when let go,
 * and `power` when the power button is tapped.
 */
export class HomeViewSlider extends LitElement {
  @property({ type: Number }) value = 0;
  @property({ type: Number }) min = 0;
  @property({ type: Number }) max = 100;
  @property({ type: Number }) step = 1;
  @property() label = '';
  /** Text for the value; defaults to the number with `unit`. */
  @property() display?: string;
  @property() unit = '%';
  @property() color = 'var(--_ink)';
  /** Show a power button inside the track, at its left end. */
  @property({ type: Boolean }) power = false;
  @property({ type: Boolean }) on = true;
  @property({ type: Boolean, reflect: true }) disabled = false;
  @property() icon?: string;
  /** The theme mode of the pop-up it sits in, for the glass and ink colours. */
  @property({ reflect: true }) mode = 'dark';
  @state() private dragging?: number;
  private startX = 0;
  private startY = 0;
  private base = 0;
  private pointer = -1;
  private engaged = false;

  private get shown(): number {
    return this.dragging ?? this.value;
  }

  private down = (ev: PointerEvent): void => {
    if (this.disabled || (ev.target as HTMLElement).closest('.pwr')) return;
    this.pointer = ev.pointerId;
    this.startX = ev.clientX;
    this.startY = ev.clientY;
    this.base = this.value;
    this.engaged = false;
  };

  private move = (ev: PointerEvent): void => {
    if (ev.pointerId !== this.pointer) return;
    const dx = ev.clientX - this.startX;
    const dy = ev.clientY - this.startY;
    if (!this.engaged) {
      // A vertical swipe is the page scrolling: let it go.
      if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) {
        this.pointer = -1;
        return;
      }
      if (Math.abs(dx) < 6) return;
      this.engaged = true;
      try {
        (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
      } catch {
        /* capture can fail if the pointer already left */
      }
      haptic('selection');
    }
    const track = this.renderRoot.querySelector('.track') as HTMLElement;
    const span = this.max - this.min;
    const raw = this.base + (dx / Math.max(1, track.clientWidth)) * span;
    const v = Math.min(this.max, Math.max(this.min, Math.round(raw / this.step) * this.step));
    if (v !== this.dragging) {
      this.dragging = v;
      fireEvent(this, 'slide', v);
    }
  };

  private up = (ev: PointerEvent): void => {
    if (ev.pointerId !== this.pointer) return;
    this.pointer = -1;
    if (this.engaged && this.dragging !== undefined) {
      const v = this.dragging;
      fireEvent(this, 'value-change', v);
      // Hold the new value until the entity reports it, so the fill doesn't snap back.
      window.setTimeout(() => (this.dragging = undefined), 1500);
    }
    this.engaged = false;
  };

  private key = (ev: KeyboardEvent): void => {
    const d = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[ev.key];
    if (!d || this.disabled) return;
    ev.preventDefault();
    const v = Math.min(this.max, Math.max(this.min, this.value + d * this.step * (ev.shiftKey ? 10 : 1)));
    fireEvent(this, 'value-change', v);
  };

  private togglePower = (ev: Event): void => {
    ev.stopPropagation();
    haptic('light');
    fireEvent(this, 'power', !this.on);
  };

  render() {
    const v = this.shown;
    const frac = (v - this.min) / (this.max - this.min || 1);
    const fill = this.power && !this.on && this.dragging === undefined ? 0 : frac;
    const text = this.display ?? `${Math.round(v)}${this.unit}`;
    return html`<div
      class="track"
      role="slider"
      tabindex=${this.disabled ? -1 : 0}
      aria-label=${this.label}
      aria-valuemin=${this.min}
      aria-valuemax=${this.max}
      aria-valuenow=${v}
      aria-valuetext=${text}
      @pointerdown=${this.down}
      @pointermove=${this.move}
      @pointerup=${this.up}
      @pointercancel=${this.up}
      @keydown=${this.key}
    >
      <div class="fill" style="width:${fill * 100}%;background:${this.color}"></div>
      ${this.power
        ? html`<button class="pwr ${this.on ? 'on' : ''}" aria-label=${this.on ? `Turn ${this.label} off` : `Turn ${this.label} on`} aria-pressed=${this.on} @click=${this.togglePower}>
            <ha-icon icon="mdi:power"></ha-icon>
          </button>`
        : this.icon
          ? html`<ha-icon class="lead" .icon=${this.icon}></ha-icon>`
          : nothing}
      <span class="label">${this.label}</span>
      <span class="val">${this.power && !this.on && this.dragging === undefined ? 'Off' : text}</span>
    </div>`;
  }

  static styles = [
    tokens,
    css`
      :host {
        display: block;
        --_h: var(--hv-slider-height, 60px);
      }
      :host([disabled]) {
        opacity: 0.45;
      }
      .track {
        position: relative;
        display: flex;
        align-items: center;
        gap: 12px;
        height: var(--_h);
        padding: 0 18px 0 8px;
        border-radius: 20px;
        overflow: hidden;
        background: var(--_glass-hi);
        touch-action: pan-y;
        cursor: ew-resize;
        user-select: none;
        -webkit-user-select: none;
        -webkit-tap-highlight-color: transparent;
        outline: none;
      }
      .track:focus-visible {
        box-shadow: 0 0 0 3px var(--_ink);
      }
      .fill {
        position: absolute;
        left: 0;
        top: 0;
        bottom: 0;
        opacity: 0.62;
        transition: width 0.18s ease;
      }
      .pwr {
        position: relative;
        flex: none;
        width: 44px;
        height: 44px;
        display: grid;
        place-items: center;
        border: 0;
        border-radius: 14px;
        cursor: pointer;
        background: rgba(0, 0, 0, 0.18);
        color: var(--_ink2);
        --mdc-icon-size: 22px;
      }
      .pwr.on {
        background: rgba(255, 255, 255, 0.92);
        color: #1a1a1f;
      }
      .lead {
        position: relative;
        margin-left: 10px;
        --mdc-icon-size: 24px;
      }
      .label,
      .val {
        position: relative;
        font-size: 18px;
        font-weight: 600;
        white-space: nowrap;
      }
      .label {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        padding-left: 4px;
      }
      .val {
        font-variant-numeric: tabular-nums;
      }
    `,
  ];
}

defineElement('homeview-slider', HomeViewSlider);
