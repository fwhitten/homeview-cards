import { LitElement, css, html, nothing } from 'lit';
import { property, state } from 'lit/decorators.js';
import type { HomeAssistant } from '../core/types';
import type { ConditionConfig } from '../notifications/types';
import { defineElement } from '../core/register';
import { fireEvent } from '../core/events';
import type { Chip } from './chips-card';

type Field = Record<string, any>;

/**
 * One "highlight when" test as its own section. The state fields are Home
 * Assistant's state picker, listing the states the entity actually has.
 */
const test = (name: string, title: string, icon: string, entity?: string): Field => ({
  type: 'expandable',
  name,
  title,
  icon,
  schema: [
    { name: 'entity', selector: { entity: {} } },
    {
      type: 'grid',
      name: '',
      schema: [
        { name: 'state', selector: { state: { entity_id: entity } } },
        { name: 'state_not', selector: { state: { entity_id: entity } } },
      ],
    },
    {
      type: 'grid',
      name: '',
      schema: [
        { name: 'above', selector: { number: { mode: 'box', step: 'any' } } },
        { name: 'below', selector: { number: { mode: 'box', step: 'any' } } },
      ],
    },
  ],
});

/** The chip's fields. State pickers follow each test's entity, or the chip's. */
const chipSchema = (c: Chip): Field[] => [
  { name: 'entity', selector: { entity: {} } },
  { type: 'grid', name: '', schema: [{ name: 'name', selector: { text: {} } }, { name: 'icon', selector: { icon: {} } }] },
  {
    type: 'grid',
    name: '',
    schema: [
      { name: 'show_name', selector: { boolean: {} } },
      { name: 'show_state', selector: { boolean: {} } },
      { name: 'show_icon', selector: { boolean: {} } },
      { name: 'show_entity_picture', selector: { boolean: {} } },
    ],
  },
  {
    name: 'state_content',
    selector: {
      select: {
        multiple: true,
        custom_value: true,
        reorder: true,
        options: [
          { value: 'state', label: 'State' },
          { value: 'name', label: 'Name' },
          { value: 'last_changed', label: 'Last changed' },
          { value: 'last_updated', label: 'Last updated' },
        ],
      },
    },
  },
  { name: 'color', selector: { ui_color: { default_color: 'state', include_state: true, include_none: true } } },
  test('attention_when', 'Amber when…', 'mdi:alert-circle-outline', c.attention_when?.entity ?? c.entity),
  test('success_when', 'Green when…', 'mdi:check-circle-outline', c.success_when?.entity ?? c.entity),
  test('alert_when', 'Red and pulsing when…', 'mdi:alarm-light-outline', c.alert_when?.entity ?? c.entity),
  { name: 'badge', selector: { boolean: {} } },
  {
    type: 'expandable',
    name: '',
    title: 'Interactions',
    icon: 'mdi:gesture-tap',
    schema: [
      { name: 'tap_action', selector: { ui_action: {} } },
      { name: 'hold_action', selector: { ui_action: {} } },
      { name: 'double_tap_action', selector: { ui_action: {} } },
    ],
  },
];

/**
 * A progress chip: ha-progress-card's options. Pin states come from the pin
 * entity's own states; calendar options only show for a calendar.
 */
