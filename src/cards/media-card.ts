import { css, html, nothing, type PropertyValues } from 'lit';
import { state } from 'lit/decorators.js';
import { HomeViewCard, type BaseCardConfig } from '../core/base-card';
import type { DragHandlers } from '../core/gestures';
import type { GridOptions, HassEntity } from '../core/types';
import { isUnavailable } from '../core/format';
import { defineElement, registerCard } from '../core/register';
import { fireEvent, haptic } from '../core/events';
import { actionsSection, appearanceSection, choose, editorFor, layoutSection, type EditorSpec } from '../core/editor';

export interface MediaCardConfig extends BaseCardConfig {
  entity: string;
  /** A: artwork beside the controls (2×1). B: large artwork (2×2). Auto picks by tile size. */
  layout?: 'auto' | 'compact' | 'artwork';
  /** Swipe up or down on the tile to change volume. */
  swipe_volume?: boolean;
}

/** MediaPlayerEntityFeature bits from Home Assistant core. */
const F = {
  PAUSE: 1,
  SEEK: 2,
  VOLUME_SET: 4,
  VOLUME_MUTE: 8,
  PREVIOUS_TRACK: 16,
  NEXT_TRACK: 32,
  PLAY: 16384,
  SHUFFLE_SET: 32768,
  REPEAT_SET: 262144,
};

const supports = (st: HassEntity, flag: number): boolean => ((st.attributes.supported_features ?? 0) & flag) !== 0;

const mmss = (s: number): string => {
  const t = Math.max(0, Math.floor(s));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = String(t % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
};

interface ArtworkInfo {
  colors: [string, string];
  /** A small JPEG copy, so the card keeps its artwork after the player drops it. */
  dataUrl?: string;
}

interface CachedNowPlaying {
  art?: string;
  title?: string;
  artist?: string;
  colors?: [string, string];
}

const CACHE_PREFIX = 'homeview-media:';

const readCache = (entity: string): CachedNowPlaying | undefined => {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + entity);
    return raw ? (JSON.parse(raw) as CachedNowPlaying) : undefined;
  } catch {
    return undefined;
  }
};

const writeCache = (entity: string, value: CachedNowPlaying): void => {
  try {
    localStorage.setItem(CACHE_PREFIX + entity, JSON.stringify(value));
  } catch {
    /* storage full or blocked: the card still works, just without the memory */
  }
};

/** Two colours from the artwork (top-left and bottom-right) for the wash, plus a small copy to cache. */
const sampleArtwork = (url: string): Promise<ArtworkInfo | undefined> =>
  new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = c.height = 2;
        const ctx = c.getContext('2d', { willReadFrequently: true })!;
        ctx.drawImage(img, 0, 0, 2, 2);
        const d = ctx.getImageData(0, 0, 2, 2).data;
        const px = (i: number) => `rgb(${d[i]},${d[i + 1]},${d[i + 2]})`;
        const big = document.createElement('canvas');
        big.width = big.height = 320;
        big.getContext('2d')!.drawImage(img, 0, 0, 320, 320);
        let dataUrl: string | undefined;
        try {
          dataUrl = big.toDataURL('image/jpeg', 0.82);
        } catch {
          dataUrl = undefined;
        }
        resolve({ colors: [px(0), px(12)], dataUrl });
      } catch {
        resolve(undefined);
      }
    };
    img.onerror = () => resolve(undefined);
    img.src = url;
  });

const EDITOR: EditorSpec = {
  schema: () => [
    { name: 'entity', required: true, selector: { entity: { domain: 'media_player' } } },
    { name: 'name', selector: { text: {} } },
    { name: 'layout', selector: choose([['auto', 'Auto, by tile size'], ['compact', 'A: artwork beside the controls (2×1)'], ['artwork', 'B: large artwork (2×2)']], 'list') },
    { name: 'swipe_volume', selector: { boolean: {} } },
    appearanceSection,
    actionsSection(),
    layoutSection,
  ],
  labels: { entity: 'Media player', layout: 'Layout', swipe_volume: 'Swipe up and down for volume' },
  helpers: { tap_action: 'Default: more-info' },
};

/**
 * Media (layouts A and B): HomeView's now-playing look. The background is
 * tinted from the artwork; only controls the player supports are shown.
 */
export class HomeViewMediaCard extends HomeViewCard<MediaCardConfig> {
  @state() private wash?: [string, string];
  @state() private nowSec = Date.now();
  @state() private dragVolume?: number;
  private washFor?: string;
  private ticker?: number;
  private volBase = 0;
  private volTimer?: number;

