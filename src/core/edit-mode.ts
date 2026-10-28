/** True when the card sits inside the dashboard editor's card chrome. */
export const inEditMode = (el: HTMLElement): boolean => {
  let node: Node | null = el;
  for (let depth = 0; node && depth < 24; depth++) {
    const name = (node as HTMLElement).localName;
    if (name === 'hui-card-options' || name === 'hui-card-edit-mode' || name === 'hui-card-preview') return true;
    node = (node as HTMLElement).parentElement ?? ((node.getRootNode() as ShadowRoot).host as Node | undefined) ?? null;
  }
  return false;
};
