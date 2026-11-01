import { css, html, nothing } from 'lit';
import { state } from 'lit/decorators.js';
import { HomeViewCard, type BaseCardConfig } from '../core/base-card';
import type { GridOptions } from '../core/types';
import { detections, ensureStreamElement, snapshotUrl, type CameraEvent } from '../core/camera';
import { duration, isUnavailable, time } from '../core/format';
import { defineElement, registerCard } from '../core/register';
import { actionsSection, choose, editorFor, layoutSection, type EditorSpec } from '../core/editor';

export type { CameraEvent } from '../core/camera';

export interface CameraCardConfig extends BaseCardConfig {
  entity: string;
  /** `live` streams when the camera supports it, `snapshot` refreshes a still. */
  view?: 'live' | 'snapshot';
  /** Seconds between snapshot refreshes. */
  refresh?: number;
  events?: CameraEvent[];
  /** Only show detections from the last N minutes. */
  event_window?: number;
  show_live_badge?: boolean;
  show_time?: boolean;
  /** A higher-resolution camera for the pop-up a tap opens. Defaults to `entity`. */
  stream_entity?: string;
  /** The pop-up's shape, as the stream's width:height. Default 16:9. */
  aspect_ratio?: string;
}

const EDITOR: EditorSpec = {
  schema: (c) => [
    { name: 'entity', required: true, selector: { entity: { domain: 'camera' } } },
    { name: 'name', selector: { text: {} } },
    { name: 'view', selector: choose([['live', 'Live stream'], ['snapshot', 'Snapshot, refreshed']], 'list') },
    ...(c.view === 'snapshot' ? [{ name: 'refresh', selector: { number: { min: 2, max: 300, mode: 'box', unit_of_measurement: 's' } } }] : []),
    {
      name: 'events',
      selector: {
        object: {
          multiple: true,
          label_field: 'label',
          fields: {
            entity: { label: 'Detection entity', required: true, selector: { entity: { domain: ['binary_sensor', 'event'] } } },
            label: { label: 'Label', selector: { text: {} } },
            icon: { label: 'Icon', selector: { icon: {} } },
          },
        },
      },
    },
    {
      type: 'expandable',
      name: '',
      title: 'Pop-up',
      icon: 'mdi:arrow-expand',
      schema: [
        { name: 'stream_entity', selector: { entity: { domain: 'camera' } } },
        { name: 'aspect_ratio', selector: choose([['16:9', '16:9'], ['4:3', '4:3'], ['3:2', '3:2'], ['1:1', 'Square'], ['9:16', '9:16 (portrait)']]) },
      ],
    },
    ...(c.events?.length ? [{ name: 'event_window', selector: { number: { min: 1, max: 1440, mode: 'box', unit_of_measurement: 'min' } } }] : []),
    { type: 'grid', name: '', schema: [{ name: 'show_live_badge', selector: { boolean: {} } }, { name: 'show_time', selector: { boolean: {} } }] },
    actionsSection(),
    layoutSection,
  ],
  labels: { entity: 'Camera', stream_entity: 'Stream in the pop-up', aspect_ratio: 'Pop-up shape', view: 'Feed', refresh: 'Refresh every', events: 'Detections', event_window: 'Show detections from the last', show_live_badge: 'LIVE badge', show_time: 'Clock' },
  helpers: {
    tap_action: "Default: opens HomeView's camera pop-up. Hold opens Home Assistant's more-info",
    events: 'The most recent one shows in a chip on the feed',
    stream_entity: 'A higher-resolution camera (often the main stream) to play when tapped. Empty: the card\'s camera',
  },
};

/** Camera (design A): full-bleed feed, LIVE badge, and the latest detection in a glass chip. */
export class HomeViewCameraCard extends HomeViewCard<CameraCardConfig> {
  @state() private streamReady = !!customElements.get('ha-camera-stream');
  @state() private snapshotTick = 0;
  @state() private clock = new Date();
  private timers: number[] = [];

  static getConfigElement() {
    return editorFor(EDITOR);
  }

  static getStubConfig(_hass: unknown, entities: string[], fallback: string[]) {
    return { entity: [...entities, ...fallback].find((e) => e.startsWith('camera.')) ?? '' };
  }

  protected validate(config: CameraCardConfig): void {
    if (!config.entity) throw new Error('Set a camera entity');
  }

  protected defaults(): Partial<CameraCardConfig> {
    return { view: 'live', refresh: 10, event_window: 30, show_live_badge: true, show_time: true };
  }

  protected watched() {
    return [this.config.entity, ...(this.config.events ?? []).map((e) => e.entity)];
  }

  protected popupName(): string {
    return 'camera';
  }

  connectedCallback(): void {
    super.connectedCallback();
    if (this.config?.view !== 'snapshot' && !this.streamReady) {
      void ensureStreamElement().then(() => (this.streamReady = !!customElements.get('ha-camera-stream')));
    }
    this.timers.push(window.setInterval(() => (this.clock = new Date()), 1000));
    this.timers.push(window.setInterval(() => this.snapshotTick++, (this.config?.refresh ?? 10) * 1000));
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.timers.forEach((t) => window.clearInterval(t));
    this.timers = [];
  }