  static getConfigElement() {
    return editorFor(EDITOR);
  }

  static getStubConfig(_hass: unknown, entities: string[], fallback: string[]) {
    return { entity: [...entities, ...fallback].find((e) => e.startsWith('media_player.')) ?? '' };
  }

  protected validate(config: MediaCardConfig): void {
    if (!config.entity) throw new Error('Set a media player');
  }

  protected defaults(): Partial<MediaCardConfig> {
    return { layout: 'auto', swipe_volume: true };
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.ticker = window.setInterval(() => {
      if (this.stateObj()?.state === 'playing') this.nowSec = Date.now();
    }, 1000);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.clearInterval(this.ticker);
  }

  protected updated(changed: PropertyValues): void {
    super.updated(changed);
    const art = this.artwork;
    if (art && art !== this.washFor) {
      this.washFor = art;
      const st = this.stateObj();
      void sampleArtwork(art).then((info) => {
        if (!info) return;
        this.wash = info.colors;
        writeCache(this.config.entity, {
          art: info.dataUrl,
          title: st?.attributes.media_title,
          artist: st?.attributes.media_artist ?? st?.attributes.app_name,
          colors: info.colors,
        });
      });
    }
  }

  private get artwork(): string | undefined {
    const st = this.stateObj();
    const pic = (st?.attributes.entity_picture_local ?? st?.attributes.entity_picture) as string | undefined;
    return pic ? this.hass!.hassUrl(pic) : undefined;
  }

  private svc(service: string, data: Record<string, unknown> = {}) {
    return (ev: Event) => {
      ev.stopPropagation();
      if (this.preview) return;
      haptic('light');
      void this.call('media_player', service, { entity_id: this.config.entity, ...data });
    };
  }

  protected dragHandlers(): DragHandlers | undefined {
    const st = this.stateObj();
    if (!st || !this.config.swipe_volume || !supports(st, F.VOLUME_SET)) return undefined;
    return {
      axis: 'y',
      start: () => {
        this.volBase = Math.round(((this.stateObj()?.attributes.volume_level as number) ?? 0) * 100);
        haptic('selection');
      },
      move: (f) => {
        const v = Math.round(Math.min(100, Math.max(0, this.volBase + f * 100)));
        if (v === this.dragVolume) return;
        this.dragVolume = v;
        window.clearTimeout(this.volTimer);
        this.volTimer = window.setTimeout(
          () => void this.call('media_player', 'volume_set', { entity_id: this.config.entity, volume_level: v / 100 }),
          150,
        );
      },
      end: () => window.setTimeout(() => (this.dragVolume = undefined), 900),
    };
  }

  private position(st: HassEntity): { pos: number; dur: number } | undefined {
    const dur = st.attributes.media_duration as number | undefined;
    let pos = st.attributes.media_position as number | undefined;
    if (!dur || pos == null) return undefined;
    if (st.state === 'playing' && st.attributes.media_position_updated_at) {
      pos += (this.nowSec - Date.parse(st.attributes.media_position_updated_at)) / 1000;
    }
    return { pos: Math.min(dur, pos), dur };
  }

  private moreInfo = (ev: Event): void => {
    ev.stopPropagation();
    fireEvent(this, 'hass-more-info', { entityId: this.config.entity });
  };

  private controls(st: HassEntity, big: boolean) {
    const playing = st.state === 'playing';
    const canPause = supports(st, F.PAUSE);
    const canPlay = supports(st, F.PLAY) || canPause;
    return html`
      ${big && supports(st, F.SHUFFLE_SET)
        ? html`<button class="round ctl side ${st.attributes.shuffle ? 'on' : ''}" aria-label="Shuffle" aria-pressed=${!!st.attributes.shuffle} @click=${this.svc('shuffle_set', { shuffle: !st.attributes.shuffle })}><ha-icon icon="mdi:shuffle-variant"></ha-icon></button>`
        : big ? html`<span class="side"></span>` : nothing}
      ${supports(st, F.PREVIOUS_TRACK)
        ? html`<button class="round ctl" aria-label="Previous track" @click=${this.svc('media_previous_track')}><ha-icon icon="mdi:skip-previous"></ha-icon></button>`
        : nothing}
      ${canPlay
        ? html`<button class="round ctl main" aria-label=${playing ? 'Pause' : 'Play'} @click=${this.svc('media_play_pause')}><ha-icon .icon=${playing ? 'mdi:pause' : 'mdi:play'}></ha-icon></button>`
        : nothing}
      ${supports(st, F.NEXT_TRACK)
        ? html`<button class="round ctl" aria-label="Next track" @click=${this.svc('media_next_track')}><ha-icon icon="mdi:skip-next"></ha-icon></button>`
        : nothing}
      ${big && supports(st, F.REPEAT_SET)
        ? html`<button class="round ctl side ${st.attributes.repeat !== 'off' ? 'on' : ''}" aria-label="Repeat" @click=${this.svc('repeat_set', { repeat: st.attributes.repeat === 'off' ? 'all' : st.attributes.repeat === 'all' ? 'one' : 'off' })}><ha-icon .icon=${st.attributes.repeat === 'one' ? 'mdi:repeat-once' : 'mdi:repeat'}></ha-icon></button>`
        : big ? html`<span class="side"></span>` : nothing}
    `;
  }

