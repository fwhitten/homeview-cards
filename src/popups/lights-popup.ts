import { css, html, nothing } from 'lit';
import { state } from 'lit/decorators.js';
import { PopupContent } from './popup-base';
import { areaName, areaOf, entitiesInArea } from '../core/areas';
import { brightnessPct, hex, hsToRgb, inkFor, kelvinToRgb, lightColor, supportsColor, supportsTemp, type RGB } from '../core/color';
import { defineElement } from '../core/register';
import { haptic } from '../core/events';
import type { HassEntity } from '../core/types';

const WHITES = [2200, 2700, 3500, 4500, 6000];
const WHITE_NAMES = ['Candle', 'Warm', 'Soft', 'Neutral', 'Daylight'];
const COLOURS: Array<[string, number, number]> = [
  ['Red', 358, 85], ['Orange', 22, 90], ['Yellow', 50, 95], ['Green', 140, 70], ['Teal', 174, 70],
  ['Sky', 196, 70], ['Blue', 218, 80], ['Indigo', 248, 65], ['Purple', 280, 70], ['Pink', 330, 65],
];

/** Lights pop-up: brightness, white and colour, the area's scenes and every light on its own. */
export class HomeViewLightsPopup extends PopupContent {
  @state() private dragPct?: number;
  @state() private rowDrag?: { id: string; pct: number };
  private sendTimer?: number;

  private get lights(): string[] {
    const c = this.cfg;
    if (c.entities?.length) return c.entities;
    if (c.area && this.hass) return entitiesInArea(this.hass, c.area, 'light');
    if (c.entity && this.hass) {
      // A single light still gets its area's companions, so the pop-up stays useful.
      const area = areaOf(this.hass, c.entity);
      return area ? [c.entity, ...entitiesInArea(this.hass, area, 'light').filter((id) => id !== c.entity)] : [c.entity];
    }
    return [];
  }

  private get primary(): string[] {
    const c = this.cfg;
    return c.entity ? [c.entity] : this.lights;
  }

  private get area(): string | undefined {
    if (!this.hass) return undefined;
    return this.cfg.area ?? (this.cfg.entity ? areaOf(this.hass, this.cfg.entity) : undefined);
  }

  private states(ids: string[]): HassEntity[] {
    return ids.map((id) => this.hass?.states[id]).filter((s): s is HassEntity => !!s);
  }

  popupTitle(): string {
    if (!this.hass) return '';
    if (this.cfg.name) return this.cfg.name;
    if (this.cfg.entity && !this.cfg.area) return this.st(this.cfg.entity)?.attributes.friendly_name ?? '';
    return areaName(this.hass, this.area) ?? 'Lights';
  }

  popupSubtitle(): string {
    const all = this.states(this.primary);
    const on = all.filter((s) => s.state === 'on');
    if (!on.length) return 'All lights off';
    return all.length > 1 ? `${on.length} of ${all.length} on · ${this.level}%` : `On · ${this.level}%`;
  }

  private get level(): number {
    if (this.dragPct !== undefined) return this.dragPct;
    const on = this.states(this.primary).filter((s) => s.state === 'on');
    return on.length ? Math.round(on.reduce((n, s) => n + brightnessPct(s), 0) / on.length) : 0;
  }

  private turnOn(data: Record<string, unknown>, ids = this.primary): void {
    void this.hass?.callService('light', 'turn_on', { entity_id: ids, ...data });
  }

  private setLevel(pct: number, ids = this.primary): void {
    window.clearTimeout(this.sendTimer);
    this.sendTimer = window.setTimeout(() => {
      if (pct <= 0) void this.hass?.callService('light', 'turn_off', { entity_id: ids });
      else this.turnOn({ brightness_pct: pct }, ids);
    }, 120);
  }

  private sliderPct(ev: PointerEvent): number {
    const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
    return Math.round(Math.min(1, Math.max(0, (r.bottom - ev.clientY) / r.height)) * 100);
  }

