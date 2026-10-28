export const fireEvent = <T>(node: EventTarget, type: string, detail?: T): void => {
  node.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
};

/** Light haptic feedback in the companion apps (ignored elsewhere). */
export const haptic = (kind: 'selection' | 'light' | 'medium' | 'success' | 'warning' = 'light'): void => {
  fireEvent(window, 'haptic', kind);
};

export const navigate = (path: string, replace = false): void => {
  if (replace) history.replaceState(null, '', path);
  else history.pushState(null, '', path);
  fireEvent(window, 'location-changed', { replace });
};

export const prefersReducedMotion = (): boolean =>
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
