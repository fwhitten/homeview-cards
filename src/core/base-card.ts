import { LitElement, type PropertyValues } from 'lit';
import { property, state } from 'lit/decorators.js';
import type { ActionConfig, GridOptions, HassEntity, HomeAssistant, LovelaceCardConfig } from './types';
import { cardStyles } from './styles';
import { GestureController, type DragHandlers, type GestureHandlers } from './gestures';
import { runAction } from './actions';
import { resolveMode, store, type Appearance, type Mode } from './store';

export interface BaseCardConfig extends LovelaceCardConfig {
  entity?: string;
  name?: string;
  icon?: string;
  appearance?: Appearance;
  night_entity?: string;
  tap_action?: ActionConfig;
  hold_action?: ActionConfig;
  double_tap_action?: ActionConfig;
}

export type ActionKind = 'tap' | 'hold' | 'double_tap';

/** Tile footprint, from the rendered size: 1×1, 2×1 (wide), 2×2 (large), 1×2 (tall) or 2×½ (slim). */
export type TileSize = 's' | 'w' | 'l' | 't' | 'slim';

const sizeFor = (w: number, h: number): TileSize => {
  const wide = w > 300;
  const tall = h > 300;
  if (wide && h < 130) return 'slim';
  if (wide && tall) return 'l';
  if (wide) return 'w';
  if (tall) return 't';
  return 's';
};

/**
 * Shared plumbing for every HomeView card: config handling, mode resolution
 * (auto / light / dark / night), selective re-rendering on hass changes, and
 * tap / hold / double-tap / drag gestures on the tile.
 */
export abstract class HomeViewCard<C extends BaseCardConfig = BaseCardConfig> extends LitElement {
  static styles = cardStyles;

  @property({ attribute: false }) hass?: HomeAssistant;
  @property({ type: Boolean }) preview = false;
  @property({ reflect: true }) mode: Mode = 'dark';
  @property({ reflect: true }) size: TileSize = 's';
  @state() protected config!: C;
  private resizer?: ResizeObserver;
  /** Recent size changes, to stop layout and size chasing each other. */
  private flips: number[] = [];

  protected gestures = new GestureController(this, () => this.gestureHandlers());
  private unsubSettings?: () => void;

  setConfig(config: C): void {
    if (!config) throw new Error('Invalid configuration');
    this.validate(config);
    this.config = { ...this.defaults(), ...config };
    this.setAutoHeight();
  }

  /** Throw an Error to show HA's red config-error card. */
  protected validate(_config: C): void {}

  protected defaults(): Partial<C> {
    return {};
  }

  /** Entities whose changes should re-render this card. */
  protected watched(): Array<string | undefined> {
    return [this.config?.entity];
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.unsubSettings = store.subscribe('settings', () => this.requestUpdate());
    this.resizer = new ResizeObserver(([entry]) => this.resize(entry.contentRect.width, entry.contentRect.height));
    this.resizer.observe(this);
    this.setAutoHeight();
  }

  /**
   * Where nothing gives the card a height (the card editor's preview, a
   * masonry dashboard), a tile would collapse around its content. Give it the
   * height of its smallest grid size instead. The HomeView view and sections
   * grids size cards themselves; the view turns this off with
   * --hv-tile-min-height.
   */
  private setAutoHeight(): void {
    const opts = this.getGridOptions();
    const rows = typeof opts.min_rows === 'number' ? opts.min_rows : typeof opts.rows === 'number' ? opts.rows : 2;
    this.style.setProperty('--_auto-min', `${rows * 56 + (rows - 1) * 8}px`);
  }

  /**
   * Pick the tile layout from the rendered size. Where the card's height
   * comes from its own content, a new layout can change that height and so
   * the size again; after a few quick flips it holds still rather than loop
   * (which froze the tab in the card editor).
   */
  private resize(width: number, height: number): void {
    if (!width || !height) return;
    const size = sizeFor(width, height);
    if (size === this.size) return;
    const now = performance.now();
    this.flips = this.flips.filter((t) => now - t < 2000);
    if (this.flips.length >= 4) return;
    this.flips.push(now);
    this.size = size;
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.unsubSettings?.();
    this.resizer?.disconnect();
  }

  protected shouldUpdate(changed: PropertyValues): boolean {
    // Keep the page-wide store current even when this card skips a render,
    // so pop-ups and overlays in document.body see every change.
    if (this.hass) store.setHass(this.hass);
    if (!this.config) return false;
    if (changed.size !== 1 || !changed.has('hass')) return true;
    const old = changed.get('hass') as HomeAssistant | undefined;
    const hass = this.hass;
    if (!old || !hass) return true;
    if (old.themes !== hass.themes || old.locale !== hass.locale || old.entities !== hass.entities) return true;
    const night = this.config.night_entity ?? store.settings.night_entity;
    return [...this.watched(), night].some((id) => id && old.states[id] !== hass.states[id]);
  }

  protected willUpdate(changed: PropertyValues): void {
    super.willUpdate(changed);
    if (this.hass) {
      this.mode = resolveMode(this.hass, this.config?.appearance, this.config?.night_entity);
    }
  }

  protected updated(changed: PropertyValues): void {
    super.updated(changed);
    // Size once from layout too: ResizeObserver can be late (or paused in a hidden tab).
    const box = this.getBoundingClientRect();
    this.resize(box.width, box.height);
    this.gestures.attach(this.renderRoot.querySelector<HTMLElement>('ha-card.tile'));
  }

  protected stateObj(id = this.config?.entity): HassEntity | undefined {
    return id ? this.hass?.states[id] : undefined;
  }

  protected call(domain: string, service: string, data: Record<string, unknown>): Promise<unknown> {
    return this.hass!.callService(domain, service, data);
  }

  /** The pop-up a `homeview-popup` action opens by default. */
  protected popupName(): string | undefined {
    return undefined;
  }

  protected defaultAction(kind: ActionKind): ActionConfig | undefined {
    if (kind === 'tap') return this.popupName() ? { action: 'homeview-popup' } : { action: 'more-info' };
    if (kind === 'hold') return { action: 'more-info' };
    return undefined;
  }

  protected action(kind: ActionKind): ActionConfig | undefined {
    return (this.config?.[`${kind}_action`] as ActionConfig | undefined) ?? this.defaultAction(kind);
  }

  protected run(kind: ActionKind): void {
    if (!this.hass || this.preview) return;
    void runAction(
      { node: this, hass: this.hass, entity: this.config.entity, popup: this.popupName(), config: this.config },
      this.action(kind),
    );
  }

  protected dragHandlers(): DragHandlers | undefined {
    return undefined;
  }

  protected gestureHandlers(): GestureHandlers {
    const double = this.action('double_tap');
    return {
      tap: () => this.run('tap'),
      hold: () => this.run('hold'),
      doubleTap: double && double.action !== 'none' ? () => this.run('double_tap') : undefined,
      drag: this.preview ? undefined : this.dragHandlers(),
    };
  }

  /** The tile is interactive when it does anything on tap. */
  protected get clickable(): boolean {
    return this.action('tap')?.action !== 'none';
  }

  getCardSize(): number {
    return 4;
  }

  getGridOptions(): GridOptions {
    return { columns: 6, rows: 4, min_columns: 3, min_rows: 2 };
  }
}