  private sliderDown = (ev: PointerEvent): void => {
    (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
    this.dragPct = this.sliderPct(ev);
    this.setLevel(this.dragPct);
  };

  private sliderMove = (ev: PointerEvent): void => {
    if (this.dragPct === undefined) return;
    this.dragPct = this.sliderPct(ev);
    this.setLevel(this.dragPct);
  };

  private sliderUp = (): void => {
    haptic('light');
    window.setTimeout(() => (this.dragPct = undefined), 1000);
  };

  private sliderKey = (ev: KeyboardEvent): void => {
    const step = ev.key === 'ArrowUp' || ev.key === 'ArrowRight' ? 10 : ev.key === 'ArrowDown' || ev.key === 'ArrowLeft' ? -10 : 0;
    if (!step) return;
    ev.preventDefault();
    this.setLevel(Math.min(100, Math.max(0, this.level + step)));
  };

  private wheel = (ev: PointerEvent): void => {
    if (ev.type === 'pointermove' && !ev.buttons) return;
    const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
    const x = ev.clientX - (r.left + r.width / 2);
    const y = ev.clientY - (r.top + r.height / 2);
    const radius = r.width / 2;
    const sat = Math.min(100, (Math.hypot(x, y) / radius) * 100);
    const hue = (Math.atan2(x, -y) * 180) / Math.PI;
    if (ev.type === 'pointerdown') (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
    window.clearTimeout(this.sendTimer);
    this.sendTimer = window.setTimeout(() => this.turnOn({ hs_color: [(hue + 360) % 360, Math.round(sat)] }, this.colourIds), 120);
  };

  private get colourIds(): string[] {
    return this.primary.filter((id) => supportsColor(this.hass?.states[id]));
  }

  private get tempIds(): string[] {
    return this.primary.filter((id) => supportsTemp(this.hass?.states[id]) || supportsColor(this.hass?.states[id]));
  }

  private rowPct(ev: PointerEvent): number {
    const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
    return Math.round(Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)) * 100);
  }

