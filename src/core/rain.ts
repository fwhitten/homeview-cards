import { LitElement, css, html } from 'lit';
import { property } from 'lit/decorators.js';
import { prefersReducedMotion } from './events';
import { defineElement } from './register';

export type RainIntensity = 'light' | 'moderate' | 'heavy';

interface Drop {
  x: number;
  y: number;
  /** Depth, 0 far to 1 near: nearer drops are longer, faster, brighter, and land on the surface. */
  z: number;
  speed: number;
  len: number;
}

interface Bit {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  age: number;
  r: number;
  /** The surface's top edge under this splash: droplets that fall back onto it are gone. */
  floor: number;
}

interface Ring {
  x: number;
  y: number;
  age: number;
}

const DENSITY: Record<RainIntensity, number> = { light: 0.45, moderate: 1, heavy: 2.1 };
const GRAVITY = 1100;

/**
 * Rain on a canvas, in the spirit of Apple Weather: drops at many depths and
 * speeds, slanted by a wind that gusts, never repeating. Near drops that
 * reach the `surface` element (the forecast panel) land on its top edge,
 * rounded corners included, and splash: a few droplets jump up and fall
 * back, and a small flash spreads where each one hit. Far drops pass behind
 * it. `lightning` adds the odd flash across the sky.
 *
 * It runs only while it's on screen and the page is visible, and draws a
 * still frame for reduced motion.
 */
export class HomeViewRain extends LitElement {
  @property() intensity: RainIntensity = 'moderate';
  @property({ type: Boolean }) lightning = false;
  /** The element drops land on, if any. */
  @property({ attribute: false }) surface?: HTMLElement;

  private canvas?: HTMLCanvasElement;
  private ctx?: CanvasRenderingContext2D | null;
  private drops: Drop[] = [];
  private bits: Bit[] = [];
  private rings: Ring[] = [];
  private w = 0;
  private h = 0;
  private dpr = 1;
  private raf = 0;
  private last = 0;
  private t = 0;
  private frame = 0;
  private visible = true;
  /** The surface's box in canvas pixels (CSS px), refreshed every few frames. */
  private box?: { x: number; y: number; w: number; r: number };
  private flash = 0;
  private nextFlash = 6 + Math.random() * 10;
  private resizer = new ResizeObserver(() => this.resize());
  private seen = new IntersectionObserver(([e]) => {
    this.visible = e.isIntersecting;
    this.schedule();
  });

  connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener('visibilitychange', this.schedule);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    document.removeEventListener('visibilitychange', this.schedule);
    this.resizer.disconnect();
    this.seen.disconnect();
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  protected firstUpdated(): void {
    this.canvas = this.renderRoot.querySelector('canvas') ?? undefined;
    this.ctx = this.canvas?.getContext('2d');
    this.resizer.observe(this);
    this.seen.observe(this);
    this.resize();
  }

  protected updated(changed: Map<string, unknown>): void {
    if (changed.has('intensity')) this.populate();
  }

  private resize(): void {
    if (!this.canvas) return;
    const r = this.getBoundingClientRect();
    this.w = Math.max(1, r.width);
    this.h = Math.max(1, r.height);
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
    this.populate();
    this.measure();
    if (prefersReducedMotion()) this.draw();
    this.schedule();
  }

  /** How many drops: by intensity and the area to fill. */
  private populate(): void {
    if (!this.w) return;
    const count = Math.min(420, Math.round(((this.w * this.h) / 10_000) * DENSITY[this.intensity] * 9));
    while (this.drops.length < count) this.drops.push(this.spawn(true));
    this.drops.length = count;
  }

  private spawn(anywhere: boolean): Drop {
    const z = Math.random() ** 1.6;
    const heavy = this.intensity === 'heavy' ? 1.15 : this.intensity === 'light' ? 0.85 : 1;
    return {
      // Start a little off to the windward side, so the slant doesn't leave an empty strip.
      x: -40 + Math.random() * (this.w + 80),
      y: anywhere ? Math.random() * this.h : -20 - Math.random() * 120,
      z,
      speed: (520 + z * 780) * heavy * (0.85 + Math.random() * 0.3),
      len: (7 + z * 22) * heavy * (0.8 + Math.random() * 0.4),
    };
  }

  private measure(): void {
    const s = this.surface;
    if (!s || !s.isConnected) {
      this.box = undefined;
      return;
    }
    const me = this.getBoundingClientRect();
    const r = s.getBoundingClientRect();
    const radius = parseFloat(getComputedStyle(s).borderTopLeftRadius) || 0;
    this.box = r.width ? { x: r.left - me.left, y: r.top - me.top, w: r.width, r: Math.min(radius, r.width / 2) } : undefined;
  }

  /** The surface's top edge at x, following its rounded corners; undefined off its sides. */
  private edgeAt(x: number): number | undefined {
    const b = this.box;
    if (!b || x < b.x || x > b.x + b.w) return undefined;
    const fromSide = Math.min(x - b.x, b.x + b.w - x);
    if (fromSide >= b.r) return b.y;
    const d = b.r - fromSide;
    return b.y + b.r - Math.sqrt(Math.max(0, b.r * b.r - d * d));
  }

