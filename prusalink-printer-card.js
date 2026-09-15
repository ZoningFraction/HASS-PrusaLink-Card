export const DEFAULTS = Object.freeze({ live_timeout: 300, cool_temperature: 50 });

const ABSENT = new Set(["unavailable", "unknown", ""]);

export function deriveEntities(config) {
  const p = config.prefix;
  const entities = {
    state: `sensor.${p}`,
    progress: `sensor.${p}_progress`,
    filename: `sensor.${p}_filename`,
    print_start: `sensor.${p}_print_start`,
    print_finish: `sensor.${p}_print_finish`,
    material: `sensor.${p}_material`,
    nozzle: `sensor.${p}_nozzle_temperature`,
    nozzle_target: `sensor.${p}_nozzle_target_temperature`,
    bed: `sensor.${p}_heatbed_temperature`,
    bed_target: `sensor.${p}_heatbed_target_temperature`,
    preview: `camera.${p}_preview`,
    pause: `button.${p}_pause_job`,
    resume: `button.${p}_resume_job`,
    continue: `button.${p}_continue_job`,
    cancel: `button.${p}_cancel_job`,
  };
  for (const key of ["camera", "power_switch", "power_sensor"]) {
    if (config[key]) entities[key] = config[key];
  }
  return entities;
}

export function missingEntities(states, entities) {
  return Object.values(entities).filter((id) => !(id in states));
}

export function toText(stateObj) {
  if (!stateObj || ABSENT.has(stateObj.state ?? "")) return null;
  return String(stateObj.state);
}

export function toNumber(stateObj) {
  const n = Number(toText(stateObj) ?? NaN);
  return Number.isFinite(n) ? n : null;
}

