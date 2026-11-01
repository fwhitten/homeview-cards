/** Camera helpers shared by the camera card and its pop-up. */
import type { HassEntity, HomeAssistant } from './types';
import { isUnavailable } from './format';

export interface CameraEvent {
  /** A binary_sensor or event entity that marks a detection. */
  entity: string;
  label?: string;
  icon?: string;
}

export interface Detection {
  ev: CameraEvent;
  st: HassEntity;
  /** Milliseconds since it happened. */
  ago: number;
}

let streamLoader: Promise<unknown> | undefined;

/**
 * Make sure HA's camera stream element is registered. It loads with the
 * picture-entity card, so creating one (never attached) pulls it in.
 */
export const ensureStreamElement = (): Promise<unknown> => {
  if (customElements.get('ha-camera-stream')) return Promise.resolve();
  streamLoader ??= (async () => {
    const helpers = await window.loadCardHelpers?.();
    helpers?.createCardElement({ type: 'picture-entity', entity: 'camera.homeview_loader', camera_view: 'live' });
    await Promise.race([customElements.whenDefined('ha-camera-stream'), new Promise((r) => setTimeout(r, 5000))]);
  })();
  return streamLoader;
};

/** Detections within the window, newest first. */
export const detections = (hass: HomeAssistant, events: CameraEvent[] | undefined, windowMinutes = 30): Detection[] => {
  const windowMs = windowMinutes * 60_000;
  const out: Detection[] = [];
  for (const ev of events ?? []) {
    const st = hass.states[ev.entity];
    if (!st || isUnavailable(st)) continue;
    // An event entity's state is the time it last fired; a binary sensor counts while on or recently on.
    const at = ev.entity.startsWith('event.') ? Date.parse(st.state) : Date.parse(st.last_changed);
    if (!Number.isFinite(at)) continue;
    const ago = Date.now() - at;
    if (ev.entity.startsWith('binary_sensor.') && st.state !== 'on' && ago > windowMs) continue;
    if (ago > windowMs) continue;
    out.push({ ev, st, ago });
  }
  return out.sort((a, b) => a.ago - b.ago);
};

/** The camera's current still, with a cache-buster so it refreshes. */
export const snapshotUrl = (hass: HomeAssistant, st: HassEntity, tick: number | string): string => {
  const pic = st.attributes.entity_picture as string | undefined;
  if (!pic) return '';
  return `${hass.hassUrl(pic)}${pic.includes('?') ? '&' : '?'}t=${tick}`;
};

/** "16:9", "4/3" or 1.78 as a width ÷ height ratio. */
export const parseAspect = (value: unknown, fallback = 16 / 9): number => {
  if (typeof value === 'number' && value > 0) return value;
  const m = String(value ?? '').match(/^\s*([\d.]+)\s*[:/x]\s*([\d.]+)\s*$/);
  const r = m ? Number(m[1]) / Number(m[2]) : Number(value);
  return Number.isFinite(r) && r > 0 ? r : fallback;
};