  private splash(x: number, y: number, strength: number): void {
    const n = 2 + Math.floor(Math.random() * 3 * strength);
    for (let i = 0; i < n; i++) {
      this.bits.push({
        x,
        y: y - 1,
        vx: (Math.random() - 0.5) * 220 * strength + this.wind() * 120,
        vy: -(90 + Math.random() * 170) * strength,
        life: 0.3 + Math.random() * 0.3,
        age: 0,
        r: 0.7 + Math.random() * 0.8,
        floor: y,
      });
    }
    this.rings.push({ x, y, age: 0 });
  }

  /** The slant, as horizontal pixels per vertical pixel: a steady lean with slow gusts. */
  private wind(): number {
    return 0.1 + 0.07 * Math.sin(this.t * 0.31) + 0.04 * Math.sin(this.t * 0.83 + 1.7) + 0.02 * Math.sin(this.t * 2.3);
  }

  private schedule = (): void => {
    const run = this.visible && !document.hidden && !prefersReducedMotion() && this.isConnected;
    if (run && !this.raf) {
      this.last = performance.now();
      this.raf = requestAnimationFrame(this.tick);
    } else if (!run && this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
  };

  private tick = (now: number): void => {
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    this.t += dt;
    if (this.frame++ % 30 === 0) this.measure();
    this.step(dt);
    this.draw();
    this.raf = requestAnimationFrame(this.tick);
  };

  private step(dt: number): void {
    const wind = this.wind();
    for (let i = 0; i < this.drops.length; i++) {
      const d = this.drops[i];
      const dy = d.speed * dt;
      const prevY = d.y;
      d.y += dy;
      d.x += dy * wind;
      // Near drops land on the surface's top edge and splash.
      if (d.z > 0.55) {
        const edge = this.edgeAt(d.x);
        if (edge !== undefined && prevY < edge && d.y >= edge) {
          if (Math.random() < 0.75) this.splash(d.x, edge, 0.6 + d.z * 0.5);
          this.drops[i] = this.spawn(false);
          continue;
        }
      }
      if (d.y - d.len > this.h || d.x > this.w + 60) this.drops[i] = this.spawn(false);
    }
    for (const b of this.bits) {
      b.age += dt;
      b.vy += GRAVITY * dt;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
    }
    this.bits = this.bits.filter((b) => b.age < b.life && !(b.vy > 0 && b.y > b.floor + 1));
    for (const r of this.rings) r.age += dt;
    this.rings = this.rings.filter((r) => r.age < 0.28);
    if (this.lightning) {
      this.nextFlash -= dt;
      if (this.nextFlash <= 0) {
        this.flash = 1;
        this.nextFlash = 7 + Math.random() * 14;
      }
      // A quick double flicker, then a fade.
      this.flash = Math.max(0, this.flash - dt * (this.flash > 0.6 ? 6 : 2.2));
    }
  }

  private draw(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    if (this.flash > 0) {
      const a = this.flash > 0.75 && this.flash < 0.85 ? 0.05 : this.flash * 0.22;
      ctx.fillStyle = `rgba(225,232,255,${a})`;
      ctx.fillRect(0, 0, this.w, this.h);
    }
    const wind = this.wind();
    ctx.lineCap = 'round';
    // Three depth layers, each drawn in two strokes: a faint tail and a brighter head,
    // so a streak fades towards its end as a fast drop blurs on camera. Batched by
    // layer, it's six strokes a frame however many drops there are.
    const layers = [
      { max: 0.35, alpha: 0.13, width: 0.8 },
      { max: 0.65, alpha: 0.24, width: 1.1 },
      { max: 1.01, alpha: 0.4, width: 1.5 },
    ];
    let from = 0;
    for (const layer of layers) {
      const tails = new Path2D();
      const heads = new Path2D();
      for (const d of this.drops) {
        if (d.z < from || d.z >= layer.max) continue;
        const tx = d.x - d.len * wind;
        const ty = d.y - d.len;
        const mx = d.x - d.len * 0.45 * wind;
        const my = d.y - d.len * 0.45;
        tails.moveTo(tx, ty);
        tails.lineTo(mx, my);
        heads.moveTo(mx, my);
        heads.lineTo(d.x, d.y);
      }
      ctx.lineWidth = layer.width;
      ctx.strokeStyle = `rgba(220,235,255,${layer.alpha * 0.4})`;
      ctx.stroke(tails);
      ctx.strokeStyle = `rgba(220,235,255,${layer.alpha})`;
      ctx.stroke(heads);
      from = layer.max;
    }
    // Where drops hit: a flat flash that spreads and fades along the edge.
    for (const r of this.rings) {
      const f = r.age / 0.28;
      ctx.strokeStyle = `rgba(230,240,255,${0.45 * (1 - f)})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.ellipse(r.x, r.y, 2 + f * 9, 0.6 + f * 1.6, 0, Math.PI, 2 * Math.PI);
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(230,240,255,0.7)';
    for (const b of this.bits) {
      ctx.globalAlpha = Math.max(0, 1 - b.age / b.life);
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  render() {
    return html`<canvas aria-hidden="true"></canvas>`;
  }

  static styles = css`
    :host {
      position: absolute;
      inset: 0;
      display: block;
      pointer-events: none;
    }
    canvas {
      width: 100%;
      height: 100%;
      display: block;
    }
  `;
}

defineElement('homeview-rain', HomeViewRain);
