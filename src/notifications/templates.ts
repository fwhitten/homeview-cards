import type { HomeAssistant } from './types';

export const isTemplate = (value: unknown): value is string =>
  typeof value === 'string' && (value.includes('{{') || value.includes('{%'));

interface RenderTemplateResult {
  result?: unknown;
  error?: string;
}

interface Entry {
  unsub?: () => Promise<void>;
  disposed: boolean;
  received: boolean;
  result?: unknown;
}

/**
 * Keeps a live `render_template` subscription open for every template the card
 * currently cares about, and calls back whenever any of them produces a new
 * value. Subscriptions are reference-free: `sync()` is given the complete set
 * of templates and reconciles against what is already open.
 */
export class TemplateSubscriber {
  private entries = new Map<string, Entry>();
  private hass?: HomeAssistant;

  constructor(private onChange: () => void) {}

  public setHass(hass: HomeAssistant | undefined): void {
    // The connection only changes across logins; resubscribing on every state
    // update would be catastrophic, so only react to a genuinely new one.
    const changed = this.hass?.connection !== hass?.connection;
    this.hass = hass;
    if (changed) {
      const templates = [...this.entries.keys()];
      this.destroy();
      this.sync(templates);
    }
  }

  public sync(templates: string[]): void {
    const wanted = new Set(templates.filter(isTemplate));

    for (const [template, entry] of this.entries) {
      if (!wanted.has(template)) {
        entry.disposed = true;
        void entry.unsub?.();
        this.entries.delete(template);
      }
    }

    if (!this.hass) {
      return;
    }

    for (const template of wanted) {
      if (this.entries.has(template)) {
        continue;
      }
      const entry: Entry = { disposed: false, received: false };
      this.entries.set(template, entry);

      this.hass.connection
        .subscribeMessage<RenderTemplateResult>(
          (message) => {
            if (entry.disposed) {
              return;
            }
            const next = message.error !== undefined ? undefined : message.result;
            const first = !entry.received;
            entry.received = true;
            if (first || next !== entry.result) {
              entry.result = next;
              this.onChange();
            }
          },
          { type: 'render_template', template, report_errors: true },
        )
        .then(
          (unsub) => {
            if (entry.disposed) {
              void unsub();
            } else {
              entry.unsub = unsub;
            }
          },
          (err) => {
            entry.received = true;
            // eslint-disable-next-line no-console
            console.warn('[homeview-notification-card] template failed:', template, err);
            this.onChange();
          },
        );
    }
  }

  public get(template: string): unknown {
    return this.entries.get(template)?.result;
  }

  /** True once every template has produced at least one value. */
  public isReady(): boolean {
    for (const entry of this.entries.values()) {
      if (!entry.received) {
        return false;
      }
    }
    return true;
  }

  public destroy(): void {
    for (const entry of this.entries.values()) {
      entry.disposed = true;
      void entry.unsub?.();
    }
    this.entries.clear();
  }
}
