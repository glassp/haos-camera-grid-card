# Camera Grid Card

A small Home Assistant Lovelace card that shows [go2rtc](https://github.com/AlexxIT/go2rtc) streams and/or Home Assistant camera entities in a grid. Each camera can have trigger entities. When one of them switches to the trigger state (`on` by default), that camera opens as a single full-screen overlay. A person closes it manually with the X button or Esc, or optionally after a timeout.

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
grid_quality: low
fullscreen_quality: auto
cameras:
  - title: Front door
    stream: frontdoor            # high quality
    stream_low: frontdoor_low    # optional low quality
    triggers:
      - binary_sensor.frontdoor_person
  - title: Garden
    stream: garden
  - title: Driveway
    entity: camera.driveway      # a Home Assistant camera entity instead
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
| `grid_quality` | `low` | Quality in the grid: `low`, `high` or `auto` (see below). |
| `fullscreen_quality` | `auto` | Quality in full screen: `low`, `high` or `auto`. |
| `min_downlink_mbps` | `3` | `auto` only: fall back to low below this network speed (Chromium browsers). `0` ignores it. |
| `stall_limit` | `3` | `auto` only: fall back to low after this many stalls of the high stream within 30 s. |
| `retry_high_seconds` | `60` | `auto` only: wait this long after a fallback before trying high again. |
| `cameras[].stream` | – | go2rtc stream name (the high-quality one if you also set `stream_low`). Set either `stream` or `entity`. |
| `cameras[].entity_low` | – | Optional low-quality camera entity for the same camera (use with `entity`, which is then the high-quality one). Enables the quality switching below. |
| `cameras[].stream_low` | – | Optional low-quality go2rtc stream for the same camera. Enables the quality switching below. |
| `cameras[].entity` | – | Home Assistant `camera.*` entity (alias: `camera_entity`). Rendered with Home Assistant's own live camera view. |
| `cameras[].title` | – | Display title. |
| `cameras[].url` | `go2rtc_url` | Per-camera go2rtc base URL override. |
| `cameras[].id` | `stream` | Identifier, defaults to the stream name. |
| `cameras[].triggers` | – | Entities that open this camera when they change to `trigger_state`. |

A visual editor is included. Its camera list uses the object selector with `fields`, which needs a recent Home Assistant.

## Multiple qualities

go2rtc has no adaptive bitrate: one stream name is one source, and the browser and go2rtc only negotiate codecs and transport (WebRTC, MSE, HLS), not quality. So different qualities have to be separate go2rtc streams, and this card does the switching. Define both in go2rtc, for example:

```yaml
streams:
  frontdoor: rtsp://cam/main
  frontdoor_low: rtsp://cam/sub      # or: ffmpeg:frontdoor#video=h264#height=480
```

and give the camera `stream` and `stream_low`. Camera entities work the same way with `entity` (high) and `entity_low` (low). Mixing an `entity` with a `stream_low` is not supported. Each mode behaves like this:

- `low`: only the low stream is used.
- `high`: the low stream starts first for a fast start. The high stream loads on top of it, and takes over once it is really playing. The low stream is then released.
- `auto`: like `high`, but falls back to low when the network looks poor, and tries high again after `retry_high_seconds`. "Poor" means the browser reports data saver, a 3G or slower connection, or a downlink below `min_downlink_mbps` (Network Information API, Chromium only), or the high stream stalls `stall_limit` times in 30 s or buffers for more than 5 s. If high has not started after 20 s, it gives up for a while.

Defaults: tiles in the grid stay on `low` (small tiles, many streams), and full screen uses `auto`. Set `grid_quality: auto` to upgrade grid tiles as well. Cameras with only one source are unaffected.

## Behavior

- The overlay opens on every state transition into the trigger state (off → on → off → on fires twice), while the dashboard is open in a browser. It does not open if the entity was already `on` at page load, since no transition happens.
- If the overlay is closed while the trigger is still `on`, it reopens only on the next transition into `on`.
- If another camera's trigger fires while an overlay is open, the overlay switches to that camera.
- Tapping a tile opens that camera as an overlay.
- Full screen reuses the tile that is already in the grid (lifted into the browser's top layer via the Popover API, with a `position:fixed` fallback), so the running stream is not remounted or reconnected. The other tiles keep streaming in the background. It is not the browser Fullscreen API, which browsers block without a user gesture.

## Limitations

- go2rtc streams: the go2rtc host must be reachable from the browser; the card connects to `<go2rtc_url>/api/ws?src=<stream>` over WebSocket. No scripts are loaded from go2rtc.
- For camera entities the card finds the `<video>` inside Home Assistant's own view to see when a stream is playing or stalling. This relies on Home Assistant's internal DOM, so a future frontend change could break the upgrade/fallback (the camera then stays on low).
- Camera entities: shown through Home Assistant's built-in picture-entity live view (WebRTC/HLS as HA decides), so what plays depends on your camera integration. Tiles are live-only, with no PTZ or other controls.

## Credits

The bundled player is go2rtc's `video-rtc.js` (MIT, Copyright (c) 2022 Alexey Khit, <https://github.com/AlexxIT/go2rtc>).

## License

MIT, see [LICENSE](LICENSE).
