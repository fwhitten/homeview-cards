import { LitElement, css, html, nothing } from 'lit';
import { property, state } from 'lit/decorators.js';
import { tokens } from './styles';
import { haptic, prefersReducedMotion } from './events';
import { defineElement } from './register';
import type { Mode } from './store';

export interface MenuItem {
  value: string;
  label: string;
  icon?: string;
}

/**
 * A small glass menu that drops from a chip (or anything), listing options
 * with the current one ticked. It lives in document.body so no dashboard
 * container clips it; a tap outside or Escape closes it.
 */
export class HomeViewMenu extends LitElement {
  @property({ attribute: false }) items: MenuItem[] = [];
  @property() current?: string;
  @property() heading?: string;
  @property({ reflect: true }) mode: Mode = 'dark';
  @property({ type: Boolean, reflect: true }) open = false;
  @state() private pos = { left: 0, top: 0, maxHeight: 400, origin: 'top' };
  onPick?: (value: string) => void;

  place(anchor: HTMLElement): void {
    const r = anchor.getBoundingClientRect();
    const width = 280;
    const gap = 10;
    const below = window.innerHeight - r.bottom - gap - 16;
    const above = r.top - gap - 16;
    const down = below >= 220 || below >= above;
    this.pos = {
      left: Math.max(12, Math.min(window.innerWidth - width - 12, r.left)),
      top: down ? r.bottom + gap : r.top - gap,
      maxHeight: Math.max(160, down ? below : above),
      origin: down ? 'top' : 'bottom',
    };
  }

  /** Closes by itself after 10 seconds without a touch. */
  private idle?: number;
  private poke = (): void => {
    window.clearTimeout(this.idle);
    this.idle = window.setTimeout(this.close, 10_000);
  };

  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener('keydown', this.onKey);
    window.addEventListener('resize', this.close);
    for (const type of ['pointerdown', 'pointermove', 'wheel', 'keydown']) this.addEventListener(type, this.poke, { passive: true });
    this.poke();
    requestAnimationFrame(() => (this.open = true));
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener('keydown', this.onKey);
    window.removeEventListener('resize', this.close);
    window.clearTimeout(this.idle);
  }

  private onKey = (ev: KeyboardEvent): void => {
    if (ev.key === 'Escape') this.close();
  };

  close = (): void => {
    this.open = false;
    window.setTimeout(() => this.remove(), prefersReducedMotion() ? 0 : 180);
  };

  private pick(value: string) {
    return (ev: Event) => {
      ev.stopPropagation();
      haptic('selection');
      if (value !== this.current) this.onPick?.(value);
      this.current = value;
      window.setTimeout(this.close, 120);
    };
  }

  render() {
    const p = this.pos;
    const style = `left:${p.left}px;${p.origin === 'top' ? `top:${p.top}px` : `bottom:${window.innerHeight - p.top}px`};max-height:${p.maxHeight}px;transform-origin:${p.origin} left`;
    return html`
      <div class="scrim" @click=${this.close}></div>
      <div class="menu" role="menu" aria-label=${this.heading ?? 'Options'} style=${style}>
        ${this.heading ? html`<div class="head">${this.heading}</div>` : nothing}
        ${this.items.map(
          (it) => html`<button role="menuitemradio" aria-checked=${it.value === this.current} @click=${this.pick(it.value)}>
            ${it.icon ? html`<ha-icon .icon=${it.icon}></ha-icon>` : nothing}
            <span>${it.label}</span>
            <ha-icon class="tick" icon="mdi:check"></ha-icon>
          </button>`,
        )}
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
        font-family: var(--_font);
        -webkit-font-smoothing: antialiased;
        color: var(--_ink);
      }
      .scrim {
        position: absolute;
        inset: 0;
      }
      .menu {
        position: absolute;
        box-sizing: border-box;
        width: 280px;
        overflow: auto;
        padding: 8px;
        border-radius: 26px;
        background: var(--hv-popup-background, rgba(30, 32, 44, 0.72));
        box-shadow: inset 1.5px 1.5px 0 rgba(255, 255, 255, 0.3), inset -1px -1px 0 rgba(255, 255, 255, 0.1), 0 24px 70px rgba(0, 0, 0, 0.45);
        -webkit-backdrop-filter: blur(40px) saturate(180%);
        backdrop-filter: blur(40px) saturate(180%);
        opacity: 0;
        transform: scale(0.92);
        transition: transform 0.2s cubic-bezier(0.2, 0.9, 0.3, 1.2), opacity 0.15s ease;
      }
      :host([mode='light']) .menu {
        background: rgba(255, 255, 255, 0.75);
      }
      :host([open]) .menu {
        opacity: 1;
        transform: none;
      }
      .head {
        padding: 8px 14px 6px;
        font-size: 14px;
        font-weight: 700;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        color: var(--_ink2);
      }
      button {
        width: 100%;
        min-height: 54px;
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 0 14px;
        border: 0;
        border-radius: 18px;
        background: none;
        color: inherit;
        font: inherit;
        font-size: 18px;
        font-weight: 600;
        text-align: left;
        cursor: pointer;
        --mdc-icon-size: 22px;
        -webkit-tap-highlight-color: transparent;
      }
      button span {
        flex: 1;
      }
      button[aria-checked='true'] {
        background: var(--_glass-hi);
      }
      .tick {
        visibility: hidden;
      }
      button[aria-checked='true'] .tick {
        visibility: visible;
      }
      button:focus-visible {
        outline: 3px solid var(--_ink);
        outline-offset: -3px;
      }
      @media (prefers-reduced-motion: reduce) {
        .menu {
          transition: none;
        }
      }
    `,
  ];
}

defineElement('homeview-menu', HomeViewMenu);

/** Open a menu under (or above) `anchor`. Returns the menu, already showing. */
export const openMenu = (anchor: HTMLElement, opts: { items: MenuItem[]; current?: string; heading?: string; mode?: Mode; onPick: (value: string) => void }): HomeViewMenu => {
  document.body.querySelectorAll('homeview-menu').forEach((m) => (m as HomeViewMenu).close());
  const menu = document.createElement('homeview-menu') as HomeViewMenu;
  menu.items = opts.items;
  menu.current = opts.current;
  menu.heading = opts.heading;
  menu.mode = opts.mode ?? 'dark';
  menu.onPick = opts.onPick;
  menu.place(anchor);
  document.body.appendChild(menu);
  return menu;
};
