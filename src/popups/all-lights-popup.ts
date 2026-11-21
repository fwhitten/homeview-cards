import { css, html, nothing } from 'lit';
import { state } from 'lit/decorators.js';
import { PopupContent } from './popup-base';
import { areaOf, entitiesInArea } from '../core/areas';
import { brightnessPct, hex, lightColor, supportsBrightness } from '../core/color';
import { haptic } from '../core/events';
import { defineElement } from '../core/register';
import type { HassEntity } from '../core/types';
import '../core/slider';

interface Group {
  id: string;
  name: string;
  lights: string[];
  scenes: string[];
}

/**
 * Every light, grouped by area (from a chip with `popup: all-lights`). Each
 * area has a dimmer that moves all of its lights together, keeping their
 * brightness relative to each other, its scenes, and a dimmer per light.
 * Every dimmer has a power button inside it.
 */
export class HomeViewAllLightsPopup extends PopupContent {
  /** Levels set here but not yet reported back, by light. */
  @state() private pending: Record<string, number> = {};
  /** While an area dimmer is dragged: each on light's level when the drag began, and the area level then. */
  private drag?: { area: string; base: Record<string, number>; level: number };
  private sendTimer?: number;

  popupTitle(): string {
    return this.cfg.name && !String(this.cfg.name).includes('{state}') ? this.cfg.name : 'Lights';
  }

  popupSubtitle(): string {
    if (!this.hass) return '';
    const groups = this.groups;
    const on = groups.flatMap((g) => g.lights).filter((id) => this.isOn(id));
    const rooms = groups.filter((g) => g.lights.some((id) => this.isOn(id))).length;
    return on.length ? `${on.length} on in ${rooms} ${rooms === 1 ? 'room' : 'rooms'}` : 'All off';
  }

  /**
   * Whether a light belongs in the list: not excluded by name, and not a
   * light group (a group helper lists its members in `entity_id`), unless
   * the chip asks for groups.
   */
  private wanted = (id: string): boolean => {
    const hass = this.hass!;
    if (((this.cfg.exclude_entities as string[] | undefined) ?? []).includes(id)) return false;
    if (this.cfg.include_groups) return true;
    const st = hass.states[id];
    return !(Array.isArray(st?.attributes.entity_id) || hass.entities?.[id]?.platform === 'group');
  };

  private get groups(): Group[] {
    const hass = this.hass!;
    const only = this.cfg.areas as string[] | undefined;
    const areas = Object.values(hass.areas ?? {})
      .filter((a) => !only?.length || only.includes(a.area_id))
      .sort((a, b) => (only?.length ? only.indexOf(a.area_id) - only.indexOf(b.area_id) : String(a.name).localeCompare(String(b.name))));
    const groups: Group[] = areas
      .map((a) => ({ id: a.area_id, name: a.name, lights: entitiesInArea(hass, a.area_id, 'light').filter(this.wanted), scenes: entitiesInArea(hass, a.area_id, 'scene') }))
      .filter((g) => g.lights.length);
    if (!only?.length && this.cfg.include_unassigned) {
      // Lights with no area, only when asked for.
      const loose = Object.values(hass.entities ?? {})
        .filter((e) => e.entity_id.startsWith('light.') && !e.hidden && !e.entity_category && hass.states[e.entity_id] && !areaOf(hass, e.entity_id))
        .map((e) => e.entity_id)
        .filter(this.wanted);
      if (loose.length) groups.push({ id: '', name: 'Other', lights: loose, scenes: [] });
    }
    return groups;
  }

  popupActions() {
    if (!this.hass) return nothing;
    const anyOn = this.groups.some((g) => g.lights.some((id) => this.isOn(id)));
    return html`<button class="hbtn" ?disabled=${!anyOn} @click=${() => this.allOff()}><ha-icon icon="mdi:lightbulb-group-off-outline"></ha-icon>All off</button>`;
  }

  protected willUpdate(): void {
    // Forget a pending level once its light reports it (or something near it).
    let changed = false;
    const next = { ...this.pending };
    for (const [id, v] of Object.entries(this.pending)) {
      const st = this.st(id);
      if (!st) continue;
      const actual = brightnessPct(st);
      if ((v === 0 && st.state === 'off') || (v > 0 && st.state === 'on' && Math.abs(actual - v) <= 2)) {
        delete next[id];
        changed = true;
      }
    }
    if (changed) this.pending = next;
  }

  private isOn(id: string): boolean {
    const p = this.pending[id];
    return p !== undefined ? p > 0 : this.st(id)?.state === 'on';
  }

  private level(id: string): number {
    return this.pending[id] ?? brightnessPct(this.st(id));
  }

  private send(id: string, pct: number): void {
    if (pct <= 0) void this.hass!.callService('light', 'turn_off', { entity_id: id });
    else if (supportsBrightness(this.st(id))) void this.hass!.callService('light', 'turn_on', { entity_id: id, brightness_pct: pct });
    else void this.hass!.callService('light', 'turn_on', { entity_id: id });
  }

  private setLight(id: string, pct: number): void {
    this.pending = { ...this.pending, [id]: pct };
    this.send(id, pct);
  }

