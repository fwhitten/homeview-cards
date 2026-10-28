/** What a pop-up is opened with: the card's main entity and its whole config. */
export interface PopupProps {
  entity?: string;
  config: Record<string, unknown>;
}

export interface PopupHostElement extends HTMLElement {
  show(name: string, props: PopupProps): void;
  close(): void;
}

const HOST_TAG = 'homeview-popup-host';

/**
 * Open a HomeView pop-up. The host lives in document.body so it covers the
 * whole viewport, header and sidebar included, rather than being clipped by
 * the dashboard's layout containers.
 */
export const openPopup = (name: string, props: PopupProps): void => {
  let host = document.body.querySelector<PopupHostElement>(HOST_TAG);
  if (!host) {
    host = document.createElement(HOST_TAG) as PopupHostElement;
    document.body.appendChild(host);
  }
  host.show(name, props);
};

export const popupTag = (name: string): string => `homeview-${name}-popup`;
