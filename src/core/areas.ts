import type { HomeAssistant } from './types';

/** The area an entity is in: its own, else its device's. */
export const areaOf = (hass: HomeAssistant, entityId: string): string | undefined => {
  const entry = hass.entities?.[entityId];
  if (!entry) return undefined;
  if (entry.area_id) return entry.area_id;
  return entry.device_id ? hass.devices?.[entry.device_id]?.area_id ?? undefined : undefined;
};

/** Visible, non-config entities of a domain in an area, sorted by name. */
export const entitiesInArea = (hass: HomeAssistant, areaId: string, domain: string): string[] =>
  Object.values(hass.entities ?? {})
    .filter(
      (e) =>
        e.entity_id.startsWith(`${domain}.`) &&
        !e.hidden &&
        !e.entity_category &&
        areaOf(hass, e.entity_id) === areaId &&
        hass.states[e.entity_id],
    )
    .map((e) => e.entity_id)
    .sort((a, b) =>
      String(hass.states[a]?.attributes.friendly_name ?? a).localeCompare(String(hass.states[b]?.attributes.friendly_name ?? b)),
    );

export const areaName = (hass: HomeAssistant, areaId?: string): string | undefined =>
  areaId ? hass.areas?.[areaId]?.name : undefined;

/** First sensor in an area with a given device class, e.g. temperature or humidity. */
export const sensorInArea = (hass: HomeAssistant, areaId: string, deviceClass: string): string | undefined =>
  entitiesInArea(hass, areaId, 'sensor').find((id) => hass.states[id]?.attributes.device_class === deviceClass);
