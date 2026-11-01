import type { LitElement, ReactiveController } from 'lit';

/**
 * Tracks the rendered size of one element in a host's shadow root, so a chart
 * can draw at its real pixel size instead of stretching a fixed viewBox. That
 * keeps strokes even without vector-effect: non-scaling-stroke, which WebKit
 * gets wrong for gradient strokes (the colours slide off on iPhone).
 */
export class SizeController implements ReactiveController {
  width = 0;
  height = 0;
  private el?: Element;
  private readonly observer = new ResizeObserver(([entry]) => this.set(entry.contentRect.width, entry.contentRect.height));

  constructor(
    private readonly host: LitElement,
    private readonly selector: string,
  ) {
    host.addController(this);
  }

  private set(width: number, height: number): void {
    const w = Math.round(width);
    const h = Math.round(height);
    if (!w || !h || (w === this.width && h === this.height)) return;
    this.width = w;
    this.height = h;
    this.host.requestUpdate();
  }

  hostUpdated(): void {
    const el = this.host.renderRoot.querySelector(this.selector) ?? undefined;
    if (el !== this.el) {
      if (this.el) this.observer.unobserve(this.el);
      this.el = el;
      if (el) this.observer.observe(el);
    }
    // ResizeObserver can lag (or pause in a hidden tab): read the box directly too.
    if (el) {
      const box = el.getBoundingClientRect();
      this.set(box.width, box.height);
    }
  }

  hostDisconnected(): void {
    this.observer.disconnect();
    this.el = undefined;
  }
}
