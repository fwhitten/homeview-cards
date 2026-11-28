# Changelog

Each release's section here is published as its release notes, which Home
Assistant shows in the update dialog (Settings → Updates).

## 0.4.13

### Added
- **Boiler pop-up:** a Gas graph, heating and hot water stacked, by the hour over 24 hours or by the day over 7 days.
- **Boiler:** gas can come from a running counter without statistics, such as Vaillant's eBUS `PrEnergyCountHc1` / `PrEnergyCountHwc1` (read as Wh), and `gas_scale` sets the units if needed.

### Changed
- **Weather card:** new rain: drops at many depths and speeds, slanted by a gusting wind, splashing on the forecast panel, with the odd lightning flash in thunderstorms. It pauses when off screen.

### Fixed
- **Power graph:** the scale fits the line again, rather than a brief spike (which still shows as the peak).
- **Boiler pop-up:** Gas today counts what a counter added since midnight, rather than showing its running total.

## 0.4.12

### Changed
- **Energy pop-up:** comparisons show the percentage only again (e.g. "↑ 30% vs yesterday"). Looking back at an earlier day, week or month, they read "vs the day before" and so on.

## 0.4.11

### Added
- **Weather pop-up:** each day shows rain with a drop: the chance when the forecast gives one, otherwise the amount.

### Changed
- **Weather pop-up:** each day's temperature bar is coloured by its actual temperatures, blue when cold through to orange and red when warm.
- **Energy pop-up:** each comparison says what it's against, e.g. "↑ 1335% vs 3.6 kWh yesterday", so a big swing (like an EV charging either side of midnight) can be checked at a glance.
- **Pop-ups:** no scroll bars.

### Fixed
- **Pop-ups:** the gap below the last panel is back when a pop-up scrolls.

## 0.4.10

### Added
- **EV pop-up:** the charge-slots chart has more time markers, every 1, 2, 4 or 6 hours depending on the space.
- **Select chips:** the options menu closes by itself after 10 seconds without a touch.

### Fixed
- **Lights pop-up:** rooms sit in two columns whose tops line up, and sliders are no longer cut short or missing on iPad (Safari mis-drew them in the second column).
- **Pop-ups:** swiping inside a pop-up no longer scrolls the dashboard behind it, including after tapping a power button.
- **Pop-ups:** buttons are the same colour in every panel, whatever part of the wallpaper is behind them.
- **EV pop-up:** the Initial and Target labels turn away from each other when the handles are close, so they no longer overlap.

## 0.4.9

### Added
- **EV pop-up:** one battery with draggable Initial and Target handles, the car's current level in between (`current_soc_entity`), a charging animation, and a charge-slots timeline.
- **Vacuum pop-up:** the device's modes and settings (mode, mop humidity…) and time remaining.
- **Lights pop-up:** light groups and lights with no area are left out by default; `exclude_entities`, `include_groups` and `include_unassigned` to choose.
- **Pop-ups:** close after 60 seconds without a touch (`popup_timeout` on the view; 0 keeps them open).

### Changed
- **Lights pop-up:** All off moved to the header; scene chips scroll out to the panel's edges.
- **Sliders:** much smoother while dragging.
- **Weather pop-up:** the hourly forecast spreads evenly across the panel.
- **Vacuum pop-up:** the map fills its panel.

### Fixed
- Shadows under the bottom row of cards are no longer cut off above the page dots.
- The vacuum pop-up no longer jumps when an area is selected.
- Unavailable lights say so, rather than looking switched off.

## 0.4.8

### Added
- **Pop-ups:** weather (details, swipeable hourly, 10-day), comfort (temperature, humidity and heating history), and vacuum (controls, areas, map, maintenance).
- **Chips:** `popup: ev` for EV charger controls and `popup: all-lights` for every light by area; select chips open a menu of their options.

### Fixed
- The power peak counts every reading, including the live one.
- Pop-ups size themselves without viewport units, and lay out by their own width.
- No white focus ring left on a card after tapping to close a pop-up.
- Switching 1/3/6 h in the power pop-up is instant.
- The media card shows the last track it played when the player goes idle, and Resume replays it on Music Assistant.

## 0.4.7

### Added
- **Energy card:** style C can show today, this week or this month (`period`).

### Changed
- Thermostat temperatures use the energy card's sizes.

## 0.4.6

### Added
- **Agenda pop-up** with a day timeline.
- **Camera:** open the pop-up when a detection fires; the snapshot clock shows the snapshot's time.

### Changed
- One even padding on every card.

## 0.4.5

### Added
- Calendar progress chips with visibility windows and countdowns; a fill style for progress chips.
- Greeting and date can be shown separately.

### Fixed
- The card editor no longer freezes the tab; editor previews render fully.
- The camera pop-up plays the stream.

## 0.4.4

### Added
- **Camera pop-up** with a high-resolution stream (`stream_entity`).

## 0.4.3

### Added
- Progress chips in the header.

### Fixed
- The power line keeps its colours on iPhone.

## 0.4.2

### Changed
- One layout for all three energy styles; the Mineral device palette, with per-device colours.

### Fixed
- Deleting a card works again; chip state pickers are dropdowns.

## 0.4.1

### Fixed
- Energy statistics are read in kWh, so excluding a Wh device no longer gives a huge negative.

## 0.4.0

### Added
- Per-grid-size layouts, a drag handle with a position sheet, and wallpaper and chips editors.