  private rowHandlers(id: string) {
    return {
      down: (ev: PointerEvent) => {
        (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
        this.rowDrag = { id, pct: this.rowPct(ev) };
      },
      move: (ev: PointerEvent) => {
        if (this.rowDrag?.id !== id) return;
        this.rowDrag = { id, pct: this.rowPct(ev) };
        this.setLevel(this.rowDrag.pct, [id]);
      },
      up: () => {
        if (this.rowDrag?.id === id) this.setLevel(this.rowDrag.pct, [id]);
        window.setTimeout(() => (this.rowDrag = undefined), 1000);
      },
    };
  }

  private scenes(): HassEntity[] {
    const area = this.area;
    if (!this.hass || !area) return [];
    const ids = this.cfg.scenes?.length ? (this.cfg.scenes as string[]) : entitiesInArea(this.hass, area, 'scene');
    return this.states(ids);
  }

  render() {
    if (!this.hass) return nothing;
    const lvl = this.level;
    const rgb: RGB = lightColor(this.states(this.primary).find((s) => s.state === 'on'));
    const { ink } = inkFor(rgb);
    const anyOn = this.states(this.primary).some((s) => s.state === 'on');
    const scenes = this.scenes();
    const rows = this.states(this.lights);
    const current = this.states(this.primary).find((s) => s.state === 'on');
    const currentHex = current ? hex(lightColor(current)) : '';
    return html`
      <div class="grid">
        <div class="col slider-col">
          <div
            class="slider"
            role="slider"
            tabindex="0"
            aria-label="Brightness"
            aria-valuemin="0"
            aria-valuemax="100"
            aria-valuenow=${lvl}
            @pointerdown=${this.sliderDown}
            @pointermove=${this.sliderMove}
            @pointerup=${this.sliderUp}
            @pointercancel=${this.sliderUp}
            @keydown=${this.sliderKey}
          >
            <div class="level" style="height:${lvl}%;background:${hex(rgb)}"></div>
            <div class="pct" style="color:${lvl > 82 ? ink : 'var(--_ink)'}">${lvl}%</div>
            <button
              class="power"
              style="color:${lvl > 12 ? ink : 'var(--_ink)'}"
              aria-label=${anyOn ? 'Turn off' : 'Turn on'}
              @pointerdown=${(e: Event) => e.stopPropagation()}
              @click=${() => {
                haptic('light');
                void this.hass!.callService('light', anyOn ? 'turn_off' : 'turn_on', { entity_id: this.primary });
              }}
            >
              <ha-icon icon="mdi:power"></ha-icon>
            </button>
          </div>
          <div class="hint">Swipe to dim</div>
        </div>

        <div class="col">
          ${this.tempIds.length
            ? html`<section>
                <h3 class="sec">White</h3>
                <div class="swatches">
                  ${WHITES.map(
                    (k, i) => html`<button
                      class="sw"
                      aria-label=${WHITE_NAMES[i]}
                      style="background:${hex(kelvinToRgb(k))}"
                      @click=${() => this.turnOn({ color_temp_kelvin: k }, this.tempIds)}
                    ></button>`,
                  )}
                </div>
              </section>`
            : nothing}
          ${this.colourIds.length
            ? html`<section>
                  <h3 class="sec">Colour</h3>
                  <div class="swatches colours">
                    ${COLOURS.map(([name, h, s]) => {
                      const c = hex(hsToRgb(h, s));
                      return html`<button
                        class="sw ${c === currentHex ? 'on' : ''}"
                        aria-label=${name}
                        style="background:${c}"
                        @click=${() => this.turnOn({ hs_color: [h, s] }, this.colourIds)}
                      ></button>`;
                    })}
                  </div>
                </section>
                <div
                  class="wheel"
                  role="img"
                  aria-label="Colour wheel, drag to pick a colour"
                  @pointerdown=${this.wheel}
                  @pointermove=${this.wheel}
                ></div>`
            : !this.tempIds.length
              ? html`<p class="sub wrap">These lights only dim.</p>`
              : nothing}
        </div>

        <div class="col">
          ${scenes.length
            ? html`<section>
                <h3 class="sec">Scenes</h3>
                <div class="scenes">
                  ${scenes.map(
                    (s) => html`<button
                      class="scene gl"
                      @click=${() => {
                        haptic('success');
                        void this.hass!.callService('scene', 'turn_on', { entity_id: s.entity_id });
                      }}
                    >
                      <ha-state-icon .hass=${this.hass} .stateObj=${s}></ha-state-icon>
                      <span>${s.attributes.friendly_name ?? s.entity_id}</span>
                    </button>`,
                  )}
                </div>
              </section>`
            : nothing}
          <section>
            <h3 class="sec">Lights</h3>
            <div class="rows">
              ${rows.map((s) => {
                const on = s.state === 'on';
                const pct = this.rowDrag?.id === s.entity_id ? this.rowDrag.pct : brightnessPct(s);
                const c = hex(lightColor(s));
                const h = this.rowHandlers(s.entity_id);
                return html`<div class="row">
                  <button
                    class="round dot"
                    style="background:${on ? c : 'var(--_glass-hi)'};color:${on ? inkFor(lightColor(s)).ink : 'var(--_ink)'}"
                    aria-label="Toggle ${s.attributes.friendly_name}"
                    @click=${() => void this.hass!.callService('light', 'toggle', { entity_id: s.entity_id })}
                  >
                    <ha-state-icon .hass=${this.hass} .stateObj=${s}></ha-state-icon>
                  </button>
                  <div class="rname">${s.attributes.friendly_name ?? s.entity_id}</div>
                  <div
                    class="track"
                    role="slider"
                    aria-label="${s.attributes.friendly_name} brightness"
                    aria-valuenow=${pct}
                    @pointerdown=${h.down}
                    @pointermove=${h.move}
                    @pointerup=${h.up}
                    @pointercancel=${h.up}
                  >
                    <div style="width:${on || this.rowDrag?.id === s.entity_id ? pct : 0}%;background:${c}"></div>
                  </div>
                  <div class="rpct">${s.state === 'unavailable' ? '—' : on ? `${pct}%` : 'Off'}</div>
                </div>`;
              })}
            </div>
          </section>
        </div>
      </div>
    `;
  }

  static styles = [
    ...PopupContent.styles,
    css`
      .grid {
        display: grid;
        grid-template-columns: 200px minmax(0, 360px) minmax(0, 1fr);
        gap: 40px;
        min-height: 560px;
      }
      .col {
        display: flex;
        flex-direction: column;
        gap: 26px;
        min-width: 0;
      }
      .slider-col {
        gap: 12px;
      }
      .slider {
        position: relative;
        flex: 1;
        min-height: 420px;
        border-radius: 48px;
        overflow: hidden;
        background: var(--_glass-hi);
        cursor: ns-resize;
        touch-action: none;
      }
      .level {
        position: absolute;
        left: 0;
        right: 0;
        bottom: 0;
        transition: height 0.15s ease-out;
      }
      .pct {
        position: absolute;
        left: 0;
        right: 0;
        top: 26px;
        text-align: center;
        font-size: 40px;
        font-weight: 600;
        letter-spacing: -0.03em;
        pointer-events: none;
      }
      .power {
        position: absolute;
        left: 50%;
        bottom: 22px;
        width: 56px;
        height: 56px;
        margin-left: -28px;
        border: 0;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.14);
        cursor: pointer;
        --mdc-icon-size: 28px;
      }
      .hint {
        text-align: center;
        font-size: 16px;
        font-weight: 600;
        color: var(--_ink2);
      }
      .swatches {
        display: flex;
        flex-wrap: wrap;
        gap: 14px;
      }
      .colours {
        display: grid;
        grid-template-columns: repeat(5, 52px);
      }
      .sw {
        width: 52px;
        height: 52px;
        border: 0;
        border-radius: 999px;
        cursor: pointer;
        box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.15);
      }
      .sw.on {
        box-shadow: 0 0 0 3px var(--_wall), 0 0 0 6px var(--_ink);
      }
      .wheel {
        flex: none;
        width: 180px;
        height: 180px;
        aspect-ratio: 1;
        border-radius: 50%;
        background: radial-gradient(circle, #fff 0%, rgba(255, 255, 255, 0) 70%),
          conic-gradient(#ff3b30, #ff9500, #ffcc00, #34c759, #5ac8fa, #007aff, #af52de, #ff2d55, #ff3b30);
        box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.15);
        cursor: crosshair;
        touch-action: none;
      }
      .wrap {
        white-space: normal;
      }
      .scenes {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 12px;
      }
      .scene {
        display: flex;
        align-items: center;
        gap: 12px;
        height: 64px;
        padding: 0 16px;
        border: 0;
        border-radius: 20px;
        font: inherit;
        font-size: 18px;
        font-weight: 600;
        color: var(--_ink);
        cursor: pointer;
        text-align: left;
      }
      .scene span {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .rows {
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      .row {
        display: grid;
        grid-template-columns: 44px minmax(90px, 150px) minmax(0, 1fr) 56px;
        align-items: center;
        gap: 14px;
        min-height: 66px;
        padding: 0 16px;
        border-radius: 20px;
        background: var(--_glass);
      }
      .dot {
        width: 44px;
        height: 44px;
        --mdc-icon-size: 22px;
      }
      .rname {
        font-size: 18px;
        font-weight: 600;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .track {
        height: 12px;
        border-radius: 6px;
        background: var(--_track);
        cursor: ew-resize;
        touch-action: none;
        padding: 10px 0;
        background-clip: content-box;
      }
      .track div {
        height: 100%;
        border-radius: 6px;
      }
      .rpct {
        text-align: right;
        font-size: 18px;
        font-weight: 600;
        color: var(--_ink2);
      }
      @media (max-width: 1000px) {
        .grid {
          grid-template-columns: 1fr;
        }
        .slider {
          min-height: 260px;
        }
      }
    `,
  ];
}

defineElement('homeview-lights-popup', HomeViewLightsPopup);
