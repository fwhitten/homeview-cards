import { css, html, nothing } from 'lit';
import { state } from 'lit/decorators.js';
import { HomeViewCard, type BaseCardConfig } from '../core/base-card';
import type { ActionConfig, GridOptions } from '../core/types';
import { passes, type StateTest } from '../core/condition';
import { greeting, longDate } from '../core/format';
import { runAction } from '../core/actions';
import { defineElement, registerCard } from '../core/register';

export interface Chip {
  entity?: string;
  /** Text on the chip. `{state}` is replaced with the entity's formatted state. */
  name?: string;
  icon?: string;
  /** The icon circle's colour while the chip is calm. */
  color?: string;
  /** Show the entity's numeric state as a badge in the compact style. */
  badge?: boolean;
  /** Only show the chip while this passes. */
  show_when?: StateTest;
  attention_when?: StateTest;
  success_when?: StateTest;
  alert_when?: StateTest;
  tap_action?: ActionConfig;
}

export interface ChipsCardConfig extends BaseCardConfig {
  /** A: full chips. B: icons only with badges. C: big glance chips. */
  style?: 'full' | 'compact' | 'glance';
  /** Greeting and date on the left, for use as a dashboard header. */
  show_greeting?: boolean;
  align?: 'start' | 'end' | 'center';
  chips: Chip[];
}

type Level = 'calm' | 'attention' | 'success' | 'alert';

const LEVEL: Record<Exclude<Level, 'calm'>, { bg: string; ink: string }> = {
  attention: { bg: 'rgba(255,179,64,.92)', ink: '#2a1a00' },
  success: { bg: 'rgba(76,208,125,.92)', ink: '#06240f' },
  alert: { bg: '#E5484D', ink: '#fff' },
};

/**
 * Status chips (styles A, B and C): glass while all is well, amber for
 * attention, green when something's done, red and pulsing for alarms.
 * With show_greeting it doubles as the dashboard header.
 */
export class HomeViewChipsCard extends HomeViewCard<ChipsCardConfig> {
  @state() private now = new Date();
  @state() private expanded?: number;
  private timer?: number;

  static getConfigForm() {
    const test = {
      object: {
        fields: {
          entity: { label: "Entity (defaults to the chip's)", selector: { entity: {} } },
          state: { label: 'State is', selector: { text: {} } },
          state_not: { label: 'State is not', selector: { text: {} } },
          above: { label: 'Above', selector: { number: { mode: 'box' } } },
          below: { label: 'Below', selector: { number: { mode: 'box' } } },
        },
      },
    };
    return {
      schema: [
        { name: 'style', default: 'full', selector: { select: { options: [{ value: 'full', label: 'A: chips' }, { value: 'compact', label: 'B: icons with badges' }, { value: 'glance', label: 'C: big glance chips' }] } } },
        { name: 'show_greeting', default: false, selector: { boolean: {} } },
        { name: 'align', default: 'end', selector: { select: { options: ['start', 'center', 'end'] } } },
        {
          name: 'chips',
          selector: {
            object: {
              multiple: true,
              label_field: 'name',
              fields: {
                entity: { label: 'Entity', selector: { entity: {} } },
                name: { label: 'Text ({state} for the state)', selector: { text: {} } },
                icon: { label: 'Icon', selector: { icon: {} } },
                color: { label: 'Icon colour', selector: { text: {} } },
                badge: { label: 'Badge with the number (style B)', selector: { boolean: {} } },
                show_when: { label: 'Only show when', selector: test },
                attention_when: { label: 'Amber when', selector: test },
                success_when: { label: 'Green when', selector: test },
                alert_when: { label: 'Red when', selector: test },
                tap_action: { label: 'Tap action', selector: { ui_action: {} } },
              },
            },
          },
        },
      ],
    };
  }

  static getStubConfig() {
    return { style: 'full', chips: [] };
  }

  protected validate(config: ChipsCardConfig): void {
    if (!Array.isArray(config.chips)) throw new Error('`chips` must be a list');
  }

  protected defaults(): Partial<ChipsCardConfig> {
    return { style: 'full', align: 'end' };
  }

  protected watched() {
    return this.config.chips.flatMap((c) => [c.entity, c.show_when?.entity, c.attention_when?.entity, c.success_when?.entity, c.alert_when?.entity]);
  }

  protected defaultAction() {
    return { action: 'none' as const };
  }

  connectedCallback(): void {
    super.connectedCallback();
    if (this.config?.show_greeting) this.timer = window.setInterval(() => (this.now = new Date()), 60_000);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.clearInterval(this.timer);
  }

  private level(c: Chip): Level {
    const hass = this.hass!;
    if (passes(hass, c.alert_when, c.entity)) return 'alert';
    if (passes(hass, c.attention_when, c.entity)) return 'attention';
    if (passes(hass, c.success_when, c.entity)) return 'success';
    return 'calm';
  }

  private text(c: Chip): string {
    const st = c.entity ? this.hass!.states[c.entity] : undefined;
    const formatted = st ? this.hass!.formatEntityState(st) : '';
    if (c.name) return c.name.replace('{state}', formatted);
    return st ? `${st.attributes.friendly_name ?? c.entity} · ${formatted}` : '';
  }

  private tap(c: Chip, i: number) {
    return (ev: Event) => {
      ev.stopPropagation();
      if (this.config.style === 'compact' && this.expanded !== i) {
        this.expanded = i;
        window.setTimeout(() => this.expanded === i && (this.expanded = undefined), 4000);
        return;
      }
      if (!this.hass) return;
      void runAction({ node: this, hass: this.hass, entity: c.entity }, c.tap_action ?? (c.entity ? { action: 'more-info' } : { action: 'none' }));
    };
  }