const progressSchema = (c: Chip): Field[] => {
  const calendar = String(c.entity ?? '').startsWith('calendar.');
  const numeric = !calendar && !String(c.entity ?? '').startsWith('timer.');
  return [
    { name: 'entity', selector: { entity: {} } },
    { type: 'grid', name: '', schema: [{ name: 'name', selector: { text: {} } }, { name: 'icon', selector: { icon: {} }, context: { icon_entity: 'entity' } }] },
    { name: 'progress_style', selector: { select: { mode: 'list', options: [{ value: 'ring', label: 'Ring around the icon' }, { value: 'fill', label: 'Circle that fills, with the %' }] } } },
    { type: 'grid', name: '', schema: [{ name: 'show_name', selector: { boolean: {} } }, { name: 'show_state', selector: { boolean: {} } }] },
    ...(numeric
      ? [
          { type: 'grid', name: '', schema: [{ name: 'min', selector: { number: { mode: 'box', step: 'any' } } }, { name: 'max', selector: { number: { mode: 'box', step: 'any' } } }] },
          { name: 'value_entity', selector: { entity: {} } },
        ]
      : []),
    { name: 'color', selector: { ui_color: {} } },
    {
      name: 'thresholds',
      selector: {
        object: {
          multiple: true,
          label_field: 'value',
          fields: {
            value: { label: 'From', required: true, selector: { number: { mode: 'box', step: 'any' } } },
            color: { label: 'Colour', required: true, selector: { ui_color: {} } },
          },
        },
      },
    },
    ...(numeric
      ? [
          {
            type: 'expandable',
            name: '',
            title: 'Pin while…',
            icon: 'mdi:pin-outline',
            schema: [
              { name: 'pin_entity', selector: { entity: {} } },
              { name: 'pin_states', selector: { state: { entity_id: c.pin_entity, multiple: true } } },
              { name: 'pin_value', selector: { select: { mode: 'dropdown', custom_value: true, options: [{ value: 'max', label: 'Full' }, { value: 'min', label: 'Empty' }] } } },
            ],
          },
        ]
      : []),
    ...(calendar
      ? [
          {
            name: 'hide_when',
            selector: {
              select: {
                mode: 'dropdown',
                options: [
                  { value: 'never', label: 'Always' },
                  { value: 'no_events_today', label: 'When an event is on or left today' },
                  { value: 'no_events_within', label: 'When an event is on or starts within…' },
                  { value: 'no_events', label: 'When any event is coming up' },
                ],
              },
            },
          },
          ...(c.hide_when === 'no_events_within' ? [{ name: 'within', selector: { duration: { enable_day: true } } }] : []),
          { type: 'grid', name: '', schema: [{ name: 'include_all_day', selector: { boolean: {} } }, { name: 'look_ahead_days', selector: { number: { min: 1, max: 31, mode: 'box' } } }] },
        ]
      : []),
    {
      type: 'expandable',
      name: '',
      title: 'Interactions',
      icon: 'mdi:gesture-tap',
      schema: [
        { name: 'tap_action', selector: { ui_action: {} } },
        { name: 'hold_action', selector: { ui_action: {} } },
        { name: 'double_tap_action', selector: { ui_action: {} } },
      ],
    },
  ];
};

const LABELS: Record<string, string> = {
  progress_style: 'Design',
  min: 'Minimum',
  max: 'Maximum',
  value_entity: 'Show this entity as the value (e.g. time remaining)',
  thresholds: 'Colour from a value upwards',
  pin_entity: 'Status entity',
  pin_states: 'In any of these states',
  pin_value: 'Hold the ring at',
  hide_when: 'Show the chip',
  within: 'Starts within',
  include_all_day: 'Include all-day events',
  look_ahead_days: 'Look ahead (days)',
  entity: 'Entity',
  state: 'State is',
  state_not: 'State is not',
  above: 'Above',
  below: 'Below',
  name: 'Name',
  icon: 'Icon',
  show_name: 'Show name',
  show_state: 'Show state',
  show_icon: 'Show icon',
  show_entity_picture: 'Show entity picture',
  state_content: 'State shows (pick, or type an attribute)',
  color: 'Icon colour',
  badge: 'Count badge (style B)',
  tap_action: 'Tap',
  hold_action: 'Hold',
  double_tap_action: 'Double tap',
};

/** Media queries Home Assistant's own screen condition offers. */
const SCREENS = [
  { value: '(min-width: 0px) and (max-width: 767px)', label: 'Mobile' },
  { value: '(min-width: 768px) and (max-width: 1023px)', label: 'Tablet' },
  { value: '(min-width: 1024px) and (max-width: 1279px)', label: 'Desktop' },
  { value: '(min-width: 1280px)', label: 'Wide' },
  { value: '(orientation: portrait)', label: 'Portrait' },
  { value: '(orientation: landscape)', label: 'Landscape' },
];

