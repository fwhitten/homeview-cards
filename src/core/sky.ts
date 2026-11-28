import { LitElement, css, html } from 'lit';
import { property } from 'lit/decorators.js';
import { prefersReducedMotion } from './events';
import { defineElement } from './register';

/**
 * The weather card's living sky, drawn on one canvas, in the spirit of Apple
 * Weather: sun rays and drifting light, twinkling stars and the odd shooting
 * star, layered clouds that drift at their own depths, rain and hail and snow
 * that land on the forecast panel (`surface`), fog banks, wind gusts and
 * lightning. Each Home Assistant condition picks its own mix.
 *
 * It runs only while on screen and the page is visible, and draws one still
 * frame for reduced motion.
 */

type RGB = [number, number, number];

/** What every effect can see: the canvas size, time, the wind, and the surface to land on. */
interface World {
  w: number;
  h: number;
  t: number;
  night: boolean;
  /** Horizontal pixels per vertical pixel of fall: a lean with slow gusts. */
  wind: number;
  edgeAt(x: number): number | undefined;
}

interface Effect {
  /** Fill or refill for the current size. */
  size(world: World): void;
  step(dt: number, world: World): void;
  draw(ctx: CanvasRenderingContext2D, world: World): void;
}

const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const rgba = (c: RGB, a: number) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

/**
 * Where the sun or moon sits: top right, in the spot the condition icon would
 * take (the card hides the icon when the sky shows one), and how big.
 */
const bodyAt = (w: World): { x: number; y: number; r: number } => {
  const small = w.w < 300;
  const inset = small ? 38 : 56;
  return { x: w.w - inset, y: inset, r: small ? 17 : 26 };
};

// ---------------------------------------------------------------- sun

class Sun implements Effect {
  private motes: Array<{ x: number; y: number; r: number; a: number; vx: number; vy: number }> = [];

  size(w: World): void {
    this.motes = Array.from({ length: 14 }, () => ({ x: rnd(0, w.w), y: rnd(0, w.h), r: rnd(3, 12), a: rnd(0.03, 0.09), vx: rnd(-6, 6), vy: rnd(-10, -3) }));
  }

  step(dt: number, w: World): void {
    for (const m of this.motes) {
      m.x += m.vx * dt;
      m.y += m.vy * dt;
      if (m.y < -20) {
        m.y = w.h + 20;
        m.x = rnd(0, w.w);
      }
    }
  }

