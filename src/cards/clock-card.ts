import { css, html, nothing, type PropertyValues } from 'lit';
import { state } from 'lit/decorators.js';
import { HomeViewCard, type BaseCardConfig } from '../core/base-card';
import type { GridOptions } from '../core/types';
import { clockDigits, longDate } from '../core/format';
import { defineElement, registerCard } from '../core/register';
import { actionsSection, editorFor, layoutSection, type EditorSpec } from '../core/editor';

export interface DepthPhoto {
  /** The full photo. */
  background: string;
  /** The same photo with only the subject kept, on a transparent background (PNG or WebP). */
  foreground?: string;
  /** Numeral colour. Defaults to a light tint sampled from the top of the photo. */
  color?: string;
  /** Where the numerals sit, as a fraction of the tile height from the top. */
  position?: number;
}

export interface ClockCardConfig extends BaseCardConfig {
  photos?: DepthPhoto[];
  /** Minutes between photos when there are several. */
  rotate_minutes?: number;
  show_date?: boolean;
}

/** Light tint of the average colour in the top band of an image, for the numerals. */
const sampleTint = (url: string): Promise<string | undefined> =>
  new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = 24;
        c.height = 24;
        const ctx = c.getContext('2d', { willReadFrequently: true })!;
        ctx.drawImage(img, 0, 0, img.naturalWidth, img.naturalHeight * 0.4, 0, 0, 24, 24);
        const d = ctx.getImageData(0, 0, 24, 24).data;
        let r = 0, g = 0, b = 0;
        for (let i = 0; i < d.length; i += 4) {
          r += d[i];
          g += d[i + 1];
          b += d[i + 2];
        }
        const n = d.length / 4;
        const mix = (v: number) => Math.round(v / n + (255 - v / n) * 0.78);
        resolve(`rgba(${mix(r)},${mix(g)},${mix(b)},0.93)`);
      } catch {
        resolve(undefined);
      }
    };
    img.onerror = () => resolve(undefined);
    img.src = url;
  });

const EDITOR: EditorSpec = {
  schema: (c) => [
    {
      name: 'photos',
      selector: {
        object: {
          multiple: true,
          label_field: 'background',
          fields: {
            background: { label: 'Background photo', required: true, selector: { text: {} } },
            foreground: { label: 'Cut-out foreground (transparent PNG or WebP)', selector: { text: {} } },
            color: { label: 'Numeral colour (optional, sampled from the photo)', selector: { text: {} } },
            position: { label: 'Numeral position from the top', selector: { number: { min: 0, max: 0.8, step: 0.01, mode: 'slider' } } },
          },
        },
      },
    },
    ...((c.photos?.length ?? 0) > 1 ? [{ name: 'rotate_minutes', selector: { number: { min: 1, max: 1440, mode: 'box', unit_of_measurement: 'min' } } }] : []),
    { name: 'show_date', selector: { boolean: {} } },
    actionsSection(),
    layoutSection,
  ],
  labels: { photos: 'Depth photos', rotate_minutes: 'Change photo every', show_date: 'Show the date' },
  helpers: { photos: 'Put the files in /config/www and use /local/… addresses. Without photos a drawn landscape is shown.' },
};

/**
 * Clock (design A): HomeView's portrait clock. Rounded numerals tinted from
 * the photo sit between a background photo and its cut-out foreground, so the
 * subject stands in front of the time.
 */
export class HomeViewClockCard extends HomeViewCard<ClockCardConfig> {
  @state() private now = new Date();
  @state() private tint?: string;
  private timer?: number;
  private tinted?: string;

  static getConfigElement() {
    return editorFor(EDITOR);
  }

  static getStubConfig() {
    return {};
  }

  protected defaults(): Partial<ClockCardConfig> {
    return { rotate_minutes: 30, show_date: false };
  }

  protected watched() {
    return [];
  }

  protected defaultAction(kind: 'tap' | 'hold' | 'double_tap') {
    return kind === 'tap' ? ({ action: 'none' } as const) : undefined;
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.tick();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.clearTimeout(this.timer);
  }

