import { css, html, nothing } from 'lit';
import { state } from 'lit/decorators.js';
import { HomeViewCard, type BaseCardConfig } from '../core/base-card';
import type { GridOptions, HomeAssistant } from '../core/types';
import { inkFor, parseHex } from '../core/color';
import { defineElement, registerCard } from '../core/register';
import { haptic } from '../core/events';
import { actionsSection, appearanceSection, choose, editorFor, layoutSection, type EditorSpec } from '../core/editor';

export interface SceneItem {
  entity: string;
  name?: string;
  icon?: string;
  color?: string;
  /** Only suggest between these times (HH:MM). Wraps past midnight when after > before. */
  after?: string;
  before?: string;
}

export interface SceneCardConfig extends BaseCardConfig {
  /** A: one scene as a tile. C: up to four scenes suggested for now. */
  style?: 'tile' | 'suggested';
  entity?: string;
  color?: string;
  /** Text under the name, such as what the scene does. */
  note?: string;
  scenes?: SceneItem[];
}

const PALETTE = ['#7D6BFF', '#FF8A3D', '#4C8DFF', '#BF5AF2'];

/** Scenes, scripts, automations and buttons: whatever "run it" means for the domain. */
export const runScene = (hass: HomeAssistant, entity: string): void => {
  const domain = entity.split('.')[0];
  if (domain === 'scene' || domain === 'script') void hass.callService(domain, 'turn_on', { entity_id: entity });
  else if (domain === 'automation') void hass.callService('automation', 'trigger', { entity_id: entity });
  else if (domain === 'button' || domain === 'input_button') void hass.callService(domain, 'press', { entity_id: entity });
  else void hass.callService('homeassistant', 'turn_on', { entity_id: entity });
};

const minutes = (hhmm?: string): number | undefined => {
  const m = hhmm ? /^(\d{1,2}):(\d{2})/.exec(hhmm) : null;
  return m ? Number(m[1]) * 60 + Number(m[2]) : undefined;
};

const inWindow = (item: SceneItem, now: Date): boolean => {
  const a = minutes(item.after);
  const b = minutes(item.before);
  if (a === undefined && b === undefined) return true;
  const t = now.getHours() * 60 + now.getMinutes();
  if (a !== undefined && b !== undefined) return a <= b ? t >= a && t < b : t >= a || t < b;
  return a !== undefined ? t >= a : t < b!;
};

const EDITOR: EditorSpec = {
  schema: (c) => [
    { name: 'style', selector: choose([['tile', 'A: one scene as a tile'], ['suggested', 'C: up to four, suggested for now']], 'list') },
    ...((c.style ?? 'tile') === 'tile'
      ? [
          { name: 'entity', required: true, selector: { entity: { domain: ['scene', 'script', 'automation', 'button', 'input_button'] } } },
          { type: 'grid', name: '', schema: [{ name: 'name', selector: { text: {} } }, { name: 'icon', selector: { icon: {} }, context: { icon_entity: 'entity' } }, { name: 'color', selector: { text: {} } }, { name: 'note', selector: { text: {} } }] },
        ]
      : [
          { name: 'name', selector: { text: {} } },
          {
            name: 'scenes',
            selector: {
              object: {
                multiple: true,
                label_field: 'entity',
                fields: {
                  entity: { label: 'Scene, script or automation', required: true, selector: { entity: { domain: ['scene', 'script', 'automation', 'button', 'input_button'] } } },
                  name: { label: 'Name', selector: { text: {} } },
                  icon: { label: 'Icon', selector: { icon: {} } },
                  color: { label: 'Colour', selector: { text: {} } },
                  after: { label: 'Suggest from', selector: { time: {} } },
                  before: { label: 'Suggest until', selector: { time: {} } },
                },
              },
            },
          },
        ]),
    appearanceSection,
    actionsSection(),
    layoutSection,
  ],
  labels: { entity: 'Scene', note: 'What it does', scenes: 'Scenes' },
  helpers: { scenes: 'Up to four that fit the time now are shown', tap_action: 'Default: runs the scene' },
};

/** Scenes (designs A and C): one-tap tiles, or up to four suggested for the time of day. */
export class HomeViewSceneCard extends HomeViewCard<SceneCardConfig> {
  @state() private justRan?: string;
  private clearTimer?: number;

  static getConfigElement() {
    return editorFor(EDITOR);
  }

  static getStubConfig(_hass: unknown, entities: string[], fallback: string[]) {
    return { style: 'tile', entity: [...entities, ...fallback].find((e) => e.startsWith('scene.')) ?? '' };
  }

  protected validate(config: SceneCardConfig): void {
    if ((config.style ?? 'tile') === 'tile' && !config.entity) throw new Error('Set a scene, script or automation');
    if (config.style === 'suggested' && !config.scenes?.length) throw new Error('Add up to four scenes');
  }

  protected defaults(): Partial<SceneCardConfig> {
    return { style: 'tile' };
  }

  protected watched() {
    return [this.config.entity, ...(this.config.scenes ?? []).map((s) => s.entity)];
  }

  protected defaultAction(kind: 'tap' | 'hold' | 'double_tap') {
    if (kind === 'tap') return this.config?.style === 'suggested' ? ({ action: 'none' } as const) : undefined;
    return super.defaultAction(kind);
  }

