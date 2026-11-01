import { css } from 'lit';

/**
 * HomeView design tokens.
 *
 * Every token reads a public `--hv-*` variable first, so the HomeView theme
 * (or any HA theme) can override it, and falls back to the built-in value for
 * the card's resolved mode. HA themes only know light and dark, so night mode
 * reads its own `--hv-night-*` variables.
 */
export const tokens = css`
  :host {
    --_wall: var(--hv-wall, #1a1730);
    --_glass: var(--hv-glass, rgba(255, 255, 255, 0.07));
    --_glass-hi: var(--hv-glass-strong, rgba(255, 255, 255, 0.16));
    --_rim: var(--hv-rim, rgba(255, 255, 255, 0.62));
    --_rim-2: var(--hv-rim-soft, rgba(255, 255, 255, 0.12));
    --_sheen: var(--hv-sheen, rgba(255, 255, 255, 0.14));
    --_drop: var(--hv-shadow, 0 16px 40px rgba(10, 8, 24, 0.28));
    --_blur: var(--hv-blur, blur(18px) saturate(185%) brightness(0.86));
    --_ink: var(--hv-ink, #fff);
    --_ink2: var(--hv-ink-2, rgba(255, 255, 255, 0.76));
    --_ink3: var(--hv-ink-3, rgba(255, 255, 255, 0.5));
    --_inv: var(--hv-ink-inverse, #0c0f17);
    --_track: var(--hv-track, rgba(255, 255, 255, 0.2));
    --_heat-ink: var(--hv-heat-ink, #ffb27a);
    --_energy-ink: var(--hv-energy-ink, #7be8a2);
    --_dhw-ink: var(--hv-dhw-ink, #8fd8ff);
    --_clean-ink: var(--hv-clean-ink, #7de3dc);
    --_tile-filter: none;

    --hv-c-lights: #ffc94d;
    --hv-c-heat: #ff8a3d;
    --hv-c-cool: #4fb3ff;
    --hv-c-energy: #4cd07d;
    --hv-c-rain: #5ac8fa;
    --hv-c-progress: #4c8dff;
    --hv-c-alert: #e5484d;
    --hv-c-notice: #ffb340;
    --hv-c-clean: #40c8c0;
    --hv-c-calendar: #7d6bff;

    --_radius: var(--hv-radius, 30px);
    --_font: var(
      --hv-font,
      -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'SF Pro Text', Inter, system-ui, sans-serif
    );
    --_font-rounded: var(
      --hv-font-rounded,
      'SF Pro Rounded', ui-rounded, -apple-system, BlinkMacSystemFont, Inter, system-ui, sans-serif
    );
  }
  :host([mode='light']) {
    --_wall: var(--hv-wall, #dfe8ef);
    --_glass: var(--hv-glass, rgba(255, 255, 255, 0.3));
    --_glass-hi: var(--hv-glass-strong, rgba(255, 255, 255, 0.55));
    --_rim: var(--hv-rim, #fff);
    --_rim-2: var(--hv-rim-soft, rgba(255, 255, 255, 0.45));
    --_sheen: var(--hv-sheen, rgba(255, 255, 255, 0.5));
    --_drop: var(--hv-shadow, 0 16px 40px rgba(40, 60, 90, 0.16));
    --_blur: var(--hv-blur, blur(18px) saturate(185%) brightness(1.06));
    --_ink: var(--hv-ink, #0f1115);
    --_ink2: var(--hv-ink-2, rgba(15, 17, 21, 0.7));
    --_ink3: var(--hv-ink-3, rgba(15, 17, 21, 0.48));
    --_inv: var(--hv-ink-inverse, #fff);
    --_track: var(--hv-track, rgba(15, 17, 21, 0.14));
    --_heat-ink: var(--hv-heat-ink, #a8460a);
    --_energy-ink: var(--hv-energy-ink, #18723a);
    --_dhw-ink: var(--hv-dhw-ink, #0b6a9c);
    --_clean-ink: var(--hv-clean-ink, #0e7069);
  }
  :host([mode='night']) {
    --_wall: var(--hv-night-wall, #030304);
    --_glass: var(--hv-night-glass, rgba(255, 255, 255, 0.035));
    --_glass-hi: var(--hv-night-glass-strong, rgba(255, 255, 255, 0.07));
    --_rim: var(--hv-night-rim, rgba(255, 255, 255, 0.16));
    --_rim-2: var(--hv-night-rim-soft, rgba(255, 255, 255, 0.04));
    --_sheen: var(--hv-night-sheen, rgba(255, 255, 255, 0.03));
    --_drop: none;
    --_blur: var(--hv-night-blur, blur(18px) saturate(120%) brightness(0.7));
    --_ink: var(--hv-night-ink, #d8c3ab);
    --_ink2: var(--hv-night-ink-2, rgba(216, 195, 171, 0.68));
    --_ink3: var(--hv-night-ink-3, rgba(216, 195, 171, 0.42));
    --_inv: #030304;
    --_track: var(--hv-night-track, rgba(216, 195, 171, 0.14));
    --_heat-ink: #d99a6c;
    --_energy-ink: #8fbf98;
    --_dhw-ink: #8fb5c8;
    --_clean-ink: #8fbfbb;
    --_tile-filter: brightness(0.62) saturate(0.7);
  }
`;