  private tick = (): void => {
    this.now = new Date();
    this.timer = window.setTimeout(this.tick, 60_000 - (Date.now() % 60_000) + 50);
  };

  private get photo(): DepthPhoto | undefined {
    const list = this.config.photos ?? [];
    if (!list.length) return undefined;
    const slot = Math.floor(this.now.getTime() / ((this.config.rotate_minutes ?? 30) * 60_000));
    return list[slot % list.length];
  }

  protected updated(changed: PropertyValues): void {
    super.updated(changed);
    const p = this.photo;
    if (p && !p.color && this.tinted !== p.background) {
      this.tinted = p.background;
      void sampleTint(p.background).then((t) => (this.tint = t));
    }
  }

  render() {
    if (!this.hass) return nothing;
    const p = this.photo;
    const digits = clockDigits(this.hass, this.now);
    const color = p?.color ?? this.tint ?? 'rgba(255,232,216,0.93)';
    const top = (p?.position ?? 0.13) * 100;
    return html`
      <ha-card class="tile clock ${this.clickable ? 'clickable' : ''}" role="img" aria-label="${digits}, ${longDate(this.hass, this.now)}">
        ${p
          ? html`<img class="ph" src=${p.background} alt="" />`
          : html`<div class="ph fallback" aria-hidden="true">
              <svg viewBox="0 0 426 436" preserveAspectRatio="xMidYMid slice">
                <defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#25335e"></stop><stop offset=".48" stop-color="#7a65a2"></stop><stop offset=".78" stop-color="#ec9d78"></stop><stop offset="1" stop-color="#f6c891"></stop></linearGradient></defs>
                <rect width="426" height="436" fill="url(#s)"></rect>
                <circle cx="322" cy="262" r="34" fill="#ffe3bb" opacity=".85"></circle>
                <path d="M0 282 L52 244 L96 266 L150 222 L206 258 L262 228 L318 262 L370 236 L426 268 V436 H0Z" fill="#7a6297" opacity=".92"></path>
              </svg>
            </div>`}
        ${this.config.show_date ? html`<div class="date">${longDate(this.hass, this.now)}</div>` : nothing}
        <div class="digits" style="top:${top}%;color:${color}">${digits}</div>
        ${p?.foreground
          ? html`<img class="ph" src=${p.foreground} alt="" />`
          : !p
            ? html`<div class="ph fallback" aria-hidden="true">
                <svg viewBox="0 0 426 436" preserveAspectRatio="xMidYMid slice">
                  <path d="M0 436 V250 L34 236 L72 254 L110 196 L140 212 L176 166 L206 190 L236 180 L270 214 L306 206 L350 240 L392 228 L426 244 V436Z" fill="#1c1630"></path>
                </svg>
              </div>`
            : nothing}
      </ha-card>
    `;
  }

  getGridOptions(): GridOptions {
    return { columns: 12, rows: 6, min_columns: 6, min_rows: 3 };
  }

  getCardSize(): number {
    return 7;
  }

  static styles = [
    ...HomeViewCard.styles,
    css`
      .clock {
        background: #2a2547;
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
      .fallback svg {
        width: 100%;
        height: 100%;
      }
      .digits {
        position: absolute;
        left: 0;
        right: 0;
        text-align: center;
        font-family: var(--_font-rounded);
        font-weight: 600;
        font-size: min(36cqw, 46cqh);
        letter-spacing: -0.02em;
        line-height: 1;
        font-variant-numeric: tabular-nums;
        text-shadow: 0 4px 40px rgba(40, 30, 70, 0.25);
        white-space: nowrap;
      }
      .date {
        position: absolute;
        left: 0;
        right: 0;
        top: 5%;
        text-align: center;
        font-size: max(15px, 4.5cqw);
        font-weight: 600;
        color: rgba(255, 255, 255, 0.92);
      }
    `,
  ];
}

defineElement('homeview-clock-card', HomeViewClockCard);
registerCard({
  type: 'homeview-clock-card',
  name: 'HomeView Clock',
  description: 'Depth-photo clock: the time sits between a photo and its cut-out subject.',
  docs: 'clock',
});
