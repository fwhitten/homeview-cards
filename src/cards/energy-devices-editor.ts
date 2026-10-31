import { LitElement, css, html, nothing } from 'lit';
import { property, state } from 'lit/decorators.js';
import type { HomeAssistant, LovelaceCardConfig } from '../core/types';
import { energyDevices, fetchPrefs, type DeviceOverride, type EnergyDevice, type EnergyPrefs } from '../core/energy';
import { defineElement } from '../core/register';
import { fireEvent } from '../core/events';

/**
 * The Devices section of the energy card editor, as in energy-breakdown-card:
 * every device from the Energy dashboard, to rename, recolour, hide from the
 * breakdowns (Σ still counts it) or exclude from the total altogether.
 */
export class HomeViewEnergyDevicesEditor extends LitElement {
  @property({ attribute: false }) hass?: HomeAssistant;
  @property({ attribute: false }) config?: LovelaceCardConfig;
  @state() private prefs?: EnergyPrefs;
  @state() private error?: string;

  protected firstUpdated(): void {
    if (!this.hass) return;
    fetchPrefs(this.hass)
      .then((p) => (this.prefs = p))
      .catch(() => (this.error = "Couldn't read the Energy dashboard. Set it up to manage devices here."));
  }

  private get overrides(): DeviceOverride[] {
    return (this.config?.devices as DeviceOverride[] | undefined) ?? [];
  }

  private update_(stat: string, patch: Partial<DeviceOverride>): void {
    const list = [...this.overrides];
    const i = list.findIndex((d) => d.stat === stat);
    const next: DeviceOverride = { ...(i >= 0 ? list[i] : { stat }), ...patch };
    for (const k of Object.keys(next) as Array<keyof DeviceOverride>) if (next[k] === undefined || next[k] === '' || next[k] === false) delete next[k];
    const empty = Object.keys(next).length === 1;
    if (i >= 0) {
      if (empty) list.splice(i, 1);
      else list[i] = next;
    } else if (!empty) list.push(next);
    fireEvent(this, 'devices-changed', list.length ? list : undefined);
  }

  private row(d: EnergyDevice) {
    const o = this.overrides.find((x) => x.stat === d.stat);
    const original = this.prefs?.device_consumption.find((x) => x.stat_consumption === d.stat)?.name || d.stat;
    return html`<div class="device ${d.hidden || d.excluded ? 'off' : ''}">
      <input class="color" type="color" .value=${d.color} title="Colour" @change=${(e: Event) => this.update_(d.stat, { color: (e.target as HTMLInputElement).value })} />
      <div class="field">
        <span class="orig" title=${d.stat}>${original}</span>
        <input class="rename" type="text" placeholder=${original} .value=${o?.name ?? ''} @change=${(e: Event) => this.update_(d.stat, { name: (e.target as HTMLInputElement).value || undefined })} />
      </div>
      <button
        class="toggle ${d.excluded ? 'active' : ''}"
        title=${d.excluded ? 'Excluded from the total. Tap to count it again' : 'Counted in the total. Tap to exclude it'}
        aria-pressed=${d.excluded}
        @click=${() => this.update_(d.stat, { excluded: !d.excluded || undefined })}
      >Σ</button>
      <button
        class="toggle ${d.hidden ? 'active' : ''}"
        title=${d.hidden ? 'Hidden from the graphs. Tap to show' : 'Shown in the graphs. Tap to hide'}
        aria-pressed=${d.hidden}
        ?disabled=${d.excluded}
        @click=${() => this.update_(d.stat, { hidden: !d.hidden || undefined })}
      ><ha-icon .icon=${d.hidden ? 'mdi:eye-off-outline' : 'mdi:eye-outline'}></ha-icon></button>
    </div>`;
  }

  render() {
    if (!this.hass) return nothing;
    const devices = energyDevices(this.hass, this.prefs, (this.config ?? {}) as never);
    return html`<div class="head"><ha-icon icon="mdi:devices"></ha-icon>Devices</div>
      ${this.error
        ? html`<div class="hint warn">${this.error}</div>`
        : !this.prefs
          ? html`<div class="hint">Loading devices from the Energy dashboard…</div>`
          : !devices.length
            ? html`<div class="hint">No individual devices are set up in the Energy dashboard yet.</div>`
            : html`<div class="hint">
                  Rename or recolour any device. The eye hides a device from the graphs and breakdowns; it still counts towards
                  the total, as part of Other. Σ takes it out of the total entirely.
                </div>
                ${devices.map((d) => this.row(d))}`}`;
  }

  static styles = css`
    :host {
      display: block;
    }
    .head {
      display: flex;
      align-items: center;
      gap: 8px;
      font-weight: 500;
      margin-bottom: 6px;
      --mdc-icon-size: 20px;
    }
    .hint {
      font-size: 0.875em;
      color: var(--secondary-text-color);
      margin-bottom: 10px;
    }
    .warn {
      color: var(--error-color, #db4437);
    }
    .device {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 10px;
    }
    .device.off .field {
      opacity: 0.5;
    }
    .field {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .orig {
      font-size: 0.8em;
      color: var(--secondary-text-color);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    /* Native inputs, so the rows don't depend on which HA form elements happen to be loaded. */
    .rename {
      box-sizing: border-box;
      width: 100%;
      font: inherit;
      padding: 7px 9px;
      border-radius: 6px;
      border: 1px solid var(--divider-color, #444);
      background: var(--secondary-background-color, rgba(127, 127, 127, 0.12));
      color: var(--primary-text-color);
    }
    .rename:focus {
      outline: none;
      border-color: var(--primary-color);
    }
    .color {
      width: 34px;
      height: 34px;
      padding: 0;
      border: none;
      border-radius: 50%;
      background: none;
      cursor: pointer;
      flex: none;
    }
    .color::-webkit-color-swatch-wrapper {
      padding: 0;
    }
    .color::-webkit-color-swatch {
      border: none;
      border-radius: 50%;
    }
    .toggle {
      flex: none;
      width: 34px;
      height: 34px;
      display: grid;
      place-items: center;
      padding: 0;
      border: none;
      border-radius: 50%;
      cursor: pointer;
      font: inherit;
      font-size: 1.1em;
      color: var(--primary-text-color);
      background: var(--secondary-background-color, rgba(127, 127, 127, 0.15));
      --mdc-icon-size: 18px;
    }
    .toggle.active {
      color: var(--text-primary-color, #fff);
      background: var(--primary-color, #03a9f4);
    }
    .toggle:disabled {
      opacity: 0.35;
      cursor: default;
    }
  `;
}

defineElement('homeview-energy-devices-editor', HomeViewEnergyDevicesEditor);
