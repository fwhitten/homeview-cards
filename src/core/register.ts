import type { CustomCardEntry } from './types';

export const REPO_URL = 'https://github.com/fwhitten/homeview-cards';

export const defineElement = (tag: string, ctor: CustomElementConstructor): void => {
  if (!customElements.get(tag)) customElements.define(tag, ctor);
};

/** Add a card to the dashboard card picker. */
export const registerCard = (entry: Omit<CustomCardEntry, 'documentationURL'> & { docs?: string }): void => {
  window.customCards = window.customCards || [];
  if (window.customCards.some((c) => c.type === entry.type)) return;
  const { docs, ...rest } = entry;
  window.customCards.push({ preview: true, ...rest, documentationURL: `${REPO_URL}#${docs ?? entry.type}` });
};
