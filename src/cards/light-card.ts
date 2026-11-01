import { css, html, nothing } from 'lit';
import { state } from 'lit/decorators.js';
import { HomeViewCard, type BaseCardConfig } from '../core/base-card';
import type { DragHandlers } from '../core/gestures';
import type { GridOptions, HassEntity } from '../core/types';
import { areaName, entitiesInArea } from '../core/areas';
import { brightnessPct, hex, inkFor, lightColor, supportsBrightness } from '../core/color';
import { defineElement, registerCard } from '../core/register';
import { haptic } from '../core/events';
import { actionsSection, appearanceSection, choose, editorFor, layoutSection, type EditorSpec } from '../core/editor';

export interface LightCardConfig extends BaseCardConfig {
  /** A single light. Use this or `area` / `entities`. */
  entity?: string;
  /** Every visible light in an area. */
  area?: string;
  /** An explicit group of lights. */
  entities?: string[];
  /** Which of entity / area / entities to use. Inferred when left out. */
  source?: 'entity' | 'area' | 'entities';
  /** Drag direction for dimming. Defaults to vertical. */
  swipe?: 'vertical' | 'horizontal' | 'off';
}

const SEND_EVERY_MS = 250;

const lightSource = (c: Record<string, any>): string => c.source ?? (c.area ? 'area' : c.entities?.length ? 'entities' : 'entity');

const EDITOR: EditorSpec = {
  schema: (c) => [
    { name: 'source', selector: choose([['entity', 'One light'], ['area', 'Every light in an area'], ['entities', 'A group of lights']], 'list') },
    lightSource(c) === 'area'
      ? { name: 'area', required: true, selector: { area: {} } }
      : lightSource(c) === 'entities'
        ? { name: 'entities', required: true, selector: { entity: { domain: 'light', multiple: true } } }
        : { name: 'entity', required: true, selector: { entity: { domain: 'light' } } },
    { type: 'grid', name: '', schema: [{ name: 'name', selector: { text: {} } }, { name: 'icon', selector: { icon: {} }, context: { icon_entity: 'entity' } }] },
    { name: 'swipe', selector: choose([['vertical', 'Swipe up and down'], ['horizontal', 'Swipe left and right'], ['off', 'Off']]) },
    appearanceSection,
    actionsSection(),
    layoutSection,
  ],
  labels: { source: 'Control', area: 'Area', entities: 'Lights', entity: 'Light', swipe: 'Swipe to dim' },
  helpers: { tap_action: 'Default: opens the lights pop-up', area: 'Shows and controls every visible light in the area' },
};

/**
 * Light or area tile (design A): clear glass above the level, the light's own
 * colour below it, with the text flipping colour where they meet. Drag to dim,
 * tap the icon to toggle, tap the tile for the lights pop-up.
 */
export class HomeViewLightCard extends HomeViewCard<LightCardConfig> {
  /** Level shown while dragging, before HA has caught up. */
  @state() private dragPct?: number;
  private dragBase = 0;
  private lastSent = 0;
  private sendTimer?: number;

  static getConfigElement() {
    return editorFor(EDITOR);
  }

  static getStubConfig(_hass: unknown, entities: string[], fallback: string[]) {
    return { entity: [...entities, ...fallback].find((e) => e.startsWith('light.')) ?? '' };
  }

  protected validate(config: LightCardConfig): void {
    if (!config.entity && !config.area && !config.entities?.length) {
      throw new Error('Set an entity, an area or a list of entities');
    }
  }

  protected popupName(): string {
    return 'lights';
  }

  private get lights(): string[] {
    const c = this.config;
    const source = lightSource(c);
    if (source === 'area') return this.hass && c.area ? entitiesInArea(this.hass, c.area, 'light') : [];
    if (source === 'entities') return c.entities ?? [];
    return c.entity ? [c.entity] : [];
  }

  protected watched(): string[] {
    return this.lights;
  }