const CONDITION_SCHEMA: Record<string, (c: ConditionConfig) => Field[]> = {
  state: (c) => [
    { name: 'entity', selector: { entity: {} } },
    {
      type: 'grid',
      name: '',
      schema: [
        { name: 'state', selector: { state: { entity_id: c.entity } } },
        { name: 'state_not', selector: { state: { entity_id: c.entity } } },
      ],
    },
  ],
  numeric_state: () => [
    { name: 'entity', selector: { entity: {} } },
    { type: 'grid', name: '', schema: [{ name: 'above', selector: { number: { mode: 'box', step: 'any' } } }, { name: 'below', selector: { number: { mode: 'box', step: 'any' } } }] },
  ],
  screen: () => [{ name: 'media_query', selector: { select: { custom_value: true, options: SCREENS } } }],
};

const CONDITION_LABELS: Record<string, string> = {
  state: 'Entity state',
  numeric_state: 'Entity number',
  screen: 'Screen size',
  user: 'User',
  template: 'Template',
  and: 'All of',
  or: 'Any of',
  not: 'None of',
};

/** Drop cleared values, including tests left empty: an empty test would match every state. */
const tidy = (obj: Record<string, any>): Record<string, any> =>
  Object.fromEntries(
    Object.entries(obj)
      .map(([k, v]) => [k, v && typeof v === 'object' && !Array.isArray(v) && !k.endsWith('_action') ? tidy(v) : v] as const)
      .filter(([, v]) => v !== undefined && v !== '' && !(Array.isArray(v) && !v.length) && !(v && typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length)),
  );

const kind = (c: ConditionConfig): string =>
  c.condition ?? (c.above !== undefined || c.below !== undefined ? 'numeric_state' : c.media_query ? 'screen' : c.users ? 'user' : 'state');

/**
 * A visual editor for a list of chips: reorder, add from an entity, remove,
 * and open one to edit what it shows, its colours, actions and visibility
 * (Home Assistant's badge conditions). Used by the chips card and the view
 * header.
 */
export class HomeViewChipsEditor extends LitElement {
  @property({ attribute: false }) hass?: HomeAssistant;
  @property({ attribute: false }) chips: Chip[] = [];
  @state() private open?: number;

  private emit(chips: Chip[]): void {
    fireEvent(this, 'chips-changed', chips);
  }

  private set(i: number, chip: Chip): void {
    const next = [...this.chips];
    next[i] = tidy(chip) as Chip;
    this.emit(next);
  }

  private move(i: number, dir: -1 | 1): void {
    const j = i + dir;
    if (j < 0 || j >= this.chips.length) return;
    const next = [...this.chips];
    [next[i], next[j]] = [next[j], next[i]];
    if (this.open === i) this.open = j;
    else if (this.open === j) this.open = i;
    this.emit(next);
  }

  private removeChip(i: number): void {
    this.open = undefined;
    this.emit(this.chips.filter((_, k) => k !== i));
  }

  private add(entity: string, type?: 'progress'): void {
    if (!entity) return;
    this.open = this.chips.length;
    this.emit([...this.chips, type ? { type, entity } : { entity }]);
  }

  private chipTitle(c: Chip): string {
    const st = c.entity ? this.hass?.states[c.entity] : undefined;
    return (typeof c.name === 'string' && c.name) || st?.attributes.friendly_name || c.entity || 'Chip';
  }