  /** Tapping a scene tile runs it, unless the user set their own tap action. */
  protected run(kind: 'tap' | 'hold' | 'double_tap'): void {
    if (kind === 'tap' && !this.config.tap_action && this.config.style !== 'suggested' && this.config.entity) {
      this.fire(this.config.entity);
      return;
    }
    super.run(kind);
  }

  private fire(entity: string): void {
    if (!this.hass || this.preview) return;
    haptic('success');
    runScene(this.hass, entity);
    this.justRan = entity;
    window.clearTimeout(this.clearTimer);
    this.clearTimer = window.setTimeout(() => (this.justRan = undefined), 3000);
  }

  private name(item: SceneItem): string {
    return item.name ?? this.hass?.states[item.entity]?.attributes.friendly_name ?? item.entity;
  }

  private icon(item: SceneItem, fallback = 'mdi:palette') {
    const st = this.hass?.states[item.entity];
    return item.icon
      ? html`<ha-icon .icon=${item.icon}></ha-icon>`
      : st
        ? html`<ha-state-icon .hass=${this.hass} .stateObj=${st}></ha-state-icon>`
        : html`<ha-icon .icon=${fallback}></ha-icon>`;
  }

  render() {
    if (!this.hass) return nothing;
    if (this.config.style === 'suggested') {
      const now = new Date();
      const items = (this.config.scenes ?? [])
        .map((s, i) => ({ ...s, color: s.color ?? PALETTE[i % PALETTE.length] }))
        .filter((s) => inWindow(s, now))
        .slice(0, 4);
      const four = items.length > 2;
      return html`<ha-card class="tile">
        <div class="in sug">
          <div class="lhead"><span class="name">${this.config.name ?? 'Suggested now'}</span>${this.justRan ? html`<span class="sub small">${this.name({ entity: this.justRan })} ran</span>` : nothing}</div>
          ${items.length
            ? html`<div class="grid ${four ? 'four' : ''}" style="grid-template-columns:repeat(${four ? 2 : items.length},minmax(0,1fr))">
                ${items.map((s) => {
                  const on = this.justRan === s.entity;
                  const ink = inkFor(parseHex(s.color!) ?? [125, 107, 255]).ink;
                  return html`<button class="pill ${on ? '' : 'gl'}" style=${on ? `background:${s.color};color:${ink}` : ''} @click=${() => this.fire(s.entity)}>
                    <i style="background:${on ? ink : s.color};color:${on ? s.color : ink}">${this.icon(s)}</i><span>${this.name(s)}</span>
                  </button>`;
                })}
              </div>`
            : html`<div class="sub">Nothing suggested right now</div>`}
        </div>
      </ha-card>`;
    }
    const entity = this.config.entity!;
    const color = this.config.color ?? PALETTE[0];
    const ink = inkFor(parseHex(color) ?? [125, 107, 255]).ink;
    const on = this.justRan === entity;
    const name = this.name({ entity, name: this.config.name });
    return html`<ha-card class="tile clickable" style=${on ? `background:${color};color:${ink}` : ''} tabindex="0" role="button" aria-label="Run ${name}">
      <div class="in">
        <span class="round badge" style="background:${on ? ink : color};color:${on ? color : ink}">${this.icon({ entity, icon: this.config.icon })}</span>
        <div><div class="name">${name}</div><div class="note">${on ? 'Set just now' : this.config.note ?? ''}</div></div>
      </div>
    </ha-card>`;
  }

  getGridOptions(): GridOptions {
    return this.config?.style === 'suggested' ? { columns: 12, rows: 3, min_columns: 6, min_rows: 2 } : { columns: 6, rows: 3, min_columns: 3, min_rows: 2 };
  }

  getCardSize(): number {
    return 3;
  }

  static styles = [
    ...HomeViewCard.styles,
    css`
      ha-card.tile {
        transition: background 0.25s ease, color 0.25s ease;
      }
      .badge {
        width: 52px;
        height: 52px;
        cursor: default;
      }
      .note {
        font-size: 16px;
        font-weight: 600;
        opacity: 0.75;
        min-height: 20px;
      }
      .sug {
        justify-content: flex-start;
        gap: 12px;
      }
      .lhead {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
      }
      .small {
        font-size: 16px;
      }
      .grid {
        flex: 1;
        display: grid;
        gap: 10px;
      }
      .grid.four {
        grid-template-rows: repeat(2, minmax(0, 1fr));
      }
      .pill {
        display: flex;
        align-items: center;
        gap: 10px;
        min-height: 52px;
        padding: 0 16px 0 8px;
        border: 0;
        border-radius: 20px;
        font: inherit;
        font-size: 17px;
        font-weight: 600;
        color: var(--_ink);
        cursor: pointer;
        text-align: left;
        overflow: hidden;
      }
      .pill i {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 40px;
        height: 40px;
        border-radius: 999px;
        flex: none;
        font-style: normal;
        --mdc-icon-size: 21px;
      }
      .pill span {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
    `,
  ];
}

defineElement('homeview-scene-card', HomeViewSceneCard);
registerCard({
  type: 'homeview-scene-card',
  name: 'HomeView Scene',
  description: 'One-tap scenes, scripts and automations, or up to four suggested for the time of day.',
  getEntitySuggestion: (_hass, entityId) =>
    entityId.startsWith('scene.') ? { config: { type: 'custom:homeview-scene-card', entity: entityId } } : null,
  docs: 'scenes',
});