  private icon(c: Chip) {
    const st = c.entity ? this.hass!.states[c.entity] : undefined;
    return c.icon ? html`<ha-icon .icon=${c.icon}></ha-icon>` : st ? html`<ha-state-icon .hass=${this.hass} .stateObj=${st}></ha-state-icon>` : html`<ha-icon icon="mdi:information-outline"></ha-icon>`;
  }

  private chip(c: Chip, i: number) {
    const level = this.level(c);
    const style = this.config.style ?? 'full';
    const filled = level !== 'calm' ? LEVEL[level] : undefined;
    const text = this.text(c);
    const [main, ...rest] = text.split(' · ');
    if (style === 'compact' && this.expanded !== i) {
      const st = c.entity ? this.hass!.states[c.entity] : undefined;
      const n = c.badge && st ? Number(st.state) : NaN;
      return html`<button class="dotc ${filled ? '' : 'gl'} ${level === 'alert' ? 'pulse' : ''}" aria-label=${text} style=${filled ? `background:${filled.bg};color:${filled.ink}` : `color:${c.color ?? 'var(--_ink)'}`} @click=${this.tap(c, i)}>
        ${this.icon(c)}${Number.isFinite(n) && n > 0 ? html`<em style="background:${filled ? filled.ink : c.color ?? 'var(--hv-c-progress)'};color:${filled ? filled.bg : '#fff'}">${n}</em>` : nothing}
      </button>`;
    }
    const iconBg = filled ? filled.ink : c.color ?? 'rgba(255,255,255,.2)';
    const iconInk = filled ? filled.bg.replace('.92', '1') : c.color ? '#fff' : 'var(--_ink)';
    return html`<button class="chip ${style === 'glance' ? 'big' : ''} ${filled ? '' : 'gl'} ${level === 'alert' ? 'pulse' : ''}" style=${filled ? `background:${filled.bg};color:${filled.ink}` : ''} @click=${this.tap(c, i)}>
      <i style="background:${iconBg};color:${iconInk}">${this.icon(c)}</i>${main}${rest.length ? html`<span>${rest.join(' · ')}</span>` : nothing}
    </button>`;
  }

  render() {
    if (!this.hass) return nothing;
    const chips = this.config.chips
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => !c.show_when || passes(this.hass!, c.show_when, c.entity));
    const row = html`<div class="row ${this.config.align}">${chips.map(({ c, i }) => this.chip(c, i))}</div>`;
    if (!this.config.show_greeting) return row;
    return html`<div class="header">
      <div class="greet"><h1>${greeting(this.now)}</h1><span>${longDate(this.hass, this.now)}</span></div>
      ${row}
    </div>`;
  }

  getGridOptions(): GridOptions {
    return { columns: 'full', rows: 1, min_rows: 1 };
  }

  getCardSize(): number {
    return 1;
  }

  static styles = [
    ...HomeViewCard.styles,
    css`
      :host {
        height: auto;
      }
      .header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        min-height: 64px;
        flex-wrap: wrap;
      }
      .greet {
        display: flex;
        align-items: baseline;
        gap: 18px;
        min-width: 0;
      }
      h1 {
        margin: 0;
        font-size: 36px;
        font-weight: 700;
        letter-spacing: -0.02em;
      }
      .greet span {
        font-size: 21px;
        font-weight: 500;
        color: var(--_ink2);
      }
      .row {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        align-items: center;
      }
      .row.end {
        justify-content: flex-end;
      }
      .row.center {
        justify-content: center;
      }
      .chip,
      .dotc {
        position: relative;
        display: inline-flex;
        align-items: center;
        border: 0;
        font: inherit;
        color: var(--_ink);
        cursor: pointer;
        white-space: nowrap;
      }
      .chip {
        gap: 10px;
        height: 48px;
        padding: 0 18px 0 7px;
        border-radius: 999px;
        font-size: 17px;
        font-weight: 600;
      }
      .chip i {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 34px;
        height: 34px;
        border-radius: 999px;
        font-style: normal;
        --mdc-icon-size: 20px;
      }
      .chip span {
        font-weight: 500;
        opacity: 0.72;
      }
      .chip.big {
        height: 60px;
        gap: 12px;
        padding: 0 24px 0 9px;
        font-size: 21px;
      }
      .chip.big i {
        width: 42px;
        height: 42px;
        --mdc-icon-size: 24px;
      }
      .dotc {
        justify-content: center;
        width: 56px;
        height: 56px;
        border-radius: 999px;
        --mdc-icon-size: 24px;
      }
      .dotc em {
        position: absolute;
        right: -4px;
        top: -4px;
        min-width: 22px;
        height: 22px;
        padding: 0 6px;
        box-sizing: border-box;
        border-radius: 999px;
        font-style: normal;
        font-size: 13px;
        font-weight: 700;
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 6;
      }
      .pulse {
        animation: pulse 1.4s ease-in-out infinite;
      }
      @keyframes pulse {
        50% {
          opacity: 0.55;
        }
      }
      @media (prefers-reduced-motion: reduce) {
        .pulse {
          animation: none;
        }
      }
    `,
  ];
}

defineElement('homeview-chips-card', HomeViewChipsCard);
registerCard({
  type: 'homeview-chips-card',
  name: 'HomeView Status chips',
  description: 'Status chips that turn amber, green or red when something needs you. Can show a greeting as a header.',
  docs: 'chips',
});
