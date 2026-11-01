import { css, html, nothing } from 'lit';
import { state } from 'lit/decorators.js';
import { PopupContent } from './popup-base';
import { detections, ensureStreamElement, parseAspect, snapshotUrl, type CameraEvent } from '../core/camera';
import { duration, isUnavailable, time } from '../core/format';
import { defineElement } from '../core/register';

/**
 * Camera pop-up: the feed edge to edge, as large as the screen allows, from
 * the camera card's `stream_entity` (a higher-resolution stream) or its own
 * entity. It plays straight away, muted and without player controls; the
 * latest still shows underneath until the stream starts.
 */
export class HomeViewCameraPopup extends PopupContent {
  static layout = 'media' as const;

  static aspectFor(config: Record<string, unknown>): number {
    return parseAspect(config.aspect_ratio);
  }

  @state() private ready = !!customElements.get('ha-camera-stream');
  @state() private muted = true;
  @state() private clock = new Date();
  private timer?: number;
  private opened = Date.now();

  private get streamEntity(): string | undefined {
    return (this.cfg.stream_entity as string | undefined) ?? this.props?.entity;
  }

  popupTitle(): string {
    const st = this.st(this.props?.entity);
    return (this.cfg.name as string | undefined) ?? st?.attributes.friendly_name ?? this.props?.entity ?? '';
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.opened = Date.now();
    this.timer = window.setInterval(() => (this.clock = new Date()), 1000);
    if (!this.ready) void ensureStreamElement().then(() => (this.ready = !!customElements.get('ha-camera-stream')));
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.clearInterval(this.timer);
  }

  render() {
    if (!this.hass) return nothing;
    const st = this.st(this.streamEntity);
    if (!st || isUnavailable(st)) {
      return html`<div class="off"><ha-icon icon="mdi:camera-off-outline"></ha-icon><span>Camera unavailable</span></div>`;
    }
    const events = detections(this.hass, this.cfg.events as CameraEvent[] | undefined, (this.cfg.event_window as number | undefined) ?? 30);
    // The card's own (often lower-resolution) still stands in until the stream's first frame.
    const poster = this.st(this.props?.entity) ?? st;
    return html`
      <img class="feed" src=${snapshotUrl(this.hass, poster, this.opened)} alt="" />
      ${this.ready
        ? html`<ha-camera-stream class="feed" .hass=${this.hass} .stateObj=${st} .muted=${this.muted} .controls=${false} .fitMode=${'cover'} allow-exoplayer></ha-camera-stream>`
        : nothing}
      <div class="fade" aria-hidden="true"></div>
      <div class="foot">
        <span class="live"><i></i>LIVE</span>
        ${events.slice(0, 3).map(
          (d) => html`<span class="event"><ha-icon .icon=${d.ev.icon ?? d.st.attributes.icon ?? 'mdi:motion-sensor'}></ha-icon>${d.ev.label ?? d.st.attributes.friendly_name} · ${d.ago < 60_000 ? 'now' : `${duration(d.ago)} ago`}</span>`,
        )}
        <span class="spacer"></span>
        <span class="clock">${time(this.hass, this.clock, true)}</span>
        <button class="round" aria-label=${this.muted ? 'Unmute' : 'Mute'} aria-pressed=${!this.muted} @click=${() => (this.muted = !this.muted)}>
          <ha-icon .icon=${this.muted ? 'mdi:volume-off' : 'mdi:volume-high'}></ha-icon>
        </button>
      </div>
    `;
  }

  static styles = [
    ...PopupContent.styles,
    css`
      :host {
        position: relative;
        display: block;
        height: 100%;
        background: #000;
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
      .fade {
        position: absolute;
        left: 0;
        right: 0;
        bottom: 0;
        height: 120px;
        background: linear-gradient(rgba(0, 0, 0, 0), rgba(0, 0, 0, 0.55));
        pointer-events: none;
      }
      .foot {
        position: absolute;
        left: 24px;
        right: 22px;
        bottom: 20px;
        display: flex;
        align-items: center;
        gap: 10px;
        flex-wrap: wrap;
      }
      .spacer {
        flex: 1;
      }
      .live {
        display: flex;
        align-items: center;
        gap: 7px;
        height: 34px;
        padding: 0 13px;
        border-radius: 999px;
        background: var(--hv-c-alert);
        font-size: 15px;
        font-weight: 700;
        letter-spacing: 0.06em;
      }
      .live i {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: #fff;
      }
      .event {
        display: inline-flex;
        align-items: center;
        gap: 7px;
        height: 34px;
        padding: 0 14px 0 10px;
        border-radius: 999px;
        font-size: 16px;
        font-weight: 600;
        background: rgba(20, 20, 24, 0.45);
        -webkit-backdrop-filter: blur(12px);
        backdrop-filter: blur(12px);
        --mdc-icon-size: 19px;
      }
      .clock {
        font-size: 17px;
        font-weight: 600;
        text-shadow: 0 1px 6px rgba(0, 0, 0, 0.5);
      }
      .round {
        width: 48px;
        height: 48px;
        color: #fff;
        background: rgba(20, 20, 24, 0.45);
        -webkit-backdrop-filter: blur(12px);
        backdrop-filter: blur(12px);
        cursor: pointer;
        --mdc-icon-size: 22px;
      }
      .off {
        position: absolute;
        inset: 0;
        display: grid;
        place-content: center;
        justify-items: center;
        gap: 10px;
        font-size: 18px;
        font-weight: 600;
        color: rgba(255, 255, 255, 0.7);
        --mdc-icon-size: 40px;
      }
    `,
  ];
}

defineElement('homeview-camera-popup', HomeViewCameraPopup);
