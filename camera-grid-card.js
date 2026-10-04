/*
 * camera-grid-card
 * Camera grid for go2rtc streams. If one of a camera's trigger entities
 * switches to the trigger state, that camera opens as a single full-screen
 * overlay until a human closes it (X button, Esc, or optional auto-close).
 *
 * Install: copy to /config/www/camera-grid-card.js and add a dashboard
 * resource  /local/camera-grid-card.js  (type: JavaScript module).
 */

const CARD_VERSION = "0.1.0";

const go2rtcLoads = new Map();
function loadGo2rtc(base) {
  base = base.replace(/\/+$/, "");
  if (!go2rtcLoads.has(base)) {
    go2rtcLoads.set(
      base,
      import(`${base}/video-stream.js`).catch((err) => {
        // A second go2rtc host re-defines <video-stream>; harmless.
        if (!customElements.get("video-stream")) {
          go2rtcLoads.delete(base);
          throw err;
        }
      })
    );
  }
  return go2rtcLoads.get(base);
}

function wsUrl(base, stream) {
  const u = new URL(`${base.replace(/\/+$/, "")}/api/ws`);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.searchParams.set("src", stream);
  return u.toString();
}

// Build a <video-stream> for a camera and keep the inner <video> chrome-free.
function makeStream(cam, globalUrl) {
  const base = cam.url || globalUrl;
  const el = document.createElement("video-stream");
  if (!base || !cam.stream) return el;
  loadGo2rtc(base)
    .then(() => {
      el.src = new URL(wsUrl(base, cam.stream));
    })
    .catch((err) => console.error("camera-grid-card: go2rtc load failed", err));
  const tune = () => {
    const v = el.querySelector("video");
    if (v) {
      v.controls = false;
      v.muted = true;
      v.style.pointerEvents = "none";
    }
  };
  new MutationObserver(tune).observe(el, { childList: true });
  tune();
  return el;
}

const STREAM_CSS = `
  video-stream { display:block; width:100%; height:100%; }
  video-stream video { width:100%; height:100%; object-fit: var(--cgc-fit, cover); }
`;

class CameraGridCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._overlay = null;
    this._closeTimer = null;
  }

  static getConfigElement() {
    return document.createElement("camera-grid-card-editor");
  }

  static getStubConfig() {
    return {
      columns: 2,
      go2rtc_url: "http://homeassistant.local:1984",
      cameras: [],
    };
  }

  setConfig(config) {
    if (!config || !Array.isArray(config.cameras)) {
      throw new Error("`cameras` must be a list");
    }
    this._config = {
      columns: 2,
      aspect_ratio: "16:9",
      fit: "cover",
      trigger_state: "on",
      auto_close_seconds: 0,
      show_titles: true,
      ...config,
    };
    this._render();
  }

  set hass(hass) {
    const old = this._hass;
    this._hass = hass;
    if (old && this._config) this._checkTriggers(old, hass);
  }

  getCardSize() {
    const rows = Math.ceil(this._config.cameras.length / this._config.columns);
    return Math.max(1, rows * 3);
  }

  getGridOptions() {
    return { columns: 12, rows: "auto", min_columns: 3 };
  }

  disconnectedCallback() {
    this._closeOverlay();
  }

  _id(cam) {
    return cam.id || cam.stream;
  }

  _checkTriggers(oldHass, hass) {
    const t = this._config.trigger_state;
    const wanted = Array.isArray(t) ? t.map(String) : [String(t)];
    const any = wanted.includes("*");
    for (const cam of this._config.cameras) {
      for (const entity of cam.triggers || []) {
        const prev = oldHass.states[entity];
        const next = hass.states[entity];
        if (prev === next || !next) continue;
        // Fire on every state transition into a wanted state (attribute-only
        // updates are ignored), so off -> on -> off -> on fires each time.
        const changed = !prev || prev.state !== next.state;
        if (changed && (any || wanted.includes(next.state))) {
          this.focusCamera(this._id(cam));
          return;
        }
      }
    }
  }

  _render() {
    const c = this._config;
    const root = this.shadowRoot;
    root.innerHTML = `
      <style>
        ${STREAM_CSS}
        :host { display:block; --cgc-fit:${c.fit}; }
        .grid { display:grid; gap:4px;
                grid-template-columns: repeat(${Number(c.columns) || 2}, 1fr); }
        .tile { position:relative; overflow:hidden; background:#000;
                border-radius: var(--ha-card-border-radius, 12px);
                aspect-ratio:${String(c.aspect_ratio).replace(":", " / ")};
                cursor:pointer; }
        .title { position:absolute; left:8px; bottom:6px; color:#fff;
                 font-size:12px; text-shadow:0 0 4px #000; pointer-events:none; }
        .empty { padding:16px; color:var(--secondary-text-color); }
      </style>
      <div class="grid"></div>`;
    const grid = root.querySelector(".grid");
    if (!c.cameras.length) {
      grid.innerHTML = `<div class="empty">No cameras configured.</div>`;
      return;
    }
    for (const cam of c.cameras) {
      const tile = document.createElement("div");
      tile.className = "tile";
      tile.appendChild(makeStream(cam, c.go2rtc_url));
      if (c.show_titles && cam.title) {
        const t = document.createElement("div");
        t.className = "title";
        t.textContent = cam.title;
        tile.appendChild(t);
      }
      tile.addEventListener("click", () => this.focusCamera(this._id(cam)));
      grid.appendChild(tile);
    }
  }

  focusCamera(id) {
    const cam = this._config.cameras.find((x) => this._id(x) === id);
    if (!cam) return;
    this._closeOverlay();

    const host = document.createElement("div");
    const sr = host.attachShadow({ mode: "open" });
    sr.innerHTML = `
      <style>
        ${STREAM_CSS}
        :host { position:fixed; inset:0; z-index:99999; background:#000;
                --cgc-fit:contain; }
        .wrap { position:absolute; inset:0; }
        button { position:absolute; top:max(12px, env(safe-area-inset-top));
                 right:12px; width:48px; height:48px; border-radius:50%;
                 border:0; background:rgba(0,0,0,.6); color:#fff;
                 font-size:28px; line-height:1; cursor:pointer; z-index:1; }
        .title { position:absolute; left:16px; top:20px; color:#fff;
                 font:500 16px sans-serif; text-shadow:0 0 4px #000; }
      </style>
      <div class="wrap"></div>
      <div class="title"></div>
      <button aria-label="Close">&times;</button>`;
    sr.querySelector(".wrap").appendChild(makeStream(cam, this._config.go2rtc_url));
    sr.querySelector(".title").textContent = cam.title || "";
    sr.querySelector("button").addEventListener("click", () => this._closeOverlay());

    this._onKey = (e) => e.key === "Escape" && this._closeOverlay();
    window.addEventListener("keydown", this._onKey);
    document.body.appendChild(host);
    this._overlay = host;

    const secs = Number(this._config.auto_close_seconds);
    if (secs > 0) {
      this._closeTimer = setTimeout(() => this._closeOverlay(), secs * 1000);
    }
  }

  _closeOverlay() {
    clearTimeout(this._closeTimer);
    if (this._onKey) window.removeEventListener("keydown", this._onKey);
    this._onKey = null;
    this._overlay?.remove();
    this._overlay = null;
  }
}