  private volumeButton(st: HassEntity, small: boolean, corner = '') {
    if (!supports(st, F.VOLUME_MUTE) && !supports(st, F.VOLUME_SET)) return nothing;
    const muted = !!st.attributes.is_volume_muted;
    return html`<button
      class="round gl vol ${small ? 'sm' : ''} ${corner}"
      aria-label=${muted ? 'Unmute' : 'Mute'}
      @click=${supports(st, F.VOLUME_MUTE) ? this.svc('volume_mute', { is_volume_muted: !muted }) : this.moreInfo}
    >
      <ha-icon .icon=${muted ? 'mdi:volume-off' : 'mdi:volume-high'}></ha-icon>
    </button>`;
  }

  render() {
    if (!this.hass) return nothing;
    const st = this.stateObj();
    const name = this.config.name ?? st?.attributes.friendly_name ?? this.config.entity;
    if (!st || isUnavailable(st)) {
      return html`<ha-card class="tile"><div class="in"><span class="round gl badge"><ha-icon icon="mdi:speaker-off"></ha-icon></span><div><div class="name">${name}</div><div class="sub">Unavailable</div></div></div></ha-card>`;
    }
    const layout = this.config.layout === 'auto' || !this.config.layout ? (this.size === 'l' || this.size === 't' ? 'artwork' : 'compact') : this.config.layout;
    const big = layout === 'artwork';
    const idle = ['off', 'idle', 'standby', 'on'].includes(st.state) && !st.attributes.media_title;
    // When the player drops its artwork (paused a while, or idle), keep showing the last track.
    const cached = !this.artwork || idle ? readCache(this.config.entity) : undefined;
    const [c1, c2] = this.wash ?? cached?.colors ?? ['#d0466f', '#f0a35a'];
    const art = this.artwork ?? cached?.art;
    const title = (st.attributes.media_title as string) ?? cached?.title ?? (idle ? 'Nothing playing' : name);
    const artist = (st.attributes.media_artist as string) ?? (st.attributes.app_name as string) ?? cached?.artist ?? (idle ? name : '');
    const pos = this.position(st);
    const vol = this.dragVolume;

    return html`
      <ha-card class="tile media ${big ? 'big' : 'compact'} ${this.clickable ? 'clickable' : ''}" tabindex="0" role="button" aria-label="${name}: ${title}${artist ? `, ${artist}` : ''}">
        <div class="bg" aria-hidden="true">
          <div class="wash" style="background:radial-gradient(circle at 22% 26%, ${c1} 0%, transparent 55%),radial-gradient(circle at 80% 84%, ${c2} 0%, transparent 52%),#2b1a2e"></div>
          <div class="dim"></div>
        </div>
        ${big
          ? html`
              <div class="topbar">
                <span class="round gl app corner-tl"><ha-icon icon="mdi:music"></ha-icon></span>
                ${this.volumeButton(st, false, 'corner-tr')}
              </div>
              <div class="art big-art" style=${art ? `background-image:url('${art}')` : ''}>${art ? nothing : html`<ha-icon icon="mdi:music-note"></ha-icon>`}</div>
              <div class="titles">
                <div class="tt">
                  <div class="ttl">${title}</div>
                  <div class="artist">${artist}</div>
                </div>
                <button class="round gl more" aria-label="More" @click=${this.moreInfo}><ha-icon icon="mdi:dots-horizontal"></ha-icon></button>
              </div>
              ${pos
                ? html`<div class="progress"><div class="bar"><i style="width:${(pos.pos / pos.dur) * 100}%"></i></div><div class="times"><span>${mmss(pos.pos)}</span><span>−${mmss(pos.dur - pos.pos)}</span></div></div>`
                : nothing}
              <div class="ctls">${idle ? html`<button class="btn gl resume" @click=${this.svc('media_play')}><ha-icon icon="mdi:play"></ha-icon>Resume</button>` : this.controls(st, true)}</div>
            `
          : html`
              <div class="row">
                <div class="art" style=${art ? `background-image:url('${art}')` : ''}>${art ? nothing : html`<ha-icon icon="mdi:music-note"></ha-icon>`}</div>
                <div class="col">
                  <div class="head">
                    <div class="tt">
                      <div class="ttl">${title}</div>
                      <div class="artist">${artist}</div>
                    </div>
                    ${this.volumeButton(st, true)}
                  </div>
                  ${pos
                    ? html`<div class="progress"><div class="bar"><i style="width:${(pos.pos / pos.dur) * 100}%"></i></div><div class="times"><span>${mmss(pos.pos)}</span><span>−${mmss(pos.dur - pos.pos)}</span></div></div>`
                    : nothing}
                  <div class="ctls">${idle ? html`<button class="btn gl resume" @click=${this.svc('media_play')}><ha-icon icon="mdi:play"></ha-icon>Resume</button>` : this.controls(st, false)}</div>
                </div>
              </div>
            `}
        ${vol !== undefined
          ? html`<div class="volume" aria-live="polite">
              <div class="vtext"><ha-icon icon="mdi:volume-high"></ha-icon>${vol}%</div>
              <div class="vbar"><i style="width:${vol}%"></i></div>
            </div>`
          : nothing}
      </ha-card>
    `;
  }