  private conditions(i: number, chip: Chip) {
    const list = chip.visibility ?? [];
    const setList = (next: ConditionConfig[]) => this.set(i, { ...chip, visibility: next.length ? next : undefined });
    return html`<div class="conds">
      <div class="sub"><ha-icon icon="mdi:eye-outline"></ha-icon>Visibility</div>
      <div class="hint">${list.length ? 'Shown only while all of these are true.' : 'Always shown. Add a condition to show the chip only sometimes.'}</div>
      ${list.map((c, k) => {
        const type = kind(c);
        const schema = CONDITION_SCHEMA[type] as ((c: ConditionConfig) => Field[]) | undefined;
        return html`<div class="cond">
          <div class="cond-head">
            <span>${CONDITION_LABELS[type] ?? type}</span>
            <button class="icon-btn" aria-label="Remove condition" @click=${() => setList(list.filter((_, n) => n !== k))}><ha-icon icon="mdi:close"></ha-icon></button>
          </div>
          <ha-form
            .hass=${this.hass}
            .data=${c}
            .schema=${schema ? schema(c) : [{ name: 'yaml', selector: { object: {} } }]}
            .computeLabel=${(s: Field) => ({ entity: 'Entity', state: 'State is', state_not: 'State is not', above: 'Above', below: 'Below', media_query: 'Screen', yaml: 'Condition (YAML)' })[s.name as string] ?? s.name}
            @value-changed=${(e: CustomEvent) => {
              e.stopPropagation();
              const v = e.detail.value as ConditionConfig & { yaml?: ConditionConfig };
              const next = [...list];
              next[k] = schema ? { ...v, condition: type as ConditionConfig['condition'] } : (v.yaml ?? c);
              setList(next);
            }}
          ></ha-form>
        </div>`;
      })}
      <div class="add-cond">
        ${(['state', 'numeric_state', 'screen'] as const).map(
          (t) => html`<button class="pill" @click=${() => setList([...list, { condition: t, ...(t !== 'screen' && chip.entity ? { entity: chip.entity } : {}) }])}>
            <ha-icon icon="mdi:plus"></ha-icon>${CONDITION_LABELS[t]}
          </button>`,
        )}
      </div>
    </div>`;
  }

  private row(c: Chip, i: number) {
    const st = c.entity ? this.hass?.states[c.entity] : undefined;
    const open = this.open === i;
    return html`<div class="chip ${open ? 'open' : ''}">
      <div class="row">
        <div class="order">
          <button class="icon-btn" aria-label="Move up" ?disabled=${i === 0} @click=${() => this.move(i, -1)}><ha-icon icon="mdi:chevron-up"></ha-icon></button>
          <button class="icon-btn" aria-label="Move down" ?disabled=${i === this.chips.length - 1} @click=${() => this.move(i, 1)}><ha-icon icon="mdi:chevron-down"></ha-icon></button>
        </div>
        <button class="main" @click=${() => (this.open = open ? undefined : i)}>
          <span class="ico">${c.icon ? html`<ha-icon .icon=${c.icon}></ha-icon>` : st ? html`<ha-state-icon .hass=${this.hass} .stateObj=${st}></ha-state-icon>` : html`<ha-icon icon="mdi:label-outline"></ha-icon>`}</span>
          <span class="txt"><b>${this.chipTitle(c)}</b><small>${c.type === 'progress' ? 'Progress · ' : ''}${c.entity ?? 'No entity'}${c.visibility?.length ? ' · conditional' : ''}</small></span>
          <ha-icon class="chev" .icon=${open ? 'mdi:chevron-up' : 'mdi:pencil-outline'}></ha-icon>
        </button>
        <button class="icon-btn" aria-label="Remove chip" @click=${() => this.removeChip(i)}><ha-icon icon="mdi:delete-outline"></ha-icon></button>
      </div>
      ${open
        ? html`<div class="body">
            <ha-form
              .hass=${this.hass}
              .data=${c}
              .schema=${c.type === 'progress' ? progressSchema(c) : chipSchema(c)}
              .computeLabel=${(s: Field) => (s.name === 'color' && c.type === 'progress' ? 'Ring colour' : LABELS[s.name as string] ?? s.label ?? s.name)}
              @value-changed=${(e: CustomEvent) => {
                e.stopPropagation();
                this.set(i, e.detail.value as Chip);
              }}
            ></ha-form>
            ${this.conditions(i, c)}
          </div>`
        : nothing}
    </div>`;
  }

