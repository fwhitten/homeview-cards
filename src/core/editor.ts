import { LitElement, css, html, nothing } from 'lit';
import { property, state } from 'lit/decorators.js';
import type { HomeAssistant, LovelaceCardConfig } from './types';
import { defineElement } from './register';
import { fireEvent } from './events';

/** A ha-form schema entry. Kept loose: HA owns the full type. */
export type Field = Record<string, any>;

export interface EditorSpec {
  /** Fields for the current config, so variants only show what applies to them. */
  schema(config: LovelaceCardConfig, hass?: HomeAssistant): Field[];
  labels?: Record<string, string>;
  helpers?: Record<string, string>;
}

const COMMON_LABELS: Record<string, string> = {
  entity: 'Entity',
  name: 'Name',
  icon: 'Icon',
  appearance: 'Appearance',
  night_entity: 'Night mode entity',
  tap_action: 'Tap',
  hold_action: 'Hold',
  double_tap_action: 'Double tap',
  column: 'Column',
  row: 'Row',
  column_span: 'Width (columns)',
  row_span: 'Height (rows)',
};

const COMMON_HELPERS: Record<string, string> = {
  night_entity: 'Dims and warms the card while this is on (input_boolean, binary_sensor) or after sunset (sun.sun)',
  column: 'Only used by the HomeView view. Leave empty to place the card automatically',
  hold_action: 'Default: more-info',
};

/** The interaction section every card shares. */
export const actionsSection = (): Field => ({
  type: 'expandable',
  name: '',
  title: 'Interactions',
  icon: 'mdi:gesture-tap',
  schema: [
    { name: 'tap_action', selector: { ui_action: {} } },
    { name: 'hold_action', selector: { ui_action: {} } },
    { name: 'double_tap_action', selector: { ui_action: {} } },
  ],
});

/** Appearance and night mode, collapsed by default. */
export const appearanceSection: Field = {
  type: 'expandable',
  name: '',
  title: 'Appearance',
  icon: 'mdi:palette-outline',
  schema: [
    {
      name: 'appearance',
      selector: {
        select: {
          mode: 'dropdown',
          options: [
            { value: 'auto', label: 'Follow Home Assistant (light or dark)' },
            { value: 'light', label: 'Always light' },
            { value: 'dark', label: 'Always dark' },
            { value: 'night', label: 'Always night' },
          ],
        },
      },
    },
    { name: 'night_entity', selector: { entity: { domain: ['input_boolean', 'binary_sensor', 'sun'] } } },
  ],
};

/**
 * Placement on the HomeView view. Values land in `view_layout`, which Home
 * Assistant keeps with the card and other views ignore. Sections views have
 * their own Layout tab for size.
 */
export const layoutSection: Field = {
  type: 'expandable',
  name: 'view_layout',
  title: 'Position on the HomeView view',
  icon: 'mdi:view-grid-outline',
  schema: [
    {
      type: 'grid',
      name: '',
      schema: [
        { name: 'column', selector: { number: { min: 1, max: 12, mode: 'box' } } },
        { name: 'row', selector: { number: { min: 1, max: 12, mode: 'box' } } },
        { name: 'column_span', selector: { number: { min: 1, max: 12, mode: 'box' } } },
        { name: 'row_span', selector: { number: { min: 1, max: 12, mode: 'box' } } },
      ],
    },
  ],
};

/** Shorthand for a select with value/label pairs. */
export const choose = (options: Array<[string, string]>, mode: 'list' | 'dropdown' = 'dropdown'): Field => ({
  select: { mode, options: options.map(([value, label]) => ({ value, label })) },
});

/** Drop keys the form cleared, so YAML stays tidy. */
const tidy = (obj: Record<string, any>): Record<string, any> => {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === '' || (Array.isArray(v) && !v.length)) continue;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const inner = tidy(v);
      if (Object.keys(inner).length) out[k] = inner;
      continue;
    }
    out[k] = v;
  }
  return out;
};

/**
 * One editor for every HomeView card: Home Assistant's own ha-form, with the
 * schema rebuilt from the config on each change so a card's variants only
 * show the options that apply to them.
 */
export class HomeViewCardEditor extends LitElement {
  @property({ attribute: false }) hass?: HomeAssistant;
  @property({ attribute: false }) spec?: EditorSpec;
  @state() private config?: LovelaceCardConfig;

  setConfig(config: LovelaceCardConfig): void {
    this.config = config;
  }

  private label = (s: Field): string =>
    this.spec?.labels?.[s.name] ?? COMMON_LABELS[s.name] ?? s.label ?? s.name.replace(/_/g, ' ').replace(/^./, (c: string) => c.toUpperCase());

  private helper = (s: Field): string | undefined => this.spec?.helpers?.[s.name] ?? COMMON_HELPERS[s.name];

  private changed(ev: CustomEvent<{ value: LovelaceCardConfig }>): void {
    ev.stopPropagation();
    const config = { ...tidy(ev.detail.value), type: this.config!.type } as LovelaceCardConfig;
    this.config = config;
    fireEvent(this, 'config-changed', { config });
  }

  render() {
    if (!this.hass || !this.config || !this.spec) return nothing;
    return html`<ha-form
      .hass=${this.hass}
      .data=${this.config}
      .schema=${this.spec.schema(this.config, this.hass)}
      .computeLabel=${this.label}
      .computeHelper=${this.helper}
      @value-changed=${this.changed}
    ></ha-form>`;
  }

  static styles = css`
    :host {
      display: block;
    }
  `;
}

defineElement('homeview-card-editor', HomeViewCardEditor);

/** What a card's static getConfigElement returns. */
export const editorFor = (spec: EditorSpec): HTMLElement => {
  const el = document.createElement('homeview-card-editor') as HomeViewCardEditor;
  el.spec = spec;
  return el;
};
