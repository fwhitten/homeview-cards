import type { HomeAssistant } from './types';

export type Appearance = 'auto' | 'light' | 'dark' | 'night';
export type Mode = 'light' | 'dark' | 'night';

/** Settings a HomeView view (or the settings card) shares with every card on the page. */
export interface GlobalSettings {
  appearance?: Appearance;
  /** Entity that turns night mode on: an input_boolean/binary_sensor (`on`) or `sun.sun` (below horizon). */
  night_entity?: string;
}

type Listener = () => void;
type Topic = 'hass' | 'settings';

/**
 * One shared store per page. Cards push the latest hass into it so pop-ups and
 * overlays rendered into document.body stay live, and views publish settings.
 */
class HomeViewStore {
  hass?: HomeAssistant;
  settings: GlobalSettings = {};
  private listeners: Record<Topic, Set<Listener>> = { hass: new Set(), settings: new Set() };

  setHass(hass: HomeAssistant): void {
    if (this.hass === hass) return;
    this.hass = hass;
    this.listeners.hass.forEach((l) => l());
  }

  setSettings(settings: GlobalSettings): void {
    const next = JSON.stringify(settings);
    if (next === JSON.stringify(this.settings)) return;
    this.settings = { ...settings };
    this.listeners.settings.forEach((l) => l());
  }

  subscribe(topic: Topic, listener: Listener): () => void {
    this.listeners[topic].add(listener);
    return () => this.listeners[topic].delete(listener);
  }
}

const KEY = '__homeviewStore';
const scope = window as unknown as Record<string, HomeViewStore | undefined>;
export const store: HomeViewStore = scope[KEY] ?? (scope[KEY] = new HomeViewStore());

export const isNight = (hass: HomeAssistant | undefined, entityId: string | undefined): boolean => {
  if (!hass || !entityId) return false;
  const st = hass.states[entityId];
  if (!st) return false;
  if (entityId.startsWith('sun.')) return st.state === 'below_horizon';
  return st.state === 'on' || st.state === 'true' || st.state === 'night';
};

/** Resolve the mode a card should draw in: its own setting, then the view's, then HA's dark mode. */
export const resolveMode = (
  hass: HomeAssistant | undefined,
  appearance: Appearance | undefined,
  nightEntity: string | undefined,
): Mode => {
  const pick = appearance ?? store.settings.appearance ?? 'auto';
  if (pick === 'night') return 'night';
  if (isNight(hass, nightEntity ?? store.settings.night_entity)) return 'night';
  if (pick === 'light' || pick === 'dark') return pick;
  return hass?.themes?.darkMode === false ? 'light' : 'dark';
};
