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
  /** The stream is there but paused: the Home Assistant app can refuse to autoplay until it's tapped. */
  @state() private blocked = false;
  private timer?: number;
  private watch?: number;
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
    window.clearInterval(this.watch);
    this.watch = undefined;
  }

  protected updated(): void {
    if (!this.ready || this.watch) return;
    // Give the stream a few seconds to start, then offer a play button if it's sitting paused.
    let checks = 0;
    this.watch = window.setInterval(() => {
      const video = this.video();
      checks++;
      if (video && !video.paused) {
        this.blocked = false;
        window.clearInterval(this.watch);
      } else if (video && checks >= 3) {
        this.blocked = true;
        video.addEventListener('playing', () => (this.blocked = false), { once: true });
        window.clearInterval(this.watch);
      } else if (checks >= 15) {
        window.clearInterval(this.watch);
      }
    }, 1000);
  }

  /** The <video> inside Home Assistant's stream element (HLS or WebRTC player), if it has one. */
  private video(): HTMLVideoElement | undefined {
    const stream = this.renderRoot.querySelector('ha-camera-stream');
    const root = stream?.shadowRoot;
    const player = root?.querySelector('ha-hls-player, ha-web-rtc-player');
    return (player?.shadowRoot?.querySelector('video') ?? root?.querySelector('video') ?? undefined) as HTMLVideoElement | undefined;
  }

  /** A tap is the permission the app wanted. */
  private play = (): void => {
    const video = this.video();
    if (!video) return;
    video.muted = this.muted;
    void video.play().then(
      () => (this.blocked = false),
      () => undefined,
    );
  };

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
      ${this.blocked
        ? html`<button class="playbig" aria-label="Play the live stream" @click=${this.play}><ha-icon icon="mdi:play"></ha-icon></button>`
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
      .playbig {
        position: absolute;
        z-index: 1;
        left: 50%;
        top: 50%;
        width: 88px;
        height: 88px;
        margin: -44px 0 0 -44px;
        display: grid;
        place-items: center;
        border: 0;
        border-radius: 50%;
        color: #fff;
        background: rgba(20, 20, 24, 0.5);
        -webkit-backdrop-filter: blur(14px);
        backdrop-filter: blur(14px);
        cursor: pointer;
        --mdc-icon-size: 44px;
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