  draw(ctx: CanvasRenderingContext2D, w: World): void {
    const { x: cx, y: cy, r: R } = bodyAt(w);
    const reach = Math.hypot(w.w, w.h);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    // The glow.
    const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, reach * 0.55);
    glow.addColorStop(0, 'rgba(255,240,190,0.55)');
    glow.addColorStop(0.18, 'rgba(255,230,170,0.22)');
    glow.addColorStop(1, 'rgba(255,230,170,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, w.w, w.h);
    // Rays that turn slowly and breathe.
    const n = 11;
    for (let i = 0; i < n; i++) {
      const a = w.t * 0.025 + (i / n) * Math.PI * 2 + Math.sin(i * 7.1) * 0.2;
      const spread = 0.05 + 0.02 * Math.sin(i * 3.3);
      const alpha = 0.05 + 0.035 * Math.sin(w.t * 0.6 + i * 1.9);
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, reach * 0.8);
      g.addColorStop(0, `rgba(255,245,215,${alpha})`);
      g.addColorStop(1, 'rgba(255,245,215,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(a - spread) * reach, cy + Math.sin(a - spread) * reach);
      ctx.lineTo(cx + Math.cos(a + spread) * reach, cy + Math.sin(a + spread) * reach);
      ctx.closePath();
      ctx.fill();
    }
    // The sun itself: a soft bright disc.
    const disc = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 1.3);
    disc.addColorStop(0, 'rgba(255,253,240,0.98)');
    disc.addColorStop(0.6, 'rgba(255,248,220,0.9)');
    disc.addColorStop(0.78, 'rgba(255,240,200,0.35)');
    disc.addColorStop(1, 'rgba(255,240,200,0)');
    ctx.fillStyle = disc;
    ctx.beginPath();
    ctx.arc(cx, cy, R * 1.3, 0, Math.PI * 2);
    ctx.fill();
    // Light drifting in the air.
    for (const m of this.motes) {
      ctx.fillStyle = `rgba(255,250,230,${m.a})`;
      ctx.beginPath();
      ctx.arc(m.x, m.y, m.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}

// ---------------------------------------------------------------- moon

/** The moon's age as a fraction of its cycle: 0 new, 0.25 first quarter, 0.5 full, 0.75 last quarter. */
export const moonPhase = (date = new Date()): number => {
  const synodic = 29.530588853;
  // A known new moon: 6 January 2000, 18:14 UTC.
  const days = (date.getTime() - Date.UTC(2000, 0, 6, 18, 14)) / 86_400_000;
  return (((days / synodic) % 1) + 1) % 1;
};

/**
 * The moon in its real phase, lit from the right while it waxes and from the
 * left while it wanes (the other way round south of the equator), with a
 * faint earthshine on the dark part, a few maria, and a soft glow.
 */
class Moon implements Effect {
  constructor(private readonly south = false) {}

  size(): void {}
  step(): void {}

  draw(ctx: CanvasRenderingContext2D, w: World): void {
    const { x, y, r } = bodyAt(w);
    const p = moonPhase();
    const lit = (1 - Math.cos(2 * Math.PI * p)) / 2;
    ctx.save();
    // A glow as bright as the moon is full, reaching well out and fading gently (roughly
    // as light falls off), so it has no visible edge.
    const a = 0.1 + lit * 0.24;
    const reach = r * 10;
    const glow = ctx.createRadialGradient(x, y, r * 0.9, x, y, reach);
    glow.addColorStop(0, `rgba(220,228,255,${a})`);
    glow.addColorStop(0.08, `rgba(220,228,255,${a * 0.62})`);
    glow.addColorStop(0.2, `rgba(220,228,255,${a * 0.32})`);
    glow.addColorStop(0.4, `rgba(220,228,255,${a * 0.13})`);
    glow.addColorStop(0.65, `rgba(220,228,255,${a * 0.04})`);
    glow.addColorStop(1, 'rgba(220,228,255,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(x - reach, y - reach, reach * 2, reach * 2);
    // The whole disc, just visible by earthshine.
    ctx.fillStyle = 'rgba(200,210,235,0.1)';
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    // The lit part: between the limb and the terminator, an ellipse whose width follows the phase.
    const k = Math.cos(2 * Math.PI * p);
    const waxing = p < 0.5;
    const side = (waxing ? 1 : -1) * (this.south ? -1 : 1);
    const shape = new Path2D();
    const n = 40;
    for (let i = 0; i <= n; i++) {
      const yy = -r + (2 * r * i) / n;
      const half = Math.sqrt(Math.max(0, r * r - yy * yy));
      const px = x + side * half;
      if (i === 0) shape.moveTo(px, y + yy);
      else shape.lineTo(px, y + yy);
    }
    for (let i = n; i >= 0; i--) {
      const yy = -r + (2 * r * i) / n;
      const half = Math.sqrt(Math.max(0, r * r - yy * yy));
      shape.lineTo(x + side * k * half, y + yy);
    }
    shape.closePath();
    const face = ctx.createRadialGradient(x - r * 0.3, y - r * 0.3, r * 0.2, x, y, r);
    face.addColorStop(0, 'rgba(252,252,245,0.98)');
    face.addColorStop(1, 'rgba(225,228,235,0.95)');
    ctx.fillStyle = face;
    ctx.fill(shape);
    // The grey seas, soft-edged and roughly where the real maria are (as seen from the north), only where it's lit.
    ctx.clip(shape);
    const flip = this.south ? -1 : 1;
    for (const [dx, dy, rr, a] of [
      [-0.32, -0.3, 0.3, 0.2],
      [0.18, -0.32, 0.2, 0.18],
      [0.34, 0.0, 0.22, 0.18],
      [-0.45, 0.18, 0.32, 0.14],
      [0.08, 0.22, 0.16, 0.12],
    ]) {
      const mx = x + dx * r * flip;
      const my = y + dy * r * flip;
      const sea = ctx.createRadialGradient(mx, my, 0, mx, my, rr * r);
      sea.addColorStop(0, `rgba(140,148,168,${a})`);
      sea.addColorStop(1, 'rgba(140,148,168,0)');
      ctx.fillStyle = sea;
      ctx.fillRect(mx - rr * r, my - rr * r, rr * r * 2, rr * r * 2);
    }
    ctx.restore();
  }
}

// ---------------------------------------------------------------- stars

class Stars implements Effect {
  private stars: Array<{ x: number; y: number; r: number; a: number; f: number; p: number }> = [];
  private shooting?: { x: number; y: number; vx: number; vy: number; age: number };
  private next = rnd(4, 10);

  constructor(private readonly dim = 1) {}

  size(w: World): void {
    const count = Math.min(260, Math.round((w.w * w.h) / 900));
    this.stars = Array.from({ length: count }, () => ({
      x: rnd(0, w.w),
      // Fewer towards the horizon.
      y: w.h * 0.8 * Math.random() ** 1.4,
      r: 0.35 + Math.random() ** 3 * 1.3,
      a: rnd(0.3, 0.95) * this.dim,
      f: rnd(0.4, 2.4),
      p: rnd(0, Math.PI * 2),
    }));
  }

  step(dt: number, w: World): void {
    this.next -= dt;
    if (this.next <= 0 && !this.shooting) {
      const left = Math.random() < 0.5;
      const speed = rnd(700, 1000);
      const ang = rnd(0.35, 0.6);
      this.shooting = { x: rnd(w.w * 0.15, w.w * 0.85), y: rnd(0, w.h * 0.3), vx: (left ? -1 : 1) * Math.cos(ang) * speed, vy: Math.sin(ang) * speed, age: 0 };
      this.next = rnd(7, 18);
    }
    if (this.shooting) {
      const s = this.shooting;
      s.age += dt;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      if (s.age > 0.7) this.shooting = undefined;
    }
  }

  draw(ctx: CanvasRenderingContext2D, w: World): void {
    for (const s of this.stars) {
      const a = s.a * (0.65 + 0.35 * Math.sin(w.t * s.f + s.p));
      ctx.fillStyle = `rgba(255,255,255,${a})`;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fill();
      // The brightest catch a glint.
      if (s.r > 1.2) {
        ctx.strokeStyle = `rgba(255,255,255,${a * 0.35})`;
        ctx.lineWidth = 0.6;
        ctx.beginPath();
        ctx.moveTo(s.x - s.r * 3, s.y);
        ctx.lineTo(s.x + s.r * 3, s.y);
        ctx.moveTo(s.x, s.y - s.r * 3);
        ctx.lineTo(s.x, s.y + s.r * 3);
        ctx.stroke();
      }
    }
    const s = this.shooting;
    if (s) {
      const fade = s.age < 0.15 ? s.age / 0.15 : 1 - (s.age - 0.15) / 0.55;
      const tail = 0.14;
      const g = ctx.createLinearGradient(s.x - s.vx * tail, s.y - s.vy * tail, s.x, s.y);
      g.addColorStop(0, 'rgba(255,255,255,0)');
      g.addColorStop(1, `rgba(255,255,255,${0.85 * Math.max(0, fade)})`);
      ctx.strokeStyle = g;
      ctx.lineWidth = 1.4;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(s.x - s.vx * tail, s.y - s.vy * tail);
      ctx.lineTo(s.x, s.y);
      ctx.stroke();
    }
  }
}

// ---------------------------------------------------------------- clouds

/**
 * One cloud, drawn once into its own canvas: a row of soft puffs, fuller in
 * the middle. It's drawn at a quarter of its size and scaled up when used,
 * which blurs the puffs into one another (and works in every browser).
 */
const CLOUD_SCALE = 0.25;
const cloudSprite = (fullWidth: number, fullHeight: number, tone: RGB, alpha: number): HTMLCanvasElement => {
  const width = fullWidth * CLOUD_SCALE;
  const height = fullHeight * CLOUD_SCALE;
  const c = document.createElement('canvas');
  c.width = Math.ceil(width);
  c.height = Math.ceil(height);
  const x = c.getContext('2d')!;
  const n = 9 + Math.floor(Math.random() * 5);
  for (let i = 0; i < n; i++) {
    const f = i / (n - 1);
    const lift = Math.sin(Math.PI * f) * rnd(0.1, 0.3);
    const r = height * (0.22 + 0.24 * Math.sin(Math.PI * f)) * rnd(0.8, 1.15);
    const cx = width * (0.14 + 0.72 * f) + rnd(-0.03, 0.03) * width;
    const cy = height * (0.66 - lift);
    const g = x.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, rgba(tone, alpha));
    g.addColorStop(0.55, rgba(tone, alpha * 0.55));
    g.addColorStop(1, rgba(tone, 0));
    x.fillStyle = g;
    x.beginPath();
    x.arc(cx, cy, r, 0, Math.PI * 2);
    x.fill();
  }
  return c;
};

interface CloudStyle {
  count: number;
  tone: RGB;
  alpha: number;
  /** Pixels a second for the nearest clouds. */
  speed: number;
  /** How far down the card clouds reach, 0–1. */
  band: number;
}

class Clouds implements Effect {
  private clouds: Array<{ img: HTMLCanvasElement; x: number; y: number; z: number; w: number; h: number }> = [];
  constructor(private readonly style: CloudStyle) {}

  private make(w: World, z: number, anywhere: boolean) {
    const s = this.style;
    const width = rnd(0.45, 0.85) * Math.max(240, w.w) * (0.6 + z * 0.6);
    const height = width * rnd(0.32, 0.42);
    const tone: RGB = w.night ? [s.tone[0] * 0.55, s.tone[1] * 0.58, s.tone[2] * 0.66].map(Math.round) as RGB : s.tone;
    return {
      img: cloudSprite(width, height, tone, s.alpha * (0.55 + z * 0.45)),
      x: anywhere ? rnd(-width, w.w) : -width - rnd(0, 60),
      y: rnd(-height * 0.45, w.h * s.band - height * 0.5),
      z,
      w: width,
      h: height,
    };
  }

  size(w: World): void {
    this.clouds = Array.from({ length: this.style.count }, (_, i) => this.make(w, (i + 0.5) / this.style.count, true)).sort((a, b) => a.z - b.z);
  }

  step(dt: number, w: World): void {
    for (let i = 0; i < this.clouds.length; i++) {
      const c = this.clouds[i];
      c.x += this.style.speed * (0.3 + c.z * 0.7) * dt;
      if (c.x > w.w + 20) this.clouds[i] = this.make(w, c.z, false);
    }
  }

  draw(ctx: CanvasRenderingContext2D): void {
    ctx.imageSmoothingQuality = 'high';
    for (const c of this.clouds) ctx.drawImage(c.img, c.x, c.y, c.w, c.h);
  }
}

// ---------------------------------------------------------------- fog

class Fog implements Effect {
  private banks: Array<{ img: HTMLCanvasElement; x: number; y: number; v: number }> = [];

  size(w: World): void {
    const bank = () => {
      const width = w.w * rnd(1, 1.6);
      const height = rnd(70, 140);
      const c = document.createElement('canvas');
      c.width = Math.ceil(width);
      c.height = Math.ceil(height);
      const x = c.getContext('2d')!;
      x.translate(width / 2, height / 2);
      x.scale(width / height, 1);
      const g = x.createRadialGradient(0, 0, 0, 0, 0, height / 2);
      const a = w.night ? 0.14 : 0.2;
      g.addColorStop(0, `rgba(235,240,248,${a})`);
      g.addColorStop(1, 'rgba(235,240,248,0)');
      x.fillStyle = g;
      x.beginPath();
      x.arc(0, 0, height / 2, 0, Math.PI * 2);
      x.fill();
      return c;
    };
    this.banks = Array.from({ length: 6 }, (_, i) => {
      const img = bank();
      return { img, x: rnd(-img.width, w.w), y: w.h * (0.15 + (i / 6) * 0.85) - img.height / 2, v: rnd(6, 18) * (i % 2 ? -1 : 1) };
    });
  }

  step(dt: number, w: World): void {
    for (const b of this.banks) {
      b.x += b.v * dt;
      if (b.v > 0 && b.x > w.w) b.x = -b.img.width;
      if (b.v < 0 && b.x < -b.img.width) b.x = w.w;
    }
  }

  draw(ctx: CanvasRenderingContext2D, w: World): void {
    // A haze that thickens towards the ground, then the banks drifting through it.
    const haze = ctx.createLinearGradient(0, 0, 0, w.h);
    haze.addColorStop(0, 'rgba(230,236,244,0.04)');
    haze.addColorStop(1, `rgba(230,236,244,${w.night ? 0.12 : 0.2})`);
    ctx.fillStyle = haze;
    ctx.fillRect(0, 0, w.w, w.h);
    for (const b of this.banks) ctx.drawImage(b.img, b.x, b.y);
  }
}

// ---------------------------------------------------------------- rain

interface Drop {
  x: number;
  y: number;
  /** Depth, 0 far to 1 near: nearer drops are longer, faster, brighter, and land on the surface. */
  z: number;
  speed: number;
  len: number;
}

const RAIN_DENSITY = { light: 0.45, moderate: 1, heavy: 2.1 };

class Rain implements Effect {
  private drops: Drop[] = [];
  private bits: Array<{ x: number; y: number; vx: number; vy: number; life: number; age: number; r: number; floor: number }> = [];
  private rings: Array<{ x: number; y: number; age: number }> = [];
  constructor(private readonly intensity: keyof typeof RAIN_DENSITY) {}

  private spawn(w: World, anywhere: boolean): Drop {
    const z = Math.random() ** 1.6;
    const heavy = this.intensity === 'heavy' ? 1.15 : this.intensity === 'light' ? 0.85 : 1;
    return {
      x: -40 + Math.random() * (w.w + 80),
      y: anywhere ? Math.random() * w.h : -20 - Math.random() * 120,
      z,
      speed: (520 + z * 780) * heavy * rnd(0.85, 1.15),
      len: (7 + z * 22) * heavy * rnd(0.8, 1.2),
    };
  }

  size(w: World): void {
    const count = Math.min(420, Math.round(((w.w * w.h) / 10_000) * RAIN_DENSITY[this.intensity] * 9));
    while (this.drops.length < count) this.drops.push(this.spawn(w, true));
    this.drops.length = count;
  }

  step(dt: number, w: World): void {
    for (let i = 0; i < this.drops.length; i++) {
      const d = this.drops[i];
      const dy = d.speed * dt;
      const prevY = d.y;
      d.y += dy;
      d.x += dy * w.wind;
      if (d.z > 0.55) {
        const edge = w.edgeAt(d.x);
        if (edge !== undefined && prevY < edge && d.y >= edge) {
          if (Math.random() < 0.75) this.splash(d.x, edge, 0.6 + d.z * 0.5, w);
          this.drops[i] = this.spawn(w, false);
          continue;
        }
      }
      if (d.y - d.len > w.h || d.x > w.w + 60 || d.x < -80) this.drops[i] = this.spawn(w, false);
    }
    for (const b of this.bits) {
      b.age += dt;
      b.vy += 1100 * dt;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
    }
    this.bits = this.bits.filter((b) => b.age < b.life && !(b.vy > 0 && b.y > b.floor + 1));
    for (const r of this.rings) r.age += dt;
    this.rings = this.rings.filter((r) => r.age < 0.28);
  }

  private splash(x: number, y: number, strength: number, w: World): void {
    const n = 2 + Math.floor(Math.random() * 3 * strength);
    for (let i = 0; i < n; i++) {
      this.bits.push({ x, y: y - 1, vx: (Math.random() - 0.5) * 220 * strength + w.wind * 120, vy: -rnd(90, 260) * strength, life: rnd(0.3, 0.6), age: 0, r: rnd(0.7, 1.5), floor: y });
    }
    this.rings.push({ x, y, age: 0 });
  }

  draw(ctx: CanvasRenderingContext2D, w: World): void {
    ctx.lineCap = 'round';
    // Three depths, each in two batched strokes (faint tail, brighter head): six strokes a frame.
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
        const mx = d.x - d.len * 0.45 * w.wind;
        const my = d.y - d.len * 0.45;
        tails.moveTo(d.x - d.len * w.wind, d.y - d.len);
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
}

// ---------------------------------------------------------------- hail

class Hail implements Effect {
  private stones: Array<{ x: number; y: number; vx: number; vy: number; r: number; z: number; bounces: number; spin: number }> = [];

  private spawn(w: World, anywhere: boolean) {
    const z = Math.random() ** 1.3;
    return { x: rnd(-30, w.w + 30), y: anywhere ? rnd(0, w.h) : rnd(-80, -10), vx: 0, vy: (600 + z * 500) * rnd(0.85, 1.15), r: 1.2 + z * 2.2, z, bounces: 0, spin: rnd(0, 6) };
  }

  size(w: World): void {
    const count = Math.min(160, Math.round(((w.w * w.h) / 10_000) * 3.2));
    this.stones = Array.from({ length: count }, () => this.spawn(w, true));
  }

  step(dt: number, w: World): void {
    for (let i = 0; i < this.stones.length; i++) {
      const s = this.stones[i];
      const prevY = s.y;
      if (s.bounces) s.vy += 1400 * dt;
      s.x += (s.vx + s.vy * w.wind * (s.bounces ? 0 : 1)) * dt;
      s.y += s.vy * dt;
      s.spin += dt * 8;
      const edge = s.z > 0.4 ? w.edgeAt(s.x) : undefined;
      // Hail bounces off the panel, lower each time, then rolls away.
      if (edge !== undefined && s.vy > 0 && prevY < edge && s.y >= edge) {
        if (s.bounces >= 2) {
          this.stones[i] = this.spawn(w, false);
          continue;
        }
        s.y = edge;
        s.vy = -s.vy * rnd(0.22, 0.36);
        s.vx = rnd(-90, 90);
        s.bounces++;
      }
      if (s.y > w.h + 10 || s.x < -40 || s.x > w.w + 40) this.stones[i] = this.spawn(w, false);
    }
  }

  draw(ctx: CanvasRenderingContext2D): void {
    for (const s of this.stones) {
      ctx.fillStyle = `rgba(238,244,255,${0.45 + s.z * 0.45})`;
      ctx.beginPath();
      // A little out of round, turning as it falls.
      ctx.ellipse(s.x, s.y, s.r, s.r * 0.82, s.spin, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

// ---------------------------------------------------------------- snow

class Snow implements Effect {
  private flakes: Array<{ x: number; y: number; z: number; r: number; v: number; sway: number; f: number; p: number }> = [];
  /** Snow lying on the panel's top edge: a depth for every few pixels along it, melting slowly. */
  private drift: number[] = [];
  private static readonly BIN = 3;
  private static readonly MAX = 6;
  constructor(private readonly amount: number) {}

  private spawn(w: World, anywhere: boolean) {
    const z = Math.random() ** 1.5;
    return { x: rnd(-20, w.w + 20), y: anywhere ? rnd(0, w.h) : rnd(-40, -5), z, r: 0.8 + z * 2.6, v: 22 + z * 62, sway: rnd(6, 22), f: rnd(0.4, 1.1), p: rnd(0, Math.PI * 2) };
  }

  size(w: World): void {
    // It's been snowing a while: start with a thin, uneven layer already lying.
    this.drift = Array.from({ length: Math.ceil(w.w / Snow.BIN) + 1 }, (_, j) => 1.6 * this.amount + Math.sin(j * 0.21) * 0.6 + Math.sin(j * 0.07 + 2) * 0.5);
    const count = Math.min(260, Math.round(((w.w * w.h) / 10_000) * 6 * this.amount));
    this.flakes = Array.from({ length: count }, () => this.spawn(w, true));
  }

  step(dt: number, w: World): void {
    for (let i = 0; i < this.flakes.length; i++) {
      const s = this.flakes[i];
      const prevY = s.y;
      s.y += s.v * dt;
      s.x += (Math.cos(w.t * s.f + s.p) * s.sway * s.f + s.v * w.wind * 2.5) * dt;
      const edge = s.z > 0.5 ? this.flatEdge(s.x, w) : undefined;
      if (edge !== undefined && prevY < edge && s.y >= edge) {
        // A flake adds to the drift where it lands, a little to either side too.
        const bin = Math.floor(s.x / Snow.BIN);
        const add = s.r * 0.35;
        for (let k = -2; k <= 2; k++) {
          const j = bin + k;
          if (j >= 0) this.drift[j] = Math.min(Snow.MAX, (this.drift[j] ?? 0) + add * (1 - Math.abs(k) * 0.3));
        }
        this.flakes[i] = this.spawn(w, false);
        continue;
      }
      if (s.y > w.h + 10 || s.x < -40 || s.x > w.w + 40) this.flakes[i] = this.spawn(w, false);
    }
    // It melts a little all the time, so it stays a thin layer rather than piling up.
    for (let j = 0; j < this.drift.length; j++) if (this.drift[j]) this.drift[j] = Math.max(0, this.drift[j] - dt * 0.05);
  }

  draw(ctx: CanvasRenderingContext2D, w: World): void {
    for (const s of this.flakes) {
      ctx.fillStyle = `rgba(255,255,255,${0.35 + s.z * 0.55})`;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fill();
    }
    // The drift: soft shapes along the panel's edge, as deep as the snow at each point.
    // Each run goes out along the snow's surface and back along the panel's own edge,
    // so nothing is ever drawn inside the panel.
    const bins = Math.ceil(w.w / Snow.BIN);
    const path = new Path2D();
    let run: Array<[number, number, number]> = [];
    const close = () => {
      if (run.length > 1) {
        path.moveTo(run[0][0], run[0][1]);
        for (const [x, edge, depth] of run) path.lineTo(x, edge - depth);
        for (let k = run.length - 1; k >= 0; k--) path.lineTo(run[k][0], run[k][1]);
        path.closePath();
      }
      run = [];
    };
    for (let j = 0; j <= bins; j++) {
      const x = j * Snow.BIN;
      const edge = this.flatEdge(x, w);
      const depth = this.drift[j] ?? 0;
      if (edge === undefined || depth < 0.25) close();
      else run.push([x, edge, depth]);
    }
    close();
    ctx.fillStyle = 'rgba(250,252,255,0.85)';
    ctx.fill(path);
  }

  /** The panel's edge where snow can lie: not where its rounded corners turn steep. */
  private flatEdge(x: number, w: World): number | undefined {
    const here = w.edgeAt(x);
    const a = w.edgeAt(x - Snow.BIN);
    const b = w.edgeAt(x + Snow.BIN);
    if (here === undefined || a === undefined || b === undefined) return undefined;
    return Math.abs(b - a) > Snow.BIN * 1.4 ? undefined : here;
  }
}

// ---------------------------------------------------------------- wind

class Wind implements Effect {
  private gusts: Array<{ x: number; y: number; v: number; len: number; amp: number; p: number; a: number }> = [];
  private budget = 0;

  size(): void {
    this.gusts = [];
  }

  step(dt: number, w: World): void {
    // Gusts come and go in waves.
    const strength = Math.max(0, Math.sin(w.t * 0.45) + 0.6 * Math.sin(w.t * 1.27 + 1) + 0.35);
    this.budget += strength * dt * 7;
    while (this.budget > 1) {
      this.budget -= 1;
      this.gusts.push({ x: rnd(-260, -60), y: rnd(w.h * 0.05, w.h * 0.95), v: rnd(380, 700), len: rnd(70, 190), amp: rnd(2, 7), p: rnd(0, 6), a: rnd(0.12, 0.26) });
    }
    for (const g of this.gusts) g.x += g.v * dt;
    this.gusts = this.gusts.filter((g) => g.x - g.len < w.w + 20);
  }

  draw(ctx: CanvasRenderingContext2D, w: World): void {
    ctx.lineCap = 'round';
    ctx.lineWidth = 1.2;
    for (const g of this.gusts) {
      const grad = ctx.createLinearGradient(g.x - g.len, 0, g.x, 0);
      grad.addColorStop(0, 'rgba(255,255,255,0)');
      grad.addColorStop(0.6, `rgba(255,255,255,${g.a})`);
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.strokeStyle = grad;
      ctx.beginPath();
      for (let k = 0; k <= 8; k++) {
        const x = g.x - g.len + (g.len * k) / 8;
        const y = g.y + Math.sin(x * 0.03 + g.p + w.t * 2) * g.amp;
        if (k === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  }
}

// ---------------------------------------------------------------- lightning

class Lightning implements Effect {
  private flash = 0;
  private next = rnd(2, 6);
  private bolt?: { paths: Array<Array<[number, number]>>; age: number };

  size(): void {}

  private strike(w: World): void {
    const forks: Array<Array<[number, number]>> = [];
    const branch = (x: number, y: number, len: number, depth: number) => {
      const pts: Array<[number, number]> = [[x, y]];
      let cx = x;
      let cy = y;
      while (cy < y + len) {
        cx += rnd(-16, 16);
        cy += rnd(10, 24);
        pts.push([cx, cy]);
        if (depth < 1 && Math.random() < 0.12) branch(cx, cy, len * rnd(0.25, 0.45), depth + 1);
      }
      forks.push(pts);
    };
    branch(rnd(w.w * 0.15, w.w * 0.85), -10, w.h * rnd(0.45, 0.75), 0);
    this.bolt = { paths: forks, age: 0 };
    this.flash = 1;
  }

  step(dt: number, w: World): void {
    this.next -= dt;
    if (this.next <= 0) {
      this.strike(w);
      this.next = rnd(5, 14);
    }
    this.flash = Math.max(0, this.flash - dt * (this.flash > 0.6 ? 5 : 2));
    if (this.bolt) {
      this.bolt.age += dt;
      if (this.bolt.age > 0.4) this.bolt = undefined;
    }
  }

  draw(ctx: CanvasRenderingContext2D, w: World): void {
    if (this.flash > 0) {
      // A double flicker, then the sky fades back.
      const a = this.flash > 0.72 && this.flash < 0.84 ? 0.04 : this.flash * 0.28;
      ctx.fillStyle = `rgba(225,232,255,${a})`;
      ctx.fillRect(0, 0, w.w, w.h);
    }
    const b = this.bolt;
    if (!b) return;
    const on = b.age < 0.08 || (b.age > 0.14 && b.age < 0.26);
    if (!on) return;
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.shadowColor = 'rgba(200,215,255,0.9)';
    ctx.shadowBlur = 14;
    b.paths.forEach((pts, i) => {
      ctx.strokeStyle = i === b.paths.length - 1 ? 'rgba(255,255,255,0.95)' : 'rgba(235,240,255,0.6)';
      ctx.lineWidth = i === b.paths.length - 1 ? 2.2 : 1.1;
      ctx.beginPath();
      pts.forEach(([x, y], k) => (k ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.stroke();
    });
    ctx.restore();
  }
}

// ---------------------------------------------------------------- the mix per condition

const WHITE: RGB = [255, 255, 255];
const GREY: RGB = [210, 218, 230];
const STORM: RGB = [120, 130, 150];

/** Whether a condition's sky shows the sun or the moon (which then stands in for the card's icon). */
export const celestial = (condition: string, night: boolean): 'sun' | 'moon' | undefined => {
  if (condition === 'clear-night') return 'moon';
  if (['sunny', 'partlycloudy', 'windy'].includes(condition)) return night ? 'moon' : 'sun';
  return undefined;
};

/** Which effects, back to front, a condition shows. */
export const effectsFor = (condition: string, night: boolean, south = false): { effects: Effect[]; lean: number } => {
  const nightSky = () => [new Stars(), new Moon(south)];
  const sky: Effect[] = night ? nightSky() : [new Sun()];
  const darkClouds = (count = 6) => new Clouds({ count, tone: STORM, alpha: 0.5, speed: 14, band: 0.55 });
  switch (condition) {
    case 'sunny':
      return { effects: sky, lean: 0.1 };
    case 'clear-night':
      return { effects: nightSky(), lean: 0.1 };
    case 'partlycloudy':
      return { effects: [...sky, new Clouds({ count: 3, tone: WHITE, alpha: 0.55, speed: 9, band: 0.45 })], lean: 0.1 };
    case 'cloudy':
      return { effects: [new Clouds({ count: 7, tone: GREY, alpha: 0.5, speed: 8, band: 0.7 })], lean: 0.1 };
    case 'fog':
      return { effects: [new Clouds({ count: 3, tone: GREY, alpha: 0.3, speed: 4, band: 0.4 }), new Fog()], lean: 0.05 };
    case 'rainy':
      return { effects: [darkClouds(), new Rain('moderate')], lean: 0.1 };
    case 'pouring':
      return { effects: [darkClouds(8), new Rain('heavy')], lean: 0.14 };
    case 'lightning':
      return { effects: [new Lightning(), darkClouds(7)], lean: 0.1 };
    case 'lightning-rainy':
      return { effects: [new Lightning(), darkClouds(7), new Rain('moderate')], lean: 0.12 };
    case 'hail':
      return { effects: [darkClouds(7), new Rain('light'), new Hail()], lean: 0.1 };
    case 'snowy':
      return { effects: [new Clouds({ count: 5, tone: GREY, alpha: 0.45, speed: 6, band: 0.5 }), new Snow(1)], lean: 0.05 };
    case 'snowy-rainy':
      return { effects: [new Clouds({ count: 6, tone: GREY, alpha: 0.45, speed: 8, band: 0.5 }), new Rain('light'), new Snow(0.6)], lean: 0.08 };
    case 'windy':
    case 'windy-variant':
      return {
        effects: [...(condition === 'windy' ? sky : []), new Clouds({ count: condition === 'windy' ? 3 : 6, tone: GREY, alpha: 0.45, speed: 60, band: 0.5 }), new Wind()],
        lean: 0.45,
      };
    default:
      return { effects: [new Clouds({ count: 5, tone: GREY, alpha: 0.45, speed: 8, band: 0.6 })], lean: 0.1 };
  }
};

// ---------------------------------------------------------------- the element

export class HomeViewSky extends LitElement {
  /** A Home Assistant weather condition: sunny, rainy, snowy, fog… */
  @property() condition = 'sunny';
  @property({ type: Boolean }) night = false;
  /** Home's latitude: south of the equator the moon is lit from the other side. */
  @property({ type: Number }) latitude = 0;
  /** The element rain, hail and snow land on (the forecast panel). */
  @property({ attribute: false }) surface?: HTMLElement;

  private canvas?: HTMLCanvasElement;
  private ctx?: CanvasRenderingContext2D | null;
  private effects: Effect[] = [];
  private lean = 0.1;
  private world: World = { w: 0, h: 0, t: 0, night: false, wind: 0.1, edgeAt: () => undefined };
  private dpr = 1;
  private raf = 0;
  private last = 0;
  private frame = 0;
  private visible = true;
  private box?: { x: number; y: number; w: number; r: number };
  private resizer = new ResizeObserver(() => this.resize());
  private seen = new IntersectionObserver(([e]) => {
    this.visible = e.isIntersecting;
    this.schedule();
  });

  constructor() {
    super();
    this.world.edgeAt = (x) => this.edgeAt(x);
  }

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
  }

  protected updated(changed: Map<string, unknown>): void {
    if (changed.has('condition') || changed.has('night') || changed.has('latitude')) {
      const mix = effectsFor(this.condition, this.night, this.latitude < 0);
      this.effects = mix.effects;
      this.lean = mix.lean;
      this.world.night = this.night;
      this.resize();
    }
  }

  private resize(): void {
    if (!this.canvas) return;
    const r = this.getBoundingClientRect();
    this.world.w = Math.max(1, r.width);
    this.world.h = Math.max(1, r.height);
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(this.world.w * this.dpr);
    this.canvas.height = Math.round(this.world.h * this.dpr);
    for (const e of this.effects) e.size(this.world);
    this.measure();
    this.draw();
    this.schedule();
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

  private schedule = (): void => {
    const run = this.visible && !document.hidden && !prefersReducedMotion() && this.isConnected && this.effects.length > 0;
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
    const w = this.world;
    w.t += dt;
    // A steady lean for the condition, with slow gusts on top.
    w.wind = this.lean + 0.07 * Math.sin(w.t * 0.31) + 0.04 * Math.sin(w.t * 0.83 + 1.7) + 0.02 * Math.sin(w.t * 2.3);
    if (this.frame++ % 30 === 0) this.measure();
    for (const e of this.effects) e.step(dt, w);
    this.draw();
    this.raf = requestAnimationFrame(this.tick);
  };

  private draw(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.world.w, this.world.h);
    for (const e of this.effects) e.draw(ctx, this.world);
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

defineElement('homeview-sky', HomeViewSky);