  render() {
    if (!this.hass) return nothing;
    const st = this.stateObj();
    const name = this.config.name ?? st?.attributes.friendly_name ?? this.config.entity;
    if (!st || isUnavailable(st)) {
      return html`<ha-card class="tile">
        <div class="in">
          <span class="round gl badge"><ha-icon icon="mdi:camera-off-outline"></ha-icon></span>
          <div><div class="name">${name}</div><div class="sub">Offline${st ? ` · ${duration(Date.now() - Date.parse(st.last_changed))}` : ''}</div></div>
        </div>
      </ha-card>`;
    }
    const live = this.config.view !== 'snapshot' && this.streamReady;
    const event = detections(this.hass, this.config.events, this.config.event_window ?? 30)[0];
    const small = this.size === 's';
    return html`
      <ha-card class="tile cam ${this.clickable ? 'clickable' : ''}" tabindex="0" role="button" aria-label="${name} camera">
        ${live
          ? html`<ha-camera-stream class="feed" .hass=${this.hass} .stateObj=${st} muted .controls=${false} .fitMode=${'cover'}></ha-camera-stream>`
          : html`<img class="feed" src=${snapshotUrl(this.hass, st, this.snapshotTick)} alt="" />`}
        <div class="scan" aria-hidden="true"></div>
        <div class="fade top" aria-hidden="true"></div>
        <div class="fade bottom" aria-hidden="true"></div>
        <div class="bar head">
          <div class="name">${name}</div>
          ${this.config.show_live_badge
            ? small
              ? html`<span class="dot" aria-label="Live"></span>`
              : html`<span class="live"><i></i>LIVE</span>`
            : nothing}
        </div>
        <div class="bar foot">
          ${event
            ? html`<span class="event gl" aria-label="${event.ev.label ?? event.st.attributes.friendly_name}, ${event.ago < 60_000 ? 'just now' : `${duration(event.ago)} ago`}"><ha-icon .icon=${event.ev.icon ?? event.st.attributes.icon ?? 'mdi:motion-sensor'}></ha-icon>${small
                ? // On a 1×1 tile the time matters most; the icon says what it was.
                  event.ago < 60_000
                  ? 'Now'
                  : `${duration(event.ago)} ago`
                : `${event.ev.label ?? event.st.attributes.friendly_name} · ${event.ago < 60_000 ? 'now' : `${duration(event.ago)} ago`}`}</span>`
            : small
              ? html`<span class="sub light">Clear · ${time(this.hass, this.clock)}</span>`
              : html`<span></span>`}
          ${this.config.show_time && !small ? html`<span class="clock">${time(this.hass, this.clock, true)}</span>` : nothing}
        </div>
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
      .cam {
        background: #1c1f1c;
        color: #fff;
      }
      .feed {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        object-fit: cover;
        --video-max-height: 100%;
      }
      .scan {
        position: absolute;
        inset: 0;
        background: repeating-linear-gradient(0deg, rgba(255, 255, 255, 0.03) 0 1px, rgba(0, 0, 0, 0) 1px 3px),
          radial-gradient(ellipse at center, rgba(0, 0, 0, 0) 55%, rgba(0, 0, 0, 0.4) 100%);
        pointer-events: none;
      }
      .fade {
        position: absolute;
        left: 0;
        right: 0;
        height: 96px;
        pointer-events: none;
      }
      .fade.top {
        top: 0;
        background: linear-gradient(rgba(0, 0, 0, 0.5), rgba(0, 0, 0, 0));
      }
      .fade.bottom {
        bottom: 0;
        background: linear-gradient(rgba(0, 0, 0, 0), rgba(0, 0, 0, 0.55));
      }
      .bar {
        position: absolute;
        left: 20px;
        right: 20px;
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 10px;
      }
      .head {
        top: 18px;
      }
      .foot {
        bottom: 18px;
      }
      .live {
        display: flex;
        align-items: center;
        gap: 7px;
        height: 32px;
        padding: 0 12px;
        border-radius: 999px;
        background: var(--hv-c-alert);
        font-size: 15px;
        font-weight: 700;
        letter-spacing: 0.06em;
        flex: none;
      }
      .live i,
      .dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: #fff;
        animation: pulse 1.6s ease-in-out infinite;
      }
      .dot {
        width: 12px;
        height: 12px;
        background: var(--hv-c-alert);
        box-shadow: 0 0 0 3px rgba(229, 72, 77, 0.35);
      }
      .event {
        display: flex;
        align-items: center;
        gap: 8px;
        height: 44px;
        padding: 0 16px 0 12px;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.16);
        font-size: 17px;
        font-weight: 600;
        white-space: nowrap;
        overflow: hidden;
        --mdc-icon-size: 20px;
      }
      .clock,
      .light {
        font-size: 17px;
        font-weight: 600;
        color: rgba(255, 255, 255, 0.82);
      }
      .badge {
        width: 48px;
        height: 48px;
        color: var(--_ink2);
      }
      @keyframes pulse {
        50% {
          opacity: 0.35;
        }
      }
      @media (prefers-reduced-motion: reduce) {
        .live i,
        .dot {
          animation: none;
        }
      }
    `,
  ];
}

defineElement('homeview-camera-card', HomeViewCameraCard);
registerCard({
  type: 'homeview-camera-card',
  name: 'HomeView Camera',
  description: 'Full-bleed live camera with the latest detection in a glass chip.',
  getEntitySuggestion: (_hass, entityId) =>
    entityId.startsWith('camera.') ? { config: { type: 'custom:homeview-camera-card', entity: entityId } } : null,
  docs: 'camera',
});
