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
 * While dragging it skips Lit entirely: the fill (a GPU transform) and the
 * value text are written straight to the DOM once per frame, so it keeps up
 * with the finger however busy the page is.
 *
 * Events: `slide` while dragging (once per frame, detail: value),
 * `value-change` when let go, and `power` when the power button is tapped.
 */
export class HomeViewSlider extends LitElement {
  @property({ type: Number }) value = 0;
  @property({ type: Number }) min = 0;
  @property({ type: Number }) max = 100;
  @property({ type: Number }) step = 1;
  @property() label = '';
  /** Text for the value when not dragging; defaults to the number with `unit`. */
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
  /** The value just set here, held until the entity reports it so the fill doesn't snap back. */
  @state() private held?: number;
  private heldTimer?: number;
  private startX = 0;
  private startY = 0;
  private base = 0;
  private pointer = -1;
  private engaged = false;
  private live = 0;
  private width = 1;
  private frame = 0;
  /** The fill's fraction at the last render: applied in updated(), as the drag writes it directly. */
  private frac = 0;
  private valText = '';

  private get shown(): number {
    return this.engaged ? this.live : this.held ?? this.value;
  }

  private text(v: number): string {
    return `${Math.round(v)}${this.unit}`;
  }

  private down = (ev: PointerEvent): void => {
    if (this.disabled || (ev.target as HTMLElement).closest('.pwr')) return;
    this.pointer = ev.pointerId;
    this.startX = ev.clientX;
    this.startY = ev.clientY;
    this.base = this.shown;
    this.engaged = false;
  };

  private move = (ev: PointerEvent): void => {
    if (ev.pointerId !== this.pointer) return;
    const dx = ev.clientX - this.startX;
    if (!this.engaged) {
      const dy = ev.clientY - this.startY;
      // A vertical swipe is the page scrolling: let it go.
      if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) {
        this.pointer = -1;
        return;
      }
      if (Math.abs(dx) < 6) return;
      this.engaged = true;
      this.live = this.base;
      const track = this.renderRoot.querySelector('.track') as HTMLElement;
      this.width = Math.max(1, track.clientWidth);
      track.classList.add('live');
      try {
        track.setPointerCapture(ev.pointerId);
      } catch {
        /* capture can fail if the pointer already left */
      }
      haptic('selection');
    }
    const span = this.max - this.min;
    const raw = this.base + (dx / this.width) * span;
    const v = Math.min(this.max, Math.max(this.min, Math.round(raw / this.step) * this.step));
    if (v === this.live) return;
    this.live = v;
    if (!this.frame) this.frame = requestAnimationFrame(this.paint);
  };

  /** One frame of a drag: the fill and the number, straight to the DOM, then tell the parent. */
  private paint = (): void => {
    this.frame = 0;
    const v = this.live;
    const fill = this.renderRoot.querySelector('.fill') as HTMLElement | null;
    const val = this.renderRoot.querySelector('.val');
    if (fill) fill.style.transform = `scaleX(${(v - this.min) / (this.max - this.min || 1)})`;
    if (val) val.textContent = this.text(v);
    fireEvent(this, 'slide', v);
  };

  private up = (ev: PointerEvent): void => {
    if (ev.pointerId !== this.pointer) return;
    this.pointer = -1;
    if (!this.engaged) return;
    this.engaged = false;
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.renderRoot.querySelector('.track')?.classList.remove('live');
    this.hold(this.live);
    fireEvent(this, 'value-change', this.live);
  };

  private hold(v: number): void {
    this.held = v;
    window.clearTimeout(this.heldTimer);
    this.heldTimer = window.setTimeout(() => (this.held = undefined), 2500);
  }

  protected willUpdate(changed: Map<string, unknown>): void {
    // The entity caught up: show its value again.
    if (changed.has('value') && this.held !== undefined && Math.abs(this.value - this.held) <= this.step) this.held = undefined;
  }

  /** The fill and the number are written here rather than in the template, as a drag writes them directly too. */
  protected updated(): void {
    (this.renderRoot.querySelector('.fill') as HTMLElement | null)?.style.setProperty('transform', `scaleX(${this.frac})`);
    const val = this.renderRoot.querySelector('.val');
    if (val) val.textContent = this.valText;
  }

  private key = (ev: KeyboardEvent): void => {
    const d = ({ ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 } as Record<string, number>)[ev.key];
    if (!d || this.disabled) return;
    ev.preventDefault();
    const v = Math.min(this.max, Math.max(this.min, this.shown + d * this.step * (ev.shiftKey ? 10 : 1)));
    this.hold(v);
    fireEvent(this, 'value-change', v);
  };

  private togglePower = (ev: Event): void => {
    ev.stopPropagation();
    haptic('light');
    fireEvent(this, 'power', !this.on);
  };

  render() {
    const v = this.shown;
    const off = this.power && !this.on && this.held === undefined && !this.engaged;
    this.frac = off ? 0 : (v - this.min) / (this.max - this.min || 1);
    const text = this.engaged || this.held !== undefined ? this.text(v) : this.display ?? this.text(v);
    this.valText = off ? (this.display === 'Unavailable' ? this.display : 'Off') : text;
    return html`<div
      class="track ${this.engaged ? 'live' : ''}"
      role="slider"
      tabindex=${this.disabled ? -1 : 0}
      aria-label=${this.label}
      aria-valuemin=${this.min}
      aria-valuemax=${this.max}
      aria-valuenow=${v}
      aria-valuetext=${off ? 'Off' : text}
      @pointerdown=${this.down}
      @pointermove=${this.move}
      @pointerup=${this.up}
      @pointercancel=${this.up}
      @keydown=${this.key}
    >
      <div class="fill" style="background:${this.color}"></div>
      ${this.power
        ? html`<button class="pwr ${this.on ? 'on' : ''}" aria-label=${this.on ? `Turn ${this.label} off` : `Turn ${this.label} on`} aria-pressed=${this.on} @click=${this.togglePower}>
            <ha-icon icon="mdi:power"></ha-icon>
          </button>`
        : this.icon
          ? html`<ha-icon class="lead" .icon=${this.icon}></ha-icon>`
          : nothing}
      <span class="label">${this.label}</span>
      <span class="val"></span>
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
        /* Its own layer, so the fill moving never repaints the page around it. */
        contain: layout paint;
      }
      .track:focus-visible {
        box-shadow: inset 0 0 0 3px var(--_ink);
      }
      .fill {
        position: absolute;
        inset: 0;
        transform-origin: left center;
        opacity: 0.62;
        transition: transform 0.18s ease;
        will-change: transform;
      }
      /* Under the finger: no easing, so it never lags behind. */
      .track.live .fill {
        transition: none;
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
