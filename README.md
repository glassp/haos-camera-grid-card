# Camera Grid Card

A small Home Assistant Lovelace card that shows [go2rtc](https://github.com/AlexxIT/go2rtc) streams in a grid. Each camera can have trigger entities. When one of them switches to the trigger state (`on` by default), that camera opens as a single full-screen overlay. A person closes it manually with the X button or Esc, or optionally after a timeout.

## Install

Manual:

1. Copy `camera-grid-card.js` to `/config/www/camera-grid-card.js`.
2. Add a dashboard resource: URL `/local/camera-grid-card.js`, type **JavaScript module**.
3. Reload the browser.

HACS: add this repository as a custom repository of type **Dashboard**.

## Configuration

```yaml
type: custom:camera-grid-card
go2rtc_url: https://go2rtc.example.com
columns: 2
aspect_ratio: "16:9"
fit: cover
trigger_state: "on"
auto_close_seconds: 0
show_titles: true
cameras:
  - title: Front door
    stream: frontdoor
    triggers:
      - binary_sensor.frontdoor_person
  - title: Garden
    stream: garden
```

| Option | Default | Description |
|---|---|---|
| `go2rtc_url` | – | Base URL of go2rtc, used by cameras without their own `url`. |
| `columns` | `2` | Grid columns. |
| `aspect_ratio` | `16:9` | Tile aspect ratio. |
| `fit` | `cover` | `cover` or `contain` for the grid tiles. |
| `trigger_state` | `on` | State (or list of states) that opens the overlay. Use `"*"` to fire on every state change. |
| `auto_close_seconds` | `0` | Close the overlay automatically after N seconds; `0` means manual only. |
| `show_titles` | `true` | Show camera titles on tiles. |
| `cameras[].stream` | – | go2rtc stream name (required). |
| `cameras[].title` | – | Display title. |
| `cameras[].url` | `go2rtc_url` | Per-camera go2rtc base URL override. |
| `cameras[].id` | `stream` | Identifier, defaults to the stream name. |
| `cameras[].triggers` | – | Entities that open this camera when they change to `trigger_state`. |

A visual editor is included. Its camera list uses the object selector with `fields`, which needs a recent Home Assistant.

## Behavior

- The overlay opens on every state transition into the trigger state (off → on → off → on fires twice), while the dashboard is open in a browser. It does not open if the entity was already `on` at page load, since no transition happens.
- If the overlay is closed while the trigger is still `on`, it reopens only on the next transition into `on`.
- If another camera's trigger fires while an overlay is open, the overlay switches to that camera.
- Tapping a tile opens that camera as an overlay.
- Full screen reuses the tile that is already in the grid (lifted into the browser's top layer via the Popover API, with a `position:fixed` fallback), so the running stream is not remounted or reconnected. The other tiles keep streaming in the background. It is not the browser Fullscreen API, which browsers block without a user gesture.

## Limitations

- go2rtc streams only. The go2rtc host must be reachable from the browser; the card connects to `<go2rtc_url>/api/ws?src=<stream>` over WebSocket. No scripts are loaded from go2rtc.
- Untested against real hardware at the time of writing.

## Credits

The bundled player is go2rtc's `video-rtc.js` (MIT, Copyright (c) 2022 Alexey Khit, <https://github.com/AlexxIT/go2rtc>).