  private get states(): HassEntity[] {
    return this.lights.map((id) => this.hass?.states[id]).filter((s): s is HassEntity => !!s);
  }

  private get level(): number {
    if (this.dragPct !== undefined) return this.dragPct;
    const on = this.states.filter((s) => s.state === 'on');
    if (!on.length) return 0;
    return Math.round(on.reduce((sum, s) => sum + brightnessPct(s), 0) / on.length);
  }

  private send(pct: number): void {
    const targets = this.states.filter((s) => s.state !== 'unavailable').map((s) => s.entity_id);
    if (!targets.length) return;
    if (pct <= 0) void this.call('light', 'turn_off', { entity_id: targets });
    else {
      const dimmable = targets.filter((id) => supportsBrightness(this.hass!.states[id]));
      if (dimmable.length) void this.call('light', 'turn_on', { entity_id: dimmable, brightness_pct: pct });
      const plain = targets.filter((id) => !dimmable.includes(id));
      if (plain.length) void this.call('light', 'turn_on', { entity_id: plain });
    }
  }

  protected dragHandlers(): DragHandlers | undefined {
    const swipe = this.config.swipe ?? 'vertical';
    if (swipe === 'off' || !this.states.length) return undefined;
    return {
      axis: swipe === 'horizontal' ? 'x' : 'y',
      start: () => {
        this.dragBase = this.level;
        haptic('selection');
      },
      move: (f) => {
        const pct = Math.round(Math.min(100, Math.max(0, this.dragBase + f * 100)));
        if (pct === this.dragPct) return;
        this.dragPct = pct;
        const now = Date.now();
        window.clearTimeout(this.sendTimer);
        if (now - this.lastSent > SEND_EVERY_MS) {
          this.lastSent = now;
          this.send(pct);
        } else {
          this.sendTimer = window.setTimeout(() => this.send(pct), SEND_EVERY_MS);
        }
      },
      end: () => {
        window.clearTimeout(this.sendTimer);
        if (this.dragPct !== undefined) this.send(this.dragPct);
        // Hold the dragged level until HA reports back, so the fill doesn't jump.
        window.setTimeout(() => (this.dragPct = undefined), 1200);
        haptic('light');
      },
    };
  }

  private toggle(ev: Event): void {
    ev.stopPropagation();
    if (this.preview) return;
    const anyOn = this.states.some((s) => s.state === 'on');
    haptic('light');
    void this.call('light', anyOn ? 'turn_off' : 'turn_on', { entity_id: this.lights });
  }

  private label(level: number): string {
    const total = this.states.length;
    const on = this.states.filter((s) => s.state === 'on').length;
    if (!total) return this.hass?.localize('state.default.unavailable') || 'Unavailable';
    if (this.states.every((s) => s.state === 'unavailable')) return 'Unavailable';
    if (!on) return 'Off';
    if (total === 1) return `${level}%`;
    return `${on} on · ${level}%`;
  }

  private get heading(): string {
    const c = this.config;
    if (c.name) return c.name;
    if (lightSource(c) === 'area' && c.area && this.hass) return areaName(this.hass, c.area) ?? c.area;
    const st = this.states[0];
    return st?.attributes.friendly_name ?? c.entity ?? 'Lights';
  }