export function toDate(stateObj) {
  const date = new Date(toText(stateObj) ?? NaN);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatDuration(ms) {
  const minutes = Math.max(0, Math.floor(ms / 60000));
  if (minutes < 1) return "<1 min";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

export function formatClock(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatTemp(current, target) {
  if (current === null) return null;
  const cur = Math.round(current);
  return target ? `${cur}/${Math.round(target)} °C` : `${cur} °C`;
}

export function formatCountdown(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

const LOCKED_STATES = new Set(["printing", "paused", "attention", "busy"]);
const JOB_STATES = new Set(["printing", "paused", "attention", "finished", "stopped"]);

export const BADGES = Object.freeze({
  printing: ["Printing", "ok"],
  paused: ["Paused", "warn"],
  attention: ["Attention", "warn"],
  busy: ["Busy", "neutral"],
  finished: ["Finished", "done"],
  stopped: ["Stopped", "neutral"],
  idle: ["Idle", "neutral"],
  ready: ["Ready", "neutral"],
  error: ["Error", "error"],
});

export function readSnapshot(states, entities) {
  const get = (key) => states[entities[key]];
  const printer = get("state");
  const material = toText(get("material"));
  return {
    printerState: toText(printer) ?? "unavailable",
    stateChangedAt: printer?.last_changed ? new Date(printer.last_changed) : null,
    plugState: entities.power_switch ? (get("power_switch")?.state ?? "unavailable") : null,
    powerW: toNumber(get("power_sensor")),
    nozzle: toNumber(get("nozzle")),
    nozzleTarget: toNumber(get("nozzle_target")),
    bed: toNumber(get("bed")),
    bedTarget: toNumber(get("bed_target")),
    progress: toNumber(get("progress")),
    filename: toText(get("filename")),
    // PrusaLink reports "---" when no filament is loaded.
    material: material && !/^-+$/.test(material) ? material : null,
    printStart: toDate(get("print_start")),
    printFinish: toDate(get("print_finish")),
    hasCamera: Boolean(entities.camera),
  };
}

export function computePower(snap, coolTemperature = DEFAULTS.cool_temperature) {
  if (snap.plugState === null) return { visible: false };
  const power = {
    visible: true, on: snap.plugState === "on", locked: false, reason: null,
    temp: null, confirm: false, unknownState: false, powerW: snap.powerW,
  };
  if (snap.plugState === "off") return power;
  if (snap.plugState !== "on") return { ...power, locked: true, reason: "unavailable" };
  if (LOCKED_STATES.has(snap.printerState)) return { ...power, locked: true, reason: "job" };
  // Cutting power stops the hotend fan.
  if (snap.nozzle !== null && snap.nozzle >= coolTemperature) {
    return { ...power, locked: true, reason: "hot", temp: Math.round(snap.nozzle) };
  }
  return { ...power, confirm: true, unknownState: !Object.hasOwn(BADGES, snap.printerState) };
}

export function powerHint(power, coolTemperature = DEFAULTS.cool_temperature) {
  if (!power.visible || !power.locked) return null;
  if (power.reason === "hot") {
    return { icon: "mdi:coolant-temperature", text: `${power.temp} °C`, title: `Locked until the nozzle is below ${coolTemperature} °C` };
  }
  if (power.reason === "job") return { icon: "mdi:lock", text: "", title: "Locked while a job is active" };
  return { icon: "mdi:lock", text: "", title: "Plug unavailable" };
}

export function powerOffDetail(power) {
  if (!power.unknownState) return null;
  return power.powerW === null ? "Printer state unknown" : `Printer state unknown (${Math.round(power.powerW)} W)`;
}

const JOB_BUTTONS = Object.freeze({
  printing: ["pause", "cancel"],
  paused: ["resume", "cancel"],
  attention: ["continue", "cancel"],
});

const BUTTONS = Object.freeze({
  pause: { icon: "mdi:pause", label: "Pause" },
  resume: { icon: "mdi:play", label: "Resume" },
  continue: { icon: "mdi:play-circle", label: "Continue" },
  cancel: { icon: "mdi:cancel", label: "Cancel" },
  live: { icon: "mdi:video", label: "Live" },
});

function subtitleFor(snap, now) {
  switch (snap.printerState) {
    case "printing":
    case "paused":
      return snap.printFinish
        ? `${formatDuration(snap.printFinish - now)} left · ETA ${formatClock(snap.printFinish)}`
        : null;
    case "attention":
    case "error":
      return "Check the printer's screen";
    // PrusaLink clears start and finish when a job ends.
    case "finished":
      return snap.stateChangedAt ? `Done at ${formatClock(snap.stateChangedAt)}` : null;
    case "stopped":
      return snap.stateChangedAt ? `Stopped at ${formatClock(snap.stateChangedAt)}` : null;
    default:
      return null;
  }
}

function chipsFor(snap, now) {
  const chips = [];
  const add = (key, icon, text) => text && chips.push({ key, icon, text });
  add("nozzle", "mdi:printer-3d-nozzle-heat", formatTemp(snap.nozzle, snap.nozzleTarget));
  add("bed", "mdi:heating-coil", formatTemp(snap.bed, snap.bedTarget));
  add("material", "mdi:palette-swatch-variant", snap.material);
  add("power", "mdi:flash", snap.powerW === null ? null : `${Math.round(snap.powerW)} W`);
  const running = snap.printerState === "printing" || snap.printerState === "paused";
  add("elapsed", "mdi:timer-outline", running && snap.printStart ? formatDuration(now - snap.printStart) : null);
  return chips;
}

export function computeView(snap, now, { coolTemperature = DEFAULTS.cool_temperature } = {}) {
  const power = computePower(snap, coolTemperature);
  if (snap.plugState === "off") {
    return {
      mode: "off", badge: { label: "Off", tone: "off" }, headline: null, subtitle: null,
      progress: null, job: false, filename: null, chips: [], buttons: [], power,
    };
  }
  const st = snap.printerState;
  const known = Object.hasOwn(BADGES, st);
  const [label, tone] = known ? BADGES[st] : ["Unavailable", "neutral"];
  const job = JOB_STATES.has(st) || (st === "busy" && snap.filename !== null);
  let headline = label;
  if (st === "idle" || st === "ready") headline = "Ready";
  if (job && snap.progress !== null) headline = `${Math.round(snap.progress)} %`;
  const keys = [...(Object.hasOwn(JOB_BUTTONS, st) ? JOB_BUTTONS[st] : []), ...(snap.hasCamera ? ["live"] : [])];
  return {
    mode: "full",
    badge: { label, tone },
    headline,
    subtitle: subtitleFor(snap, now),
    progress: job ? snap.progress : null,
    job,
    filename: job ? snap.filename : null,
    chips: chipsFor(snap, now),
    buttons: keys.map((key) => ({ key, ...BUTTONS[key] })),
    power,
  };
}

const CSS = `
  :host { display: block; --pl-accent: var(--prusalink-accent, #fa6831); }
  [hidden] { display: none !important; }
  ha-card { padding: 12px 14px; position: relative; overflow: hidden; }
  .head { display: flex; align-items: center; gap: 8px; }
  .printer-icon { color: var(--pl-accent); --mdc-icon-size: 22px; }
  .off .printer-icon { color: var(--disabled-text-color, #888); }
  .name { flex: 1; font-weight: 500; font-size: 1.1em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .badge { border-radius: 10px; padding: 1px 8px; font-size: 0.8em; background: var(--secondary-background-color); color: var(--secondary-text-color); white-space: nowrap; }
  .badge.tone-ok { color: var(--success-color, #43a047); background: rgba(var(--rgb-success-color, 67, 160, 71), 0.15); }
  .badge.tone-warn { color: var(--warning-color, #ffa600); background: rgba(var(--rgb-warning-color, 255, 166, 0), 0.15); }
  .badge.tone-done { color: var(--info-color, #039be5); background: rgba(var(--rgb-info-color, 3, 155, 229), 0.15); }
  .badge.tone-error { color: var(--error-color, #db4437); background: rgba(var(--rgb-error-color, 219, 68, 55), 0.15); }
  .power { display: flex; align-items: center; gap: 4px; color: var(--secondary-text-color); font-size: 0.8em; }
  .hint { display: inline-flex; align-items: center; gap: 2px; }
  .hint ha-icon { --mdc-icon-size: 16px; }
  .switch { width: 36px; height: 20px; border-radius: 10px; border: none; padding: 0; position: relative; cursor: pointer; background: var(--switch-unchecked-track-color, #9e9e9e); transition: background 0.2s; }
  .switch::after { content: ""; position: absolute; top: 3px; left: 3px; width: 14px; height: 14px; border-radius: 50%; background: #fff; transition: left 0.2s; }
  .switch[aria-checked="true"] { background: var(--pl-accent); }
  .switch[aria-checked="true"]::after { left: 19px; }
  .switch:disabled { opacity: 0.45; cursor: not-allowed; }
  .body { display: flex; gap: 12px; align-items: center; margin-top: 10px; }
  .body.live { flex-direction: column; align-items: stretch; }
  .media { width: 104px; height: 78px; flex: none; border-radius: 10px; background: var(--secondary-background-color); display: flex; align-items: center; justify-content: center; overflow: hidden; position: relative; }
  .media img { width: 100%; height: 100%; object-fit: contain; }
  .media > ha-icon { --mdc-icon-size: 36px; color: var(--disabled-text-color, #888); }
  .body.live .media { width: 100%; height: auto; aspect-ratio: 16 / 9; display: block; --ha-card-border-radius: 0; --ha-card-border-width: 0; --ha-card-box-shadow: none; }
  .live-tag { position: absolute; left: 8px; top: 8px; z-index: 2; display: flex; align-items: center; gap: 3px; background: rgba(0, 0, 0, 0.6); color: #fff; border-radius: 8px; padding: 1px 7px; font-size: 0.75em; }
  .live-tag ha-icon { --mdc-icon-size: 12px; color: #ff5252; }
  .loader { position: absolute; inset: 0; z-index: 1; display: flex; align-items: center; justify-content: center; background: var(--secondary-background-color); }
  .loader::after { content: ""; width: 28px; height: 28px; border-radius: 50%; border: 3px solid var(--divider-color); border-top-color: var(--pl-accent); animation: spin 0.8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .info { flex: 1; min-width: 0; }
  .headline { font-size: 1.7em; font-weight: 500; line-height: 1.2; }
  .body.live .headline { font-size: 1.2em; }
  .subtitle { color: var(--secondary-text-color); font-size: 0.9em; }
  .bar { height: 6px; border-radius: 3px; background: var(--divider-color); overflow: hidden; margin: 6px 0 4px; }
  .bar > div { height: 100%; width: 0; background: var(--pl-accent); transition: width 0.5s; }
  .bar.tone-warn > div { background: var(--warning-color, #ffa600); }
  .bar.tone-done > div { background: var(--info-color, #039be5); }
  .bar.tone-neutral > div { background: var(--disabled-text-color, #888); }
  .file { display: flex; align-items: center; gap: 4px; color: var(--secondary-text-color); font-size: 0.8em; min-width: 0; }
  .file span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .file ha-icon { --mdc-icon-size: 14px; flex: none; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
  .chip { display: inline-flex; align-items: center; gap: 4px; padding: 3px 10px; border-radius: 14px; background: var(--secondary-background-color); font-size: 0.85em; }
  .chip ha-icon { --mdc-icon-size: 16px; color: var(--state-icon-color, var(--secondary-text-color)); }
  .actions { display: flex; gap: 8px; margin-top: 10px; }
  .actions:empty { display: none; }
  button.act { flex: 1; display: inline-flex; align-items: center; justify-content: center; gap: 4px; padding: 8px 0; border: none; border-radius: 10px; background: var(--secondary-background-color); color: var(--primary-text-color); font: inherit; font-size: 0.9em; cursor: pointer; }
  button.act ha-icon { --mdc-icon-size: 18px; }
  button.warn { color: var(--error-color, #db4437); }
  button.danger { background: var(--error-color, #db4437); color: #fff; }
  .confirm { flex: 1; padding: 10px; border-radius: 10px; border: 1px solid var(--error-color, #db4437); background: rgba(var(--rgb-error-color, 219, 68, 55), 0.08); }
  .row { display: flex; gap: 8px; margin-top: 8px; }
  .dialog { position: absolute; inset: 0; z-index: 2; display: flex; align-items: center; justify-content: center; background: rgba(0, 0, 0, 0.5); }
  .box { width: min(80%, 320px); padding: 14px; border-radius: 12px; background: var(--card-background-color, #fff); box-shadow: 0 6px 20px rgba(0, 0, 0, 0.4); }
  .detail { margin: 6px 0 0; color: var(--secondary-text-color); font-size: 0.9em; }
  .off .body, .off .chips, .off .actions, .broken .body, .broken .chips, .broken .actions { display: none; }
  .error { color: var(--error-color, #db4437); font-size: 0.9em; margin-top: 8px; }
  .error:empty { display: none; }
`;

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const icon = (name, cls = "") => `<ha-icon${cls ? ` class="${cls}"` : ""} icon="${esc(name)}"></ha-icon>`;

// Home Assistant renders the stream inside nested shadow roots.
function hasFrame(el) {
  for (const child of el.shadowRoot?.querySelectorAll("*") ?? []) {
    if (child.tagName === "VIDEO" && child.readyState >= 2) return true;
    if (child.tagName === "IMG" && child.naturalWidth > 0) return true;
    if (hasFrame(child)) return true;
  }
  return false;
}

const Base = globalThis.HTMLElement ?? class {};

export class PrusaLinkPrinterCard extends Base {
  static getStubConfig() {
    return { name: "Prusa CORE One", prefix: "prusa_core_one" };
  }

  setConfig(config) {
    if (!config?.prefix) throw new Error("Set prefix to your PrusaLink entity prefix, for example prusa_core_one");
    this._config = { ...DEFAULTS, ...config };
    this._entities = deriveEntities(this._config);
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    if (this._live?.card) this._live.card.hass = hass;
    this._render();
  }

  getCardSize() {
    return 4;
  }

  getGridOptions() {
    return { columns: 12, min_columns: 6 };
  }

  connectedCallback() {
    this._onVisibility = () => document.hidden && this._stopLive();
    document.addEventListener("visibilitychange", this._onVisibility);
    this._observer = new IntersectionObserver((entries) => {
      if (!entries[entries.length - 1].isIntersecting) this._stopLive();
    });
    this._observer.observe(this);
  }

  disconnectedCallback() {
    document.removeEventListener("visibilitychange", this._onVisibility);
    this._observer?.disconnect();
    this._stopLive(false);
    this._setConfirm(null);
  }

  _build() {
    this._root = this.attachShadow({ mode: "open" });
    this._root.innerHTML = `<style>${CSS}</style>
      <ha-card>
        <div class="head">
          ${icon("mdi:printer-3d", "printer-icon")}
          <span class="name"></span>
          <span class="badge"></span>
          <span class="power"><span class="hint"></span><button class="switch" role="switch" data-action="power"></button></span>
        </div>
        <div class="body">
          <div class="media"></div>
          <div class="info">
            <div class="headline"></div>
            <div class="subtitle"></div>
            <div class="bar"><div></div></div>
            <div class="file">${icon("mdi:file-image-outline")}<span></span></div>
          </div>
        </div>
        <div class="chips"></div>
        <div class="actions"></div>
        <div class="error"></div>
        <div class="dialog" hidden><div class="box">
          <strong>Turn off the printer?</strong><p class="detail"></p>
          <div class="row"><button class="act" data-action="power-no">Keep on</button><button class="act danger" data-action="power-yes">${icon("mdi:power")}Turn off</button></div>
        </div></div>
      </ha-card>`;
    this._root.addEventListener("click", (ev) => {
      const target = ev.composedPath().find((el) => el.dataset?.action);
      if (target && !target.disabled) this._act(target.dataset.action);
    });
  }

  _$(selector) {
    return this._root.querySelector(selector);
  }

  _setHtml(selector, html) {
    const el = this._$(selector);
    if (el._html !== html) {
      el.innerHTML = html;
      el._html = html;
    }
  }

  _freshView() {
    const snap = readSnapshot(this._hass.states, this._entities);
    return computeView(snap, new Date(), { coolTemperature: this._config.cool_temperature });
  }

  _render() {
    if (!this._config || !this._hass) return;
    if (!this._root) this._build();
    const card = this._$("ha-card");
    const missing = missingEntities(this._hass.states, this._entities);
    card.classList.toggle("broken", missing.length > 0);
    this._$(".error").textContent = missing.length ? `Missing entities: ${missing.join(", ")}` : "";
    this._$(".name").textContent = this._config.name ?? "Printer";
    this._$(".badge").hidden = missing.length > 0;
    if (missing.length) {
      card.classList.remove("off");
      this._$(".power").hidden = true;
      this._$(".dialog").hidden = true;
      this._stopLive(false);
      this._setConfirm(null);
      return;
    }

    const view = this._freshView();
    this._view = view;
    const offers = (key) => view.buttons.some((b) => b.key === key);
    if (this._live && !offers("live")) this._stopLive(false);
    if (this._confirm === "cancel" && !offers("cancel")) this._setConfirm(null);
    if (this._confirm === "power" && !(view.power.on && view.power.confirm)) this._setConfirm(null);

    card.classList.toggle("off", view.mode === "off");
    const badge = this._$(".badge");
    badge.textContent = view.badge.label;
    badge.className = `badge tone-${view.badge.tone}`;
    this._renderPower(view.power);

    this._$(".headline").textContent = view.headline ?? "";
    const subtitle = this._$(".subtitle");
    subtitle.textContent = view.subtitle ?? "";
    subtitle.hidden = !view.subtitle;
    const bar = this._$(".bar");
    bar.hidden = view.progress === null;
    bar.className = `bar tone-${view.badge.tone}`;
    bar.firstElementChild.style.width = `${Math.min(100, Math.max(0, view.progress ?? 0))}%`;
    const file = this._$(".file");
    file.hidden = !view.filename;
    file.title = view.filename ?? "";
    file.lastElementChild.textContent = view.filename ?? "";

    this._renderMedia();
    this._setHtml(".chips", view.chips.map((c) => `<span class="chip">${icon(c.icon)}${esc(c.text)}</span>`).join(""));
    this._renderActions(view);

    const dialog = this._$(".dialog");
    dialog.hidden = this._confirm !== "power";
    const detail = powerOffDetail(view.power);
    const detailEl = dialog.querySelector(".detail");
    detailEl.textContent = detail ?? "";
    detailEl.hidden = !detail;
  }

  _renderPower(power) {
    const wrap = this._$(".power");
    wrap.hidden = !power.visible;
    if (!power.visible) return;
    const sw = this._$(".switch");
    const hint = powerHint(power, this._config.cool_temperature);
    sw.setAttribute("aria-checked", String(power.on));
    sw.disabled = power.locked;
    sw.title = hint?.title ?? (power.on ? "Turn off" : "Turn on");
    this._setHtml(".hint", hint ? `${icon(hint.icon)}${esc(hint.text)}` : "");
  }

  _renderMedia() {
    const media = this._$(".media");
    this._$(".body").classList.toggle("live", Boolean(this._live));
    if (this._live) {
      if (!media.querySelector(".loader")) {
        const loader = document.createElement("div");
        loader.className = "loader";
        const tag = document.createElement("span");
        tag.className = "live-tag";
        media.replaceChildren(loader, tag);
      }
      if (this._live.card && !media.contains(this._live.card)) media.prepend(this._live.card);
      media.querySelector(".loader").hidden = this._live.ready;
      media.querySelector(".live-tag").innerHTML = `${icon("mdi:record")}LIVE ${formatCountdown(this._live.until - Date.now())}`;
      return;
    }
    // The URL token rotates, so load the thumbnail once per file.
    const preview = this._hass.states[this._entities.preview];
    const picture = this._view.job && preview && !ABSENT.has(preview.state) ? preview.attributes.entity_picture : null;
    const key = picture ? `thumb:${this._view.filename}` : "placeholder";
    if (key === this._mediaKey) return;
    this._mediaKey = key;
    if (!picture) {
      media.innerHTML = icon("mdi:printer-3d");
      return;
    }
    const img = document.createElement("img");
    img.alt = "";
    img.addEventListener("error", () => {
      media.innerHTML = icon("mdi:printer-3d");
    });
    img.src = picture;
    media.replaceChildren(img);
  }

  _renderActions(view) {
    if (this._confirm === "cancel") {
      this._setHtml(".actions", `<div class="confirm"><strong>Cancel this print?</strong> It can't be resumed.
        <div class="row"><button class="act" data-action="cancel-no">Keep printing</button><button class="act danger" data-action="cancel-yes">${icon("mdi:cancel")}Yes, cancel</button></div></div>`);
      return;
    }
    this._setHtml(".actions", view.buttons.map((b) => {
      if (b.key === "live" && this._live) return `<button class="act" data-action="live-stop">${icon("mdi:video-off")}Stop</button>`;
      return `<button class="act${b.key === "cancel" ? " warn" : ""}" data-action="${b.key}">${icon(b.icon)}${esc(b.label)}</button>`;
    }).join(""));
  }

  _act(action) {
    // A missing sensor would read as unlocked.
    if (missingEntities(this._hass.states, this._entities).length) return;
    // Use the current state, not the last render.
    const view = this._freshView();
    const offers = (key) => view.buttons.some((b) => b.key === key);
    switch (action) {
      case "pause":
      case "resume":
      case "continue":
        if (offers(action)) this._hass.callService("button", "press", { entity_id: this._entities[action] });
        break;
      case "cancel":
        if (offers("cancel")) this._setConfirm("cancel");
        break;
      case "cancel-yes":
        if (this._confirm === "cancel" && offers("cancel")) {
          this._hass.callService("button", "press", { entity_id: this._entities.cancel });
        }
        this._setConfirm(null);
        break;
      case "cancel-no":
      case "power-no":
        this._setConfirm(null);
        break;
      case "power":
        if (!view.power.visible || view.power.locked) break;
        if (!view.power.on) this._hass.callService("homeassistant", "turn_on", { entity_id: this._entities.power_switch });
        else if (view.power.confirm) this._setConfirm("power");
        break;
      case "power-yes":
        if (this._confirm === "power" && view.power.on && view.power.confirm && !view.power.locked) {
          this._hass.callService("homeassistant", "turn_off", { entity_id: this._entities.power_switch });
        }
        this._setConfirm(null);
        break;
      case "live":
        this._startLive();
        break;
      case "live-stop":
        this._stopLive(false);
        break;
    }
    this._render();
  }

  _setConfirm(kind) {
    clearTimeout(this._confirmTimer);
    this._confirm = kind;
    if (kind) {
      this._confirmTimer = setTimeout(() => {
        this._confirm = null;
        this._render();
      }, 10000);
    }
  }

  async _startLive() {
    if (this._live || !this._entities.camera) return;
    const started = Date.now();
    const live = { until: started + this._config.live_timeout * 1000, card: null, ready: false, timer: null };
    this._live = live;
    live.timer = setInterval(() => {
      if (Date.now() >= live.until) return this._stopLive();
      // After 15 s, show whatever Home Assistant renders, such as a stream error.
      live.ready ||= Date.now() - started > 15000 || Boolean(live.card && hasFrame(live.card));
      this._renderMedia();
    }, 500);
    const helpers = await window.loadCardHelpers();
    // Removing this card from the DOM ends the stream.
    const card = await helpers.createCardElement({
      type: "picture-entity",
      entity: this._entities.camera,
      camera_view: "live",
      aspect_ratio: "16:9",
      show_name: false,
      show_state: false,
      tap_action: { action: "none" },
      hold_action: { action: "none" },
    });
    if (this._live !== live) return;
    card.hass = this._hass;
    live.card = card;
    this._render();
  }

  _stopLive(rerender = true) {
    const live = this._live;
    if (!live) return;
    this._live = null;
    clearInterval(live.timer);
    live.card?.remove();
    this._mediaKey = null;
    if (rerender) this._render();
  }
}

if (globalThis.customElements && !customElements.get("prusalink-printer-card")) {
  customElements.define("prusalink-printer-card", PrusaLinkPrinterCard);
  (window.customCards ??= []).push({
    type: "prusalink-printer-card",
    name: "PrusaLink Printer Card",
    description: "Job status, guarded controls and a live camera for PrusaLink printers.",
  });
}