  render() {
    if (!this.hass) return nothing;
    return html`
      ${this.chips.map((c, i) => this.row(c, i))}
      <div class="add">
        <ha-form
          .hass=${this.hass}
          .data=${{}}
          .schema=${[{ name: 'entity', selector: { entity: {} } }]}
          .computeLabel=${() => 'Add a chip'}
          @value-changed=${(e: CustomEvent) => {
            e.stopPropagation();
            this.add(e.detail.value?.entity);
          }}
        ></ha-form>
        <ha-form
          .hass=${this.hass}
          .data=${{}}
          .schema=${[{ name: 'entity', selector: { entity: {} } }]}
          .computeLabel=${() => 'Add a progress chip (progress %, timer or calendar)'}
          @value-changed=${(e: CustomEvent) => {
            e.stopPropagation();
            this.add(e.detail.value?.entity, 'progress');
          }}
        ></ha-form>
      </div>
    `;
  }

  static styles = css`
    :host {
      display: block;
    }
    .chip {
      border: 1px solid var(--divider-color, rgba(127, 127, 127, 0.3));
      border-radius: 12px;
      margin-bottom: 8px;
      overflow: hidden;
    }
    .chip.open {
      border-color: var(--primary-color);
    }
    .row {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 4px 6px 4px 2px;
    }
    .order {
      display: flex;
      flex-direction: column;
    }
    .order .icon-btn {
      height: 22px;
    }
    .main {
      flex: 1;
      min-width: 0;
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 6px 4px;
      border: 0;
      background: none;
      font: inherit;
      color: inherit;
      text-align: left;
      cursor: pointer;
    }
    .ico {
      flex: none;
      width: 36px;
      height: 36px;
      border-radius: 50%;
      display: grid;
      place-items: center;
      background: var(--secondary-background-color, rgba(127, 127, 127, 0.15));
      --mdc-icon-size: 20px;
    }
    .txt {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
    }
    .txt b,
    .txt small {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .txt b {
      font-weight: 500;
    }
    .txt small {
      color: var(--secondary-text-color);
    }
    .chev {
      color: var(--secondary-text-color);
      --mdc-icon-size: 20px;
    }
    .icon-btn {
      display: grid;
      place-items: center;
      width: 36px;
      height: 36px;
      padding: 0;
      border: 0;
      border-radius: 50%;
      background: none;
      color: var(--secondary-text-color);
      cursor: pointer;
      --mdc-icon-size: 20px;
    }
    .icon-btn:disabled {
      opacity: 0.3;
      cursor: default;
    }
    .body {
      padding: 4px 12px 12px;
    }
    .conds {
      margin-top: 12px;
    }
    .sub {
      display: flex;
      align-items: center;
      gap: 8px;
      font-weight: 500;
      --mdc-icon-size: 20px;
    }
    .hint {
      font-size: 0.875em;
      color: var(--secondary-text-color);
      margin: 4px 0 8px;
    }
    .cond {
      border-radius: 10px;
      padding: 4px 10px 10px;
      margin-bottom: 8px;
      background: var(--secondary-background-color, rgba(127, 127, 127, 0.1));
    }
    .cond-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-weight: 500;
    }
    .add-cond {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    .pill {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      height: 32px;
      padding: 0 12px 0 8px;
      border: 1px solid var(--divider-color, rgba(127, 127, 127, 0.4));
      border-radius: 16px;
      background: none;
      color: var(--primary-color);
      font: inherit;
      font-weight: 500;
      cursor: pointer;
      --mdc-icon-size: 18px;
    }
    .add {
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin-top: 12px;
    }
  `;
}

defineElement('homeview-chips-editor', HomeViewChipsEditor);