/** The glass tile, type scale and the small shared primitives. */
export const base = css`
  :host {
    display: block;
    height: 100%;
    font-family: var(--_font);
    -webkit-font-smoothing: antialiased;
    font-variant-numeric: tabular-nums;
    color: var(--_ink);
  }
  ha-card.tile {
    display: block;
    position: relative;
    overflow: hidden;
    box-sizing: border-box;
    height: 100%;
    min-height: var(--hv-tile-min-height, var(--_auto-min, 0px));
    border: none;
    border-radius: var(--_radius);
    background: radial-gradient(130% 80% at 0% 0%, var(--_sheen), rgba(255, 255, 255, 0) 52%), var(--_glass);
    -webkit-backdrop-filter: var(--_blur);
    backdrop-filter: var(--_blur);
    box-shadow: var(--_drop);
    color: var(--_ink);
    filter: var(--_tile-filter);
    isolation: isolate;
    -webkit-tap-highlight-color: transparent;
    user-select: none;
    -webkit-user-select: none;
  }
  ha-card.tile.clickable {
    cursor: pointer;
  }
  ha-card.tile:focus-visible {
    outline: 3px solid var(--_ink);
    outline-offset: 3px;
  }
  /* Specular rim: brightest top-left and bottom-right. */
  .tile::after,
  .gl::after,
  .chip::after {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: inherit;
    padding: 1.5px;
    background: linear-gradient(
      135deg,
      var(--_rim),
      var(--_rim-2) 24%,
      rgba(255, 255, 255, 0) 46%,
      rgba(255, 255, 255, 0) 64%,
      var(--_rim-2) 84%,
      var(--_rim)
    );
    -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
    -webkit-mask-composite: xor;
    mask-composite: exclude;
    pointer-events: none;
    z-index: 5;
  }
  .gl {
    position: relative;
    background: var(--_glass-hi);
    -webkit-backdrop-filter: blur(12px) saturate(180%);
    backdrop-filter: blur(12px) saturate(180%);
  }
  .in {
    position: relative;
    height: 100%;
    box-sizing: border-box;
    padding: 18px 20px;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    gap: 8px;
  }
  .name {
    font-size: 21px;
    font-weight: 600;
    letter-spacing: -0.01em;
    line-height: 1.15;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .sub {
    font-size: 17px;
    font-weight: 500;
    color: var(--_ink2);
    line-height: 1.25;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .cap {
    font-size: 15px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--_ink2);
  }
  .hero {
    font-size: 64px;
    font-weight: 600;
    letter-spacing: -0.035em;
    line-height: 0.95;
  }
  .value {
    font-size: 46px;
    font-weight: 600;
    letter-spacing: -0.03em;
    line-height: 1;
  }
  .unit {
    font-size: 20px;
    font-weight: 600;
    color: var(--_ink2);
  }
  /*
   * Concentric corners: a round control in a tile's corner sits with its
   * centre on the centre of the corner's curve, so the gap to the rounded
   * edge is even all the way round. --_cd is the circle's diameter;
   * containers say their padding with --_pt / --_pl / --_pr.
   */
  .corner-tl,
  .corner-tr {
    margin-top: calc(var(--_radius) - var(--_cd, 44px) / 2 - var(--_pt, 18px));
  }
  .corner-tl {
    margin-left: calc(var(--_radius) - var(--_cd, 44px) / 2 - var(--_pl, 20px));
  }
  .corner-tr {
    margin-right: calc(var(--_radius) - var(--_cd, 44px) / 2 - var(--_pr, 20px));
  }
  .round {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
    border-radius: 999px;
    border: 0;
    padding: 0;
    font: inherit;
    color: inherit;
    cursor: pointer;
    background: none;
    --mdc-icon-size: 24px;
  }
  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    height: 48px;
    padding: 0 18px;
    border-radius: 999px;
    border: 0;
    font: inherit;
    font-size: 17px;
    font-weight: 600;
    color: var(--_ink);
    cursor: pointer;
    --mdc-icon-size: 20px;
  }
  button:focus-visible,
  a:focus-visible {
    outline: 3px solid var(--_ink);
    outline-offset: 2px;
  }
  .ov {
    position: absolute;
    inset: 0;
    pointer-events: none;
  }
  .warn {
    padding: 16px;
    font-size: 15px;
    color: var(--_ink2);
  }
  @media (prefers-reduced-motion: reduce) {
    .anim,
    .anim * {
      animation: none !important;
      transition: none !important;
    }
  }
`;

export const cardStyles = [tokens, base];