/* ---------- Visual editor ---------- */

const EDITOR_SCHEMA = [
  { name: "go2rtc_url", selector: { text: {} } },
  {
    type: "grid",
    name: "",
    schema: [
      { name: "columns", selector: { number: { min: 1, max: 8, mode: "box" } } },
      { name: "aspect_ratio", selector: { text: {} } },
      {
        name: "fit",
        selector: {
          select: {
            mode: "dropdown",
            options: [
              { value: "cover", label: "Cover (crop)" },
              { value: "contain", label: "Contain (letterbox)" },
            ],
          },
        },
      },
      { name: "trigger_state", selector: { text: {} } },
      {
        name: "auto_close_seconds",
        selector: { number: { min: 0, max: 3600, mode: "box", unit_of_measurement: "s" } },
      },
      { name: "show_titles", selector: { boolean: {} } },
    ],
  },
  {
    name: "cameras",
    selector: {
      object: {
        multiple: true,
        label_field: "title",
        fields: {
          title: { label: "Title", selector: { text: {} } },
          stream: { label: "go2rtc stream name", required: true, selector: { text: {} } },
          url: { label: "go2rtc URL (override)", selector: { text: {} } },
          id: { label: "ID (defaults to stream)", selector: { text: {} } },
          triggers: {
            label: "Trigger entities",
            selector: { entity: { multiple: true } },
          },
        },
      },
    },
  },
];

const EDITOR_LABELS = {
  go2rtc_url: "go2rtc base URL (default for all cameras)",
  columns: "Grid columns",
  aspect_ratio: "Tile aspect ratio",
  fit: "Video fit",
  trigger_state: "State that triggers full screen",
  auto_close_seconds: "Auto-close after (0 = manual only)",
  show_titles: "Show titles",
  cameras: "Cameras",
};

class CameraGridCardEditor extends HTMLElement {
  setConfig(config) {
    this._config = config;
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    if (this._form) this._form.hass = hass;
  }

  _render() {
    if (!this._form) {
      this._form = document.createElement("ha-form");
      this._form.computeLabel = (s) => EDITOR_LABELS[s.name] || s.name;
      this._form.addEventListener("value-changed", (ev) => {
        this.dispatchEvent(
          new CustomEvent("config-changed", {
            detail: { config: { ...ev.detail.value, type: this._config.type } },
            bubbles: true,
            composed: true,
          })
        );
      });
      this.appendChild(this._form);
    }
    this._form.hass = this._hass;
    this._form.schema = EDITOR_SCHEMA;
    this._form.data = {
      columns: 2,
      aspect_ratio: "16:9",
      fit: "cover",
      trigger_state: "on",
      auto_close_seconds: 0,
      show_titles: true,
      ...this._config,
    };
  }
}

customElements.define("camera-grid-card", CameraGridCard);
customElements.define("camera-grid-card-editor", CameraGridCardEditor);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "camera-grid-card",
  name: "Camera Grid Card",
  description: "go2rtc camera grid; a camera goes full screen when its trigger entity fires.",
  preview: false,
});

console.info(`%c CAMERA-GRID-CARD %c ${CARD_VERSION} `, "background:#03a9f4;color:#fff", "");
