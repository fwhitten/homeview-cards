import { LitElement, css } from 'lit';
import { property } from 'lit/decorators.js';
import { base, tokens } from '../core/styles';
import type { PopupProps } from '../core/popup-bus';
import type { Mode } from '../core/store';
import type { HassEntity, HomeAssistant } from '../core/types';

/** Shared base for content rendered inside the pop-up host's sheet. */
export abstract class PopupContent extends LitElement {
  @property({ attribute: false }) hass?: HomeAssistant;
  @property({ attribute: false }) props?: PopupProps;
  @property({ reflect: true }) mode: Mode = 'dark';

  protected get cfg(): Record<string, any> {
    return this.props?.config ?? {};
  }

  protected st(id?: string): HassEntity | undefined {
    return id ? this.hass?.states[id] : undefined;
  }

  popupTitle(): string {
    return '';
  }

  popupSubtitle(): string {
    return '';
  }

  static styles = [
    tokens,
    base,
    css`
      :host {
        height: auto;
      }
      .panel {
        position: relative;
        box-sizing: border-box;
        min-width: 0;
        padding: 22px 24px;
        border-radius: 28px;
        background: var(--_glass);
      }
      .sec {
        margin: 0 0 14px;
        font-size: 15px;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--_ink2);
      }
      .seg {
        display: inline-flex;
        gap: 4px;
        padding: 4px;
        border-radius: 999px;
        background: var(--_glass-hi);
      }
      .seg button {
        height: 44px;
        padding: 0 18px;
        border: 0;
        border-radius: 999px;
        font: inherit;
        font-size: 17px;
        font-weight: 600;
        cursor: pointer;
        background: none;
        color: var(--_ink2);
      }
      .seg button[aria-pressed='true'] {
        background: var(--_ink);
        color: var(--_inv);
      }
    `,
  ];
}
