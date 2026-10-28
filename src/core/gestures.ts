import type { ReactiveController, ReactiveControllerHost } from 'lit';

export interface DragHandlers {
  axis: 'x' | 'y';
  /** Called once the pointer has moved past the threshold along `axis`. */
  start(): void;
  /** Fraction of the element's size travelled since start: +1 = full width right / full height up. */
  move(fraction: number): void;
  end(): void;
}

export interface GestureHandlers {
  tap?(): void;
  hold?(): void;
  doubleTap?(): void;
  drag?: DragHandlers;
}

const MOVE_THRESHOLD = 6;
const HOLD_MS = 500;
const DOUBLE_TAP_MS = 250;

/** Elements inside the tile that own their own clicks. */
const isInteractive = (path: EventTarget[], root: Element): boolean => {
  for (const node of path) {
    if (node === root) return false;
    if (node instanceof HTMLElement && (node.matches('button, a, input, select, [data-no-tap]'))) return true;
  }
  return false;
};

/**
 * Tap, hold, double-tap and drag on one element, with pointer capture only
 * once a drag has really started, so taps on buttons inside the tile still work.
 */
export class GestureController implements ReactiveController {
  private el?: HTMLElement;
  private sx = 0;
  private sy = 0;
  private pointerId = -1;
  private dragging = false;
  private held = false;
  private moved = false;
  private holdTimer?: number;
  private tapTimer?: number;
  private size = 1;

  constructor(
    host: ReactiveControllerHost,
    private readonly handlers: () => GestureHandlers,
  ) {
    host.addController(this);
  }

  attach(el: HTMLElement | null | undefined): void {
    if (!el || el === this.el) return;
    this.detach();
    this.el = el;
    el.addEventListener('pointerdown', this.down);
    el.addEventListener('pointermove', this.move);
    el.addEventListener('pointerup', this.up);
    el.addEventListener('pointercancel', this.cancel);
    el.addEventListener('keydown', this.key);
    el.addEventListener('contextmenu', this.context);
  }

  hostDisconnected(): void {
    this.detach();
  }

  private detach(): void {
    const el = this.el;
    if (!el) return;
    el.removeEventListener('pointerdown', this.down);
    el.removeEventListener('pointermove', this.move);
    el.removeEventListener('pointerup', this.up);
    el.removeEventListener('pointercancel', this.cancel);
    el.removeEventListener('keydown', this.key);
    el.removeEventListener('contextmenu', this.context);
    this.el = undefined;
  }

  private down = (ev: PointerEvent): void => {
    if (ev.button !== 0 || !this.el) return;
    if (isInteractive(ev.composedPath(), this.el)) {
      this.pointerId = -1;
      return;
    }
    this.pointerId = ev.pointerId;
    this.sx = ev.clientX;
    this.sy = ev.clientY;
    this.dragging = false;
    this.held = false;
    this.moved = false;
    const h = this.handlers();
    if (h.hold) {
      this.holdTimer = window.setTimeout(() => {
        this.held = true;
        h.hold?.();
      }, HOLD_MS);
    }
  };

  private move = (ev: PointerEvent): void => {
    if (ev.pointerId !== this.pointerId || !this.el) return;
    const dx = ev.clientX - this.sx;
    const dy = this.sy - ev.clientY;
    if (!this.moved && Math.hypot(dx, dy) > MOVE_THRESHOLD) {
      this.moved = true;
      window.clearTimeout(this.holdTimer);
      const drag = this.handlers().drag;
      const along = drag?.axis === 'x' ? Math.abs(dx) : Math.abs(dy);
      const across = drag?.axis === 'x' ? Math.abs(dy) : Math.abs(dx);
      if (drag && !this.held && along > across) {
        this.dragging = true;
        const r = this.el.getBoundingClientRect();
        this.size = Math.max(1, drag.axis === 'x' ? r.width : r.height);
        try {
          this.el.setPointerCapture(ev.pointerId);
        } catch {
          /* capture can fail if the pointer already left */
        }
        drag.start();
      }
    }
    if (this.dragging) {
      ev.preventDefault();
      const drag = this.handlers().drag!;
      drag.move((drag.axis === 'x' ? dx : dy) / this.size);
    }
  };

  private up = (ev: PointerEvent): void => {
    if (ev.pointerId !== this.pointerId) return;
    window.clearTimeout(this.holdTimer);
    this.pointerId = -1;
    const h = this.handlers();
    if (this.dragging) {
      this.dragging = false;
      h.drag?.end();
      return;
    }
    if (this.held || this.moved) return;
    if (h.doubleTap) {
      if (this.tapTimer) {
        window.clearTimeout(this.tapTimer);
        this.tapTimer = undefined;
        h.doubleTap();
        return;
      }
      this.tapTimer = window.setTimeout(() => {
        this.tapTimer = undefined;
        h.tap?.();
      }, DOUBLE_TAP_MS);
      return;
    }
    h.tap?.();
  };

  private cancel = (ev: PointerEvent): void => {
    if (ev.pointerId !== this.pointerId) return;
    window.clearTimeout(this.holdTimer);
    if (this.dragging) this.handlers().drag?.end();
    this.dragging = false;
    this.pointerId = -1;
  };

  private key = (ev: KeyboardEvent): void => {
    if (ev.target !== this.el) return;
    if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault();
      this.handlers().tap?.();
    }
  };

  /** Long-press on touch opens the context menu in some browsers; hold replaces it. */
  private context = (ev: Event): void => {
    if (this.handlers().hold) ev.preventDefault();
  };
}
