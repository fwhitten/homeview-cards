# HomeView Cards

[![hacs][hacs-badge]][hacs-url]
[![release][release-badge]][release-url]
[![license][license-badge]](LICENSE)

Apple HomeView-style cards for a Home Assistant wall panel: liquid-glass tiles
over a photo wallpaper, type sized to read across the room, one gesture model
on every card, and a wall-panel view with a built-in ambient clock and
notifications. Designed for a 13″ iPad in landscape and works in any sections
dashboard.

[![Open your Home Assistant instance and open a repository inside the Home Assistant Community Store.][hacs-button]][hacs-url]

Pair it with **[HomeView Theme](https://github.com/fwhitten/homeview-theme)**
for the wallpaper and the rest of Home Assistant's UI.

[![Open your Home Assistant instance and open the HomeView theme in HACS.][hacs-button]][theme-url]

---

## What's included

| Card | Type | What it does |
| --- | --- | --- |
| Light | `custom:homeview-light-card` | A light, a group or a whole area. Swipe to dim, tap the icon to toggle, tap for the lights pop-up (colours, white, scenes, each light). |
| Thermostat | `custom:homeview-thermostat-card` | Reading, target stepper, and the last hours of actual vs target edge to edge underneath. |
| Weather | `custom:homeview-weather-card` | Animated sky, conditions / temperature / high-low, and a next-hour or hourly forecast. |
| Clock | `custom:homeview-clock-card` | Depth-photo clock: the time sits between a photo and its cut-out subject. |
| Camera | `custom:homeview-camera-card` | Full-bleed live feed, LIVE badge, latest detection in a glass chip. |
| Media | `custom:homeview-media-card` | Now playing, tinted from the artwork, layout A (2×1) or B (2×2). Swipe for volume. |
| Energy | `custom:homeview-energy-card` | Live power from the Energy dashboard in three styles. Tap for the energy pop-up. |
| Boiler | `custom:homeview-boiler-card` | Mode and flow temperature. Tap for the flow diagram, zones, gas and history. |
| Comfort | `custom:homeview-comfort-card` | Temperature and humidity comfort as a gauge or two scales, filled or glass. |
| Progress | `custom:homeview-progress-card` | Fill, ring or dots for appliances, batteries, timers and calendar events. |
| Vacuum | `custom:homeview-vacuum-card` | Robot vacuum state, controls, suction and clean-by-area. |
| Agenda | `custom:homeview-agenda-card` | Today's calendar events, merged and colour-coded. |
| Scene | `custom:homeview-scene-card` | One-tap scene tiles, or up to four suggested for the time of day. |
| Status chips | `custom:homeview-chips-card` | Chips that turn amber, green or red when something needs you. Doubles as the header. |
| Ambient clock | `custom:homeview-ambient-card` | Full-screen depth clock and glance chips when nobody is in front of the panel. |
| Notifications | `custom:homeview-notification-card` | A port of [Fullscreen Notification Card](https://github.com/fwhitten/ha-fullscreen-notification-card) in the HomeView style. |
| Wall-panel view | `type: custom:homeview-view` (view) | 6 × 4 grid, wallpaper, header, ambient clock and notifications in one view. |

Every card has a visual editor and shows up in the card picker. The editor
only shows the options that apply to the variant you pick (for example,
power colour thresholds disappear when the energy card shows kWh), and every
card has an **Interactions** section (tap, hold, double tap, including
*navigate*) and a **Position on the HomeView view** section (column, row,
width and height).

## Install

**With HACS (recommended)**

1. Click the button above and confirm when HACS offers to add the repository.
2. Download **HomeView Cards**, then reload your browser.
3. Add cards from **Add card → HomeView …**.

To add it by hand: in HACS open ⋮ → **Custom repositories**, paste
`https://github.com/fwhitten/homeview-cards`, choose **Dashboard**, and click **Add**.

**Manually**

1. Download `homeview-cards.js` from the [latest release][release-url].
2. Copy it to `<config>/www/community/homeview-cards/`.
3. Add it as a dashboard resource (**Settings → Dashboards → ⋮ → Resources**):
   `/local/community/homeview-cards/homeview-cards.js`, type **JavaScript module**.

Requires Home Assistant **2026.3** or newer.

## The same gestures everywhere

| Gesture | Does |
| --- | --- |
| Tap | Opens the card's pop-up, or more-info |
| Tap the icon | Toggles (lights, media, vacuum) |
| Swipe up / down | Dims lights, changes volume |
| Hold | Home Assistant more-info |

`tap_action`, `hold_action` and `double_tap_action` accept the usual Home
Assistant actions plus `homeview-popup`.

## Appearance

Cards follow Home Assistant's light / dark mode. Set `appearance: light | dark |
night` on a card or the view to pin one. Night mode dims everything and warms
the text; turn it on with `night_entity` (an `input_boolean`, a
`binary_sensor`, or `sun.sun` for "after sunset").

Every colour reads a `--hv-*` variable first, so [HomeView Theme](https://github.com/fwhitten/homeview-theme)
or your own theme can restyle the glass.

## The wall-panel view

```yaml
views:
  - title: Home
    type: custom:homeview-view
    wallpaper:
      dark: /local/homeview/wall-dusk.jpg
      light: /local/homeview/wall-day.jpg
    night_entity: sun.sun
    header:
      greeting: true
      chips:
        - entity: lock.front_door
          name: Doors locked
          icon: mdi:lock
          color: "#4CD07D"
        - entity: sensor.bin_collection
          name: Bins {state}
          icon: mdi:trash-can
          attention_when: { state: tomorrow }
    ambient:
      motion_entity: binary_sensor.hallway_presence
      timeout: 120
      photos:
        - background: /local/homeview/alpine-bg.jpg
          foreground: /local/homeview/alpine-fg.webp
    notifications:
      style: fullscreen
      notifications:
        - type: success
          title: Washing finished
          entity: sensor.washing_machine_status
          state: complete
    screens: 2
    cards:
      - type: custom:homeview-clock-card
        view_layout: { column: 1, row: 1, column_span: 2, row_span: 2 }
      - type: custom:homeview-weather-card
        entity: weather.home
        view_layout: { column: 3, row: 1, column_span: 2, row_span: 2 }
      - type: custom:homeview-light-card
        area: living_room
```

The grid sizes itself to the screen (`columns` / `rows` default to `auto`,
fitting ~200 px tiles): 6 × 4 on a landscape iPad Pro, 4 × 5 in portrait. Set
numbers to fix it. Under 900 px wide it becomes a scrolling two-column list.

**Positions are kept per grid size.** Arrange the view on the wall panel and
the positions are saved for its grid (say `6x4`); arrange it again on a phone
or in portrait and those are saved separately, so neither disturbs the other.
On a grid you haven't arranged yet, cards pack into the first free space in the
order of the grid you've arranged most, never overlapping, and spill onto
another screen when they run out of room. Cards without positions pack the
same way, using their own size.

```yaml
view_layout:
  column_span: 2          # size is shared by every grid
  row_span: 1
  grids:
    6x4: { screen: 1, column: 3, row: 1 }
    4x5: { screen: 1, column: 1, row: 3 }
```

Single positions from earlier versions (`column`, `row`, `screen`) still work:
they place the card until you first arrange it.

**Screens.** Add `screens: 3` to the view for at least three screens. Swipe
left and right between them; dots in the bottom border show where you are and
can be tapped.

**Editing.** In the dashboard's edit mode each card gets a drag handle at the
top: drag it to move the card, or tap it to type in a column and row, pick a
spot on a map of the grid, change the size, or send the card to another (or a
new) screen. Cards in the way move to the nearest free space. The corner
handle resizes, and the pencil and bin edit and delete. Along the bottom
border: **Card**, **Screen**, **Last screen** (when it's empty) and
**Wallpaper**, which picks the HomeView gradient, the theme's photos, an image
URL or an upload, for every mode or one per mode. Tap **Header** to turn the
greeting on or off and add, reorder and edit the chips, visibility conditions
included.

In a sections dashboard, put `homeview-chips-card` (with `show_greeting`),
`homeview-ambient-card` and `homeview-notification-card` on the page
yourself.

For a true kiosk, hide Home Assistant's header and sidebar with a kiosk-mode
integration, and use the HA companion app with the screen kept awake.

## Cards

### Light

```yaml
type: custom:homeview-light-card
area: living_room          # or entity: light.lamp, or entities: [...]
swipe: vertical            # vertical | horizontal | off
```

Clear glass above the level and the light's own colour below it, with the
text flipping colour where they meet. The pop-up shows brightness, white
temperatures, colours and a colour wheel (for lights that support them), the
area's scenes, and each light with its own slider.

### Thermostat

```yaml
type: custom:homeview-thermostat-card
entity: climate.living_room
hours_to_show: 12
humidity_entity: sensor.living_room_humidity   # optional
```

At 2×1 the reading sits above the graph. At 2×2 the graph gains a time
axis and the target stepper stacks vertically. At 1×1 it's a compact reading.

### Weather

```yaml
type: custom:homeview-weather-card
entity: weather.home
forecast: auto        # auto | next_hour | hourly
rain_entity: sensor.minutely_precipitation   # optional
rain_attribute: forecast
show_sun: true        # sunrise and sunset in the hourly forecast, from sun.sun
```

Forecasts come from `weather/subscribe_forecast`. Home Assistant's weather
entity has no minute-by-minute rain, so without `rain_entity` the next-hour
view uses the hourly forecast. `auto` switches to it when rain is due.

### Clock and ambient clock (depth photos)

```yaml
type: custom:homeview-clock-card
photos:
  - background: /local/homeview/alpine-bg.jpg
    foreground: /local/homeview/alpine-fg.webp
    position: 0.13       # numerals' top, as a fraction of the height
```

Each photo is a pair: the full photo, and the same photo with only the
subject kept on a transparent background (PNG or WebP). On a Mac, *Lift
subject from background* in Photos or Preview makes the cut-out. Put both in
`/config/www/homeview/`. The numeral colour is sampled from the top of the
photo unless you set `color`.

### Camera

```yaml
type: custom:homeview-camera-card
entity: camera.driveway_sub         # the card's feed: a low-resolution stream suits a tile
view: snapshot                      # live | snapshot
stream_entity: camera.driveway_main # played when tapped; defaults to entity
aspect_ratio: '16:9'                # the pop-up's shape
events:
  - entity: binary_sensor.driveway_person_detected
    label: Person
    icon: mdi:account
```

Tap opens HomeView's camera pop-up: the stream edge to edge, as large as the
screen allows, playing straight away without player controls. The card's
still shows until the first frame arrives. The LIVE badge, recent detections,
a clock and a mute button sit over the picture. Hold still opens Home
Assistant's more-info.

### Media

```yaml
type: custom:homeview-media-card
entity: media_player.living_room
layout: auto     # auto | compact (A, 2×1) | artwork (B, 2×2)
```

Only the controls the player supports are shown: shuffle, previous,
play/pause, next, repeat, and mute.

### Energy

```yaml
type: custom:homeview-energy-card
style: threshold     # threshold (A) | distribution (B) | total (C)
total_mode: home     # home | grid
hours: 3
points_per_hour: 60  # line resolution; empty = one point every two pixels
y_max: 3000          # top of the graph in W; empty = scales to the peak
thresholds:
  - { value: 0, color: "#4CD07D" }
  - { value: 1500, color: "#FFB340" }
  - { value: 4000, color: "#FF5A5F" }
devices:
  - { stat: sensor.tv_energy, name: Telly, color: "#4C8DFF" }
  - { stat: sensor.fridge_energy, hidden: true }   # left out of graphs, still in the total (as Other)
  - { stat: sensor.ev_energy, excluded: true }     # taken out of the total and every graph
```

Reads the Energy dashboard: grid / solar / battery power for the live
reading, and device consumption (with each device's power sensor) for the
breakdown. Set `power_entity` to use a single sensor instead. The power line
uses the same data and bucketing as
[energy-breakdown-card](https://github.com/fwhitten/energy-breakdown-card):
recorder history up to 6 hours (five-minute statistics beyond), averaged per
point with the last reading carried through quiet spells. The editor's
**Devices** section lists every Energy dashboard device to rename, recolour,
hide or exclude. Devices take HomeView's Mineral palette in order (twelve soft
colours of equal lightness, neighbours always contrasting); pick any colour
there to override one.

All three styles share one layout: the label with its context underneath, the
value top right on wide tiles (under the label on narrow ones), and the graph,
device bar or hourly bars filling the rest. Taller and larger tiles add
detail: average and lowest power, the device list, or yesterday, this week
and this month. The pop-up shows
power now, today / this week / this month, and a per-device breakdown by day,
week, month or year.

### Boiler

```yaml
type: custom:homeview-boiler-card
flow_temp_entity: sensor.boiler_flow_temperature
flow_target_entity: sensor.boiler_flow_target
return_temp_entity: sensor.boiler_return_temperature
flame_entity: binary_sensor.boiler_flame
pump_entity: sensor.boiler_pump
dhw_temp_entity: sensor.boiler_hot_water_temperature
dhw_active_entity: binary_sensor.boiler_hot_water_active
outdoor_entity: sensor.outdoor_temperature
heating_energy_entity: sensor.boiler_heating_energy
hot_water_energy_entity: sensor.boiler_hot_water_energy
zones:
  - name: Radiators
    climate_entity: climate.radiators
    heat_call_entity: binary_sensor.radiators_call
```

Mode logic follows [Boiler Cards](https://github.com/fwhitten/ha-boiler-cards):
hot water if `dhw_active_entity` is on (or inferred), else heating if any zone
calls, else pump overrun, else idle.

### Comfort

```yaml
type: custom:homeview-comfort-card
area: bedroom          # finds the temperature and humidity sensors
style: gauge           # gauge (A) | scales (C)
background: filled     # filled | glass
history_hours: 3
```

Comfort ranges default to 20–24 °C and 40–60 %; set `temp_min`, `temp_max`,
`humidity_min`, `humidity_max` to change them.

### Progress

```yaml
type: custom:homeview-progress-card
entity: sensor.dishwasher_progress   # also timer.* and calendar.*
design: fill          # fill (A) | ring (B) | dots (C)
secondary_entities: [sensor.dishwasher_remaining]
thresholds:
  - { value: 0, color: "#4C8DFF" }
  - { value: 90, color: "#4CD07D" }
```

Every design works at 1×1, 2×½, 2×1 and 2×2. Calendars show the event in
progress, with `hide_when: no_events_today` to disappear when there's nothing
on. Pinning (`pin_entity`, `pin_states`, `pin_value`) works as in
progress-bar-card.

### Vacuum

```yaml
type: custom:homeview-vacuum-card
entity: vacuum.robot
style: areas                       # status (A) | areas (B)
battery_entity: sensor.robot_battery
areas: [kitchen, hallway, living_room]
```

Uses the standard vacuum entity: start, pause, stop, return to dock, locate,
suction (`fan_speed_list`) and `vacuum.clean_area`. For areas, first map the
vacuum's segments to Home Assistant areas (vacuum entity settings → **Map
vacuum segments to areas**). Maps are not part of the vacuum entity, so the
card doesn't draw one.

### Agenda

```yaml
type: custom:homeview-agenda-card
style: today        # today (B) | date (C)
calendars:
  - calendar.family
  - entity: calendar.work
    color: "#7D6BFF"
```

### Scenes

```yaml
type: custom:homeview-scene-card
entity: scene.movie
color: "#7D6BFF"
note: Lights 10%, TV on
```

```yaml
type: custom:homeview-scene-card
style: suggested
scenes:
  - { entity: scene.good_morning, after: "06:00", before: "10:00" }
  - { entity: scene.dinner, after: "17:30", before: "20:30" }
  - { entity: scene.movie, after: "19:00" }
  - { entity: script.good_night, after: "21:30", before: "02:00" }
```

### Status chips

Chips take Home Assistant's own badge options, so badge YAML pastes straight in. In the
visual editor, chips are a list to add, reorder and open up, with visibility
conditions (entity state, number, screen size) built in:

```yaml
type: custom:homeview-chips-card
style: full          # full (A) | compact (B) | glance (C)
show_greeting: true
chips:
  - type: entity
    entity: person.fred
    show_name: true
    show_state: true
    show_entity_picture: true
    visibility:
      - condition: state
        entity: person.fred
        state: home
  - type: entity
    entity: sensor.charger_status
    icon: mdi:ev-plug-type2
    tap_action:
      action: navigate
      navigation_path: /dashboard-energy
    visibility:
      - condition: state
        entity: sensor.charger_status
        state_not: unavailable
  - entity: binary_sensor.smoke_kitchen
    name: Smoke · kitchen
    show_name: true
    show_state: false
    alert_when: { state: "on" }
    visibility:
      - condition: state
        entity: binary_sensor.smoke_kitchen
        state: "on"
```

| Option | Default | |
| --- | --- | --- |
| `show_name` / `show_state` | `false` / `true` | Both on gives two lines: name above, state below |
| `show_icon` | `true` | |
| `show_entity_picture` | `false` | Person photos, media artwork |
| `state_content` | `state` | One or a list of `state`, `name`, `last_changed`, `last_updated`, or any attribute (e.g. `message` for a calendar) |
| `color` | `state` | Icon colour: an HA colour name (`amber`, `red`, `primary`…), `state`, `none`, or any CSS colour |
| `visibility` | | The same conditions as HA badges and cards: `state`, `numeric_state`, `screen`, `user`, `and`, `or`, `not` |
| `attention_when` / `success_when` / `alert_when` | | Fills the chip amber, green, or red and pulsing |
| `tap_action` / `hold_action` / `double_tap_action` | more-info | Any HA action, including `navigate` (hash paths such as `#lights-pop-up` work for Bubble Card pop-ups) |

#### Progress chips

`type: progress` puts a ring around the icon that fills as something runs,
with the name over the time remaining (or the percentage). It takes
[ha-progress-card](https://github.com/fwhitten/progress-bar-card)'s options, so
that card's YAML pastes in: a number between `min` and `max`, a running
timer, or the calendar event in progress.

```yaml
- type: progress
  entity: sensor.bosch_dishwasher_program_progress
  name: Dishwasher
  icon: mdi:dishwasher
  color: blue                     # or bar_color; theme names or any CSS colour
  thresholds:
    - { value: 100, color: light-green }
  value_entity: sensor.bosch_dishwasher_remaining_program_time
  pin_entity: sensor.bosch_dishwasher_operation_state
  pin_states: [finished]
  pin_value: max                  # max, min or a number
  visibility:
    - condition: state
      entity: sensor.bosch_dishwasher_power_state
      state: 'on'
- type: progress
  entity: calendar.octopus_energy_octoplus_power_up
  name: Power Up
  icon: mdi:lightning-bolt
  color: green
  hide_when: no_events_today      # never | no_events_today | no_events
```

When it finishes (pinned at the maximum, or reaching it) the ring closes in
its final colour and the chip says Done until its visibility hides it. Tap
opens the entity's more-info. `show_name: false` or `show_state: false` drop a
line. In the visual editor, use **Add a progress chip**.

### Notifications

Same options as [Fullscreen Notification Card](https://github.com/fwhitten/ha-fullscreen-notification-card#card-options),
under `type: custom:homeview-notification-card`.

## Development

```bash
npm install
npm run build     # -> dist/homeview-cards.js
npm run watch     # rebuild on change
npm run lint      # type-check only
```

`demo/index.html` loads the bundle with mock data:

```bash
python3 -m http.server 8765
```

Then open <http://localhost:8765/demo/>.

## License

MIT — see [LICENSE](LICENSE).

[hacs-badge]: https://img.shields.io/badge/HACS-Custom-41BDF5.svg?style=flat-square
[hacs-button]: https://my.home-assistant.io/badges/hacs_repository.svg
[hacs-url]: https://my.home-assistant.io/redirect/hacs_repository/?owner=fwhitten&repository=homeview-cards&category=plugin
[theme-url]: https://my.home-assistant.io/redirect/hacs_repository/?owner=fwhitten&repository=homeview-theme&category=theme
[release-badge]: https://img.shields.io/github/v/release/fwhitten/homeview-cards?style=flat-square
[release-url]: https://github.com/fwhitten/homeview-cards/releases/latest
[license-badge]: https://img.shields.io/github/license/fwhitten/homeview-cards?style=flat-square