  private toggleLight(id: string, on: boolean): void {
    this.pending = { ...this.pending, [id]: on ? this.lastLevel(id) : 0 };
    void this.hass!.callService('light', on ? 'turn_on' : 'turn_off', { entity_id: id });
  }

  /** What a light comes back on at: its last brightness if Home Assistant still has it, else full. */
  private lastLevel(id: string): number {
    const b = this.st(id)?.attributes.brightness as number | undefined;
    return b ? Math.max(1, Math.round((b / 255) * 100)) : 100;
  }

  // ---------------------------------------------------------------- area dimmer

  /** An area's level is its brightest light, so the dimmer can reach 100% while keeping the others in proportion. */
  private areaLevel(g: Group): number {
    return Math.max(0, ...g.lights.filter((id) => this.isOn(id)).map((id) => this.level(id)));
  }

  /**
   * Scale every on light by the same factor, so their differences in
   * brightness hold. With everything off, they all come on at the new level.
   */
  private areaTargets(g: Group, to: number): Record<string, number> {
    if (!this.drag || this.drag.area !== g.id) {
      const base: Record<string, number> = {};
      for (const id of g.lights) if (this.isOn(id)) base[id] = this.level(id);
      this.drag = { area: g.id, base, level: Math.max(0, ...Object.values(base)) };
    }
    const { base, level } = this.drag;
    const out: Record<string, number> = {};
    if (to <= 0) {
      for (const id of g.lights) out[id] = 0;
    } else if (level <= 0) {
      for (const id of g.lights) out[id] = to;
    } else {
      for (const [id, b] of Object.entries(base)) out[id] = Math.max(1, Math.min(100, Math.round((b * to) / level)));
    }
    return out;
  }

  private areaSlide(g: Group, to: number): void {
    this.pending = { ...this.pending, ...this.areaTargets(g, to) };
    // Send as it moves, but no more than every 350 ms.
    if (this.sendTimer) return;
    this.sendTimer = window.setTimeout(() => {
      this.sendTimer = undefined;
      const d = this.drag;
      if (!d || d.area !== g.id) return;
      for (const id of d.level > 0 ? Object.keys(d.base) : g.lights) this.send(id, this.pending[id] ?? 0);
    }, 350);
  }

  private areaSet(g: Group, to: number): void {
    const targets = this.areaTargets(g, to);
    window.clearTimeout(this.sendTimer);
    this.sendTimer = undefined;
    this.drag = undefined;
    this.pending = { ...this.pending, ...targets };
    for (const [id, pct] of Object.entries(targets)) this.send(id, pct);
  }

  private areaPower(g: Group, on: boolean): void {
    const next: Record<string, number> = {};
    for (const id of g.lights) next[id] = on ? this.lastLevel(id) : 0;
    this.pending = { ...this.pending, ...next };
    void this.hass!.callService('light', on ? 'turn_on' : 'turn_off', { entity_id: g.lights });
  }

  private allOff(): void {
    const on = this.groups.flatMap((g) => g.lights).filter((id) => this.isOn(id));
    if (!on.length) return;
    haptic('medium');
    const next: Record<string, number> = {};
    for (const id of on) next[id] = 0;
    this.pending = { ...this.pending, ...next };
    void this.hass!.callService('light', 'turn_off', { entity_id: on });
  }

  // ---------------------------------------------------------------- render

  private fill(st?: HassEntity): string {
    return hex(lightColor(st));
  }

  private area(g: Group) {
    const hass = this.hass!;
    const onCount = g.lights.filter((id) => this.isOn(id)).length;
    const level = this.areaLevel(g);
    const firstOn = g.lights.find((id) => this.isOn(id));
    return html`<section class="panel area" aria-label=${g.name}>
      <div class="ahead">
        <h3>${g.name}</h3>
        <span class="count">${onCount ? `${onCount} of ${g.lights.length} on` : 'Off'}</span>
      </div>
      <homeview-slider
        class="master"
        .mode=${this.mode}
        .label=${g.lights.length > 1 ? 'All lights' : hass.states[g.lights[0]]?.attributes.friendly_name ?? 'Light'}
        .value=${level}
        .min=${0}
        .max=${100}
        .on=${onCount > 0}
        .display=${g.lights.length === 1 && !supportsBrightness(this.st(g.lights[0])) ? 'On' : undefined}
        power
        .color=${this.fill(firstOn ? this.st(firstOn) : undefined)}
        @slide=${(e: CustomEvent<number>) => this.areaSlide(g, e.detail)}
        @value-change=${(e: CustomEvent<number>) => this.areaSet(g, e.detail)}
        @power=${(e: CustomEvent<boolean>) => this.areaPower(g, e.detail)}
      ></homeview-slider>
      ${g.scenes.length
        ? html`<div class="scenes">${g.scenes.map((id) => {
            const st = this.st(id);
            return html`<button class="scene gl" @click=${() => {
              haptic('light');
              void hass.callService('scene', 'turn_on', { entity_id: id });
            }}><ha-icon .icon=${st?.attributes.icon ?? 'mdi:palette-outline'}></ha-icon>${st?.attributes.friendly_name ?? id}</button>`;
          })}</div>`
        : nothing}
      ${g.lights.length > 1
        ? html`<div class="lights">${g.lights.map((id) => {
            const st = this.st(id);
            const name = String(st?.attributes.friendly_name ?? id).replace(new RegExp(`^${g.name}\\s+`, 'i'), '');
            const dimmable = supportsBrightness(st);
            // Unavailable: Home Assistant has lost touch with it, though commands may still get through, so it stays usable.
            const lost = !st || st.state === 'unavailable';
            return html`<homeview-slider
              class=${lost ? 'lost' : ''}
              .mode=${this.mode}
              .label=${name}
              .value=${this.isOn(id) ? (dimmable ? this.level(id) : 100) : 0}
              .min=${0}
              .max=${100}
              .on=${this.isOn(id)}
              .display=${lost ? 'Unavailable' : dimmable ? undefined : 'On'}
              power
              .color=${this.fill(st)}
              @value-change=${(e: CustomEvent<number>) => this.setLight(id, dimmable ? e.detail : e.detail > 0 ? 100 : 0)}
              @power=${(e: CustomEvent<boolean>) => this.toggleLight(id, e.detail)}
            ></homeview-slider>`;
          })}</div>`
        : nothing}
    </section>`;
  }

