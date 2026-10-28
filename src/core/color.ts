import type { HassEntity } from './types';

export type RGB = [number, number, number];

export const hex = (rgb: RGB): string => '#' + rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

export const parseHex = (value: string): RGB | undefined => {
  const m = /^#?([0-9a-f]{6})$/i.exec(value.trim());
  if (!m) return undefined;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

/** Relative luminance, 0..1. */
export const luminance = ([r, g, b]: RGB): number => {
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};

/** Dark ink on light fills, white ink on dark ones. */
export const inkFor = (rgb: RGB): { ink: string; sub: string } =>
  luminance(rgb) > 0.4
    ? { ink: '#2b1d00', sub: 'rgba(43,29,0,.74)' }
    : { ink: '#ffffff', sub: 'rgba(255,255,255,.86)' };

/** Approximate sRGB for a colour temperature in Kelvin (Tanner Helland's fit). */
export const kelvinToRgb = (kelvin: number): RGB => {
  const t = kelvin / 100;
  const clamp = (v: number) => Math.max(0, Math.min(255, v));
  const r = t <= 66 ? 255 : clamp(329.698727446 * Math.pow(t - 60, -0.1332047592));
  const g = t <= 66 ? clamp(99.4708025861 * Math.log(t) - 161.1195681661) : clamp(288.1221695283 * Math.pow(t - 60, -0.0755148492));
  const b = t >= 66 ? 255 : t <= 19 ? 0 : clamp(138.5177312231 * Math.log(t - 10) - 305.0447927307);
  return [r, g, b];
};

export const WARM: RGB = [255, 201, 77];

/**
 * The colour a light tile fills with. Whites map onto HomeView's warm amber
 * scale rather than near-white, so the tile still reads as "on" from a distance.
 */
export const lightColor = (st?: HassEntity): RGB => {
  if (!st || st.state !== 'on') return WARM;
  const a = st.attributes;
  if (a.color_mode && ['color_temp', 'white', 'brightness', 'onoff'].includes(a.color_mode)) {
    const k = a.color_temp_kelvin as number | undefined;
    if (!k) return WARM;
    if (k < 2600) return [255, 178, 92];
    if (k < 3600) return WARM;
    if (k < 4800) return [255, 226, 166];
    return [228, 238, 255];
  }
  if (Array.isArray(a.rgb_color)) return a.rgb_color as RGB;
  if (Array.isArray(a.hs_color)) return hsToRgb(a.hs_color[0], a.hs_color[1]);
  return WARM;
};

export const hsToRgb = (h: number, s: number): RGB => {
  const sat = s / 100;
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return 255 * (1 - sat * Math.max(0, Math.min(k, 4 - k, 1)));
  };
  return [f(5), f(3), f(1)];
};

export const brightnessPct = (st?: HassEntity): number => {
  if (!st || st.state !== 'on') return 0;
  const b = st.attributes.brightness as number | undefined;
  return b == null ? 100 : Math.max(1, Math.round((b / 255) * 100));
};

const COLOR_MODES = ['hs', 'xy', 'rgb', 'rgbw', 'rgbww'];
export const supportsColor = (st?: HassEntity): boolean =>
  (st?.attributes.supported_color_modes as string[] | undefined)?.some((m) => COLOR_MODES.includes(m)) ?? false;
export const supportsTemp = (st?: HassEntity): boolean =>
  (st?.attributes.supported_color_modes as string[] | undefined)?.includes('color_temp') ?? false;
export const supportsBrightness = (st?: HassEntity): boolean =>
  (st?.attributes.supported_color_modes as string[] | undefined)?.some((m) => m !== 'onoff') ?? false;