  getGridOptions(): GridOptions {
    return this.config?.layout === 'artwork'
      ? { columns: 12, rows: 6, min_columns: 6, min_rows: 5 }
      : { columns: 12, rows: 3, min_columns: 6, min_rows: 3 };
  }

  getCardSize(): number {
    return this.config?.layout === 'artwork' ? 7 : 4;
  }

  static styles = [
    ...HomeViewCard.styles,
    css`
      .media {
        color: #fff;
        background: #2b1a2e;
        touch-action: pan-x;
      }
      /* Clipped here as well as by the tile: WebKit lets blurred children escape a
         rounded overflow:hidden parent that has a backdrop filter. */
      .bg {
        position: absolute;
        inset: 0;
        overflow: hidden;
        border-radius: inherit;
        clip-path: inset(0 round var(--_radius));
      }
      .wash {
        position: absolute;
        inset: -40px;
        filter: blur(34px);
        opacity: 0.9;
      }
      .dim {
        position: absolute;
        inset: 0;
        background: linear-gradient(rgba(0, 0, 0, 0.14), rgba(0, 0, 0, 0.4));
      }
      .gl {
        background: rgba(255, 255, 255, 0.14);
      }
      .art {
        position: relative;
        flex: none;
        width: 172px;
        height: 172px;
        border-radius: 16px;
        background: linear-gradient(140deg, #e2557b 0%, #7b2f86 60%, #2a1440 100%) center / cover;
        box-shadow: 0 14px 34px rgba(0, 0, 0, 0.35);
        display: grid;
        place-items: center;
        --mdc-icon-size: 56px;
      }
      .row {
        position: relative;
        height: 100%;
        box-sizing: border-box;
        padding: 18px;
        display: flex;
        gap: 18px;
      }
      .compact .art {
        width: auto;
        height: 100%;
        aspect-ratio: 1;
        max-width: 45%;
      }
      .col {
        flex: 1;
        min-width: 0;
        min-height: 0;
        display: flex;
        flex-direction: column;
        justify-content: space-between;
        gap: 6px;
      }
      .head {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 10px;
      }
      .tt {
        min-width: 0;
      }
      .compact .ttl {
        margin-top: 0;
      }
      .compact .bar {
        margin-top: 0;
      }
      .compact .ctls {
        margin-top: 0;
        justify-content: space-between;
      }
      .compact .ctl {
        width: 44px;
        height: 44px;
        --mdc-icon-size: 30px;
      }
      .compact .ctl.main {
        --mdc-icon-size: 38px;
      }
      .topbar {
        position: absolute;
        left: 20px;
        right: 20px;
        top: 18px;
        display: flex;
        justify-content: space-between;
        align-items: center;
      }
      .topbar.inline {
        position: static;
      }
      .app,
      .vol {
        width: 44px;
        height: 44px;
        --mdc-icon-size: 22px;
      }
      .app {
        width: 44px;
        height: 44px;
        cursor: default;
      }
      .app.sm,
      .vol.sm {
        width: 34px;
        height: 34px;
        --mdc-icon-size: 18px;
      }
      .ttl {
        font-weight: 700;
        letter-spacing: 0.01em;
        text-transform: uppercase;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        font-size: 22px;
        margin-top: 8px;
      }
      .artist {
        font-size: 17px;
        font-weight: 500;
        color: rgba(255, 255, 255, 0.74);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .bar {
        height: 5px;
        border-radius: 3px;
        background: rgba(255, 255, 255, 0.28);
        margin-top: 10px;
      }
      .bar i {
        display: block;
        height: 100%;
        border-radius: 3px;
        background: #fff;
      }
      .times {
        display: flex;
        justify-content: space-between;
        margin-top: 4px;
        font-size: 15px;
        font-weight: 600;
        color: rgba(255, 255, 255, 0.66);
      }
      .ctls {
        display: flex;
        align-items: center;
        justify-content: space-around;
        margin-top: auto;
      }
      .ctl {
        width: 48px;
        height: 48px;
        --mdc-icon-size: 32px;
      }
      .ctl.main {
        --mdc-icon-size: 40px;
      }
      .ctl.side {
        --mdc-icon-size: 24px;
        color: rgba(255, 255, 255, 0.6);
      }
      .ctl.side.on {
        color: #fff;
      }
      .side {
        width: 48px;
      }
      .resume {
        color: #fff;
      }
      .big .big-art {
        position: absolute;
        left: 50%;
        top: 58px;
        width: min(236px, 52%);
        height: auto;
        aspect-ratio: 1;
        transform: translateX(-50%);
        border-radius: 18px;
      }
      .big .titles {
        position: absolute;
        left: 22px;
        right: 20px;
        top: 252px;
        display: flex;
        justify-content: space-between;
        align-items: flex-end;
        gap: 12px;
        text-shadow: 0 2px 14px rgba(0, 0, 0, 0.35);
      }
      .big .tt {
        min-width: 0;
      }
      .big .ttl {
        font-size: 30px;
        margin: 0;
      }
      .big .artist {
        font-size: 19px;
      }
      .more {
        width: 40px;
        height: 40px;
        flex: none;
      }
      .big .progress {
        position: absolute;
        left: 22px;
        right: 22px;
        top: 332px;
      }
      .big .progress .bar {
        margin: 0;
      }
      .big .ctls {
        position: absolute;
        left: 14px;
        right: 14px;
        bottom: 14px;
        justify-content: space-between;
      }
      .big .ctl {
        width: 56px;
        height: 56px;
        --mdc-icon-size: 36px;
      }
      .big .ctl.main {
        width: 60px;
        height: 60px;
        --mdc-icon-size: 44px;
      }
      .volume {
        position: absolute;
        inset: 0;
        border-radius: inherit;
        clip-path: inset(0 round var(--_radius));
        display: flex;
        flex-direction: column;
        justify-content: center;
        gap: 14px;
        padding: 0 28px;
        background: rgba(10, 8, 20, 0.55);
        -webkit-backdrop-filter: blur(10px);
        backdrop-filter: blur(10px);
        z-index: 4;
      }
      .vtext {
        display: flex;
        align-items: center;
        gap: 10px;
        font-size: 52px;
        font-weight: 600;
        letter-spacing: -0.035em;
        --mdc-icon-size: 30px;
      }
      .vbar {
        height: 14px;
        border-radius: 7px;
        background: rgba(255, 255, 255, 0.24);
      }
      .vbar i {
        display: block;
        height: 100%;
        border-radius: 7px;
        background: #fff;
      }
      .badge {
        width: 48px;
        height: 48px;
      }
    `,
  ];
}

defineElement('homeview-media-card', HomeViewMediaCard);
registerCard({
  type: 'homeview-media-card',
  name: 'HomeView Media',
  description: 'Now playing with artwork, tinted background, playback controls and swipe-for-volume.',
  getEntitySuggestion: (_hass, entityId) =>
    entityId.startsWith('media_player.') ? { config: { type: 'custom:homeview-media-card', entity: entityId } } : null,
  docs: 'media',
});