  private content(fill: string, ink: string, sub: string, icon: string, level: number, overlay: boolean) {
    const on = level > 0;
    const iconBg = overlay ? ink : on ? fill : 'var(--_glass-hi)';
    const iconInk = overlay ? fill : on ? ink : 'var(--_ink2)';
    const wide = this.size === 'w' || this.size === 'l';
    const dots = wide && this.lights.length > 1;
    return html`
      <div class="in">
        <div class="top">
          ${overlay
            ? html`<span class="round icon corner-tl" style="background:${iconBg};color:${iconInk}"><ha-icon .icon=${icon}></ha-icon></span>`
            : html`<button
                class="round icon corner-tl ${on ? '' : 'gl'}"
                style="background:${iconBg};color:${iconInk}"
                aria-label="Toggle ${this.heading}"
                @click=${this.toggle}
              >
                <ha-icon .icon=${icon}></ha-icon>
              </button>`}
          ${wide ? html`<div class="big">${on ? `${level}%` : 'Off'}</div>` : nothing}
        </div>
        <div class="bottom">
          <div class="text">
            <div class="name">${this.heading}</div>
            <div class="sub" style=${overlay ? `color:${sub}` : ''}>${this.label(level)}</div>
          </div>
          ${dots
            ? html`<div class="dots">
                ${this.states.map(
                  (s) => html`<span style="background:${s.state === 'on' ? hex(lightColor(s)) : 'var(--_track)'}"></span>`,
                )}
              </div>`
            : nothing}
        </div>
      </div>
    `;
  }

  render() {
    if (!this.hass) return nothing;
    const level = this.level;
    const firstOn = this.states.find((s) => s.state === 'on');
    const rgb = lightColor(firstOn);
    const fill = hex(rgb);
    const { ink, sub } = inkFor(rgb);
    const icon = this.config.icon ?? (lightSource(this.config) !== 'entity' || this.lights.length > 1 ? 'mdi:lightbulb-group' : 'mdi:lightbulb');
    const unavailable = !this.states.length || this.states.every((s) => s.state === 'unavailable');
    const horizontal = this.config.swipe === 'horizontal';
    const clip = horizontal ? `inset(0 ${100 - level}% 0 0)` : `inset(${100 - level}% 0 0 0)`;
    return html`
      <ha-card
        class="tile clickable ${unavailable ? 'off' : ''} ${horizontal ? 'h' : 'v'}"
        tabindex="0"
        role="button"
        aria-label="${this.heading}, ${this.label(level)}"
      >
        ${this.content(fill, ink, sub, icon, level, false)}
        ${level > 0
          ? html`<div class="ov fill" aria-hidden="true" style="background:${fill};color:${ink};clip-path:${clip}">
              ${this.content(fill, ink, sub, icon, level, true)}
            </div>`
          : nothing}
      </ha-card>
    `;
  }

  getGridOptions(): GridOptions {
    return { columns: 6, rows: 3, min_columns: 3, min_rows: 2 };
  }

  getCardSize(): number {
    return 3;
  }

  static styles = [
    ...HomeViewCard.styles,
    css`
      ha-card.v {
        touch-action: pan-x;
      }
      ha-card.h {
        touch-action: pan-y;
      }
      ha-card.off {
        opacity: 0.55;
      }
      .fill {
        transition: clip-path 0.18s ease-out;
      }
      .top,
      .bottom {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: 12px;
      }
      .bottom {
        align-items: flex-end;
      }
      .text {
        min-width: 0;
      }
      .icon {
        width: 44px;
        height: 44px;
      }
      .big {
        font-size: 46px;
        font-weight: 600;
        letter-spacing: -0.03em;
        line-height: 1;
      }
      .sub {
        font-weight: 600;
      }
      .dots {
        display: flex;
        gap: 6px;
        flex: none;
      }
      .dots span {
        width: 16px;
        height: 16px;
        border-radius: 50%;
        box-shadow: inset 0 0 0 2px rgba(0, 0, 0, 0.12);
      }
      @media (prefers-reduced-motion: reduce) {
        .fill {
          transition: none;
        }
      }
    `,
  ];
}

defineElement('homeview-light-card', HomeViewLightCard);
registerCard({
  type: 'homeview-light-card',
  name: 'HomeView Light',
  description: 'A light or a whole area. Swipe to dim, tap the icon to toggle, tap for colours, scenes and each light.',
  getEntitySuggestion: (_hass, entityId) =>
    entityId.startsWith('light.') ? { config: { type: 'custom:homeview-light-card', entity: entityId } } : null,
  docs: 'light',
});