  render() {
    if (!this.hass) return nothing;
    const groups = this.groups;
    if (!groups.length) return html`<div class="panel sub">No lights found in any area.</div>`;
    if (!this.twoColumns) return html`<div class="col">${groups.map((g) => this.area(g))}</div>`;
    // Two stacks, each area going to the shorter one so far: top edges line up and the columns end close together.
    const cols: [Group[], Group[]] = [[], []];
    const height = [0, 0];
    for (const g of groups) {
      const i = height[0] <= height[1] ? 0 : 1;
      cols[i].push(g);
      height[i] += 2.2 + (g.scenes.length ? 0.8 : 0) + (g.lights.length > 1 ? g.lights.length : 0);
    }
    return html`<div class="areas">${cols.map((c) => html`<div class="col">${c.map((g) => this.area(g))}</div>`)}</div>`;
  }

  /** Two columns of rooms when the sheet is wide enough. */
  @state() private twoColumns = true;
  private widthWatch = new ResizeObserver(([e]) => {
    const two = e.contentRect.width >= 760;
    if (two !== this.twoColumns) this.twoColumns = two;
  });

  connectedCallback(): void {
    super.connectedCallback();
    this.widthWatch.observe(this);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.widthWatch.disconnect();
  }

  static styles = [
    ...PopupContent.styles,
    css`
      :host {
        display: flex;
        flex-direction: column;
        gap: 16px;
      }
      /* Two columns of rooms on a wide sheet, one on a narrow one. */
      .areas {
        display: grid;
        grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
        gap: 20px;
        align-items: start;
      }
      .col {
        display: flex;
        flex-direction: column;
        gap: 20px;
        min-width: 0;
      }
      .area {
        --_px: 24px;
        display: flex;
        flex-direction: column;
        gap: 12px;
      }
      .ahead {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 12px;
      }
      .ahead h3 {
        margin: 0;
        font-size: 24px;
        font-weight: 700;
      }
      .count {
        font-size: 16px;
        font-weight: 600;
        color: var(--_ink2);
        white-space: nowrap;
      }
      .master {
        --hv-slider-height: 68px;
      }
      /* Scenes scroll sideways right out to the panel's edges, fading there, rather than stopping short inside the padding. */
      .scenes {
        display: flex;
        gap: 8px;
        margin: 0 calc(-1 * var(--_px));
        padding: 2px var(--_px);
        scroll-padding: 0 var(--_px);
        overflow-x: auto;
        scrollbar-width: none;
        -webkit-overflow-scrolling: touch;
        -webkit-mask-image: linear-gradient(90deg, transparent, #000 var(--_px), #000 calc(100% - var(--_px)), transparent);
        mask-image: linear-gradient(90deg, transparent, #000 var(--_px), #000 calc(100% - var(--_px)), transparent);
      }
      .scenes::-webkit-scrollbar {
        display: none;
      }
      .scene {
        position: relative;
        flex: none;
        display: inline-flex;
        align-items: center;
        gap: 8px;
        height: 46px;
        padding: 0 16px;
        border: 0;
        border-radius: 999px;
        color: var(--_ink);
        font: inherit;
        font-size: 16px;
        font-weight: 600;
        cursor: pointer;
        --mdc-icon-size: 20px;
      }
      .lights {
        display: flex;
        flex-direction: column;
        gap: 8px;
        padding-top: 4px;
        border-top: 1px solid var(--_track);
      }
      .lights homeview-slider {
        --hv-slider-height: 56px;
      }
      .lights homeview-slider.lost {
        opacity: 0.55;
      }
      @container (max-width: 520px) {
        .panel {
          padding: 16px;
        }
        .area {
          --_px: 16px;
        }
      }
    `,
  ];
}

defineElement('homeview-all-lights-popup', HomeViewAllLightsPopup);
