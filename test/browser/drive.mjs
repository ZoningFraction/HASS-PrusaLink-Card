// Browser tests against a fake hass. Nothing reaches Home Assistant.
// Run: CHROMIUM=/usr/bin/chromium-browser PLAYWRIGHT_CORE=/path/to/playwright-core npm run test:browser
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SHOTS = fileURLToPath(new URL("./shots/", import.meta.url));
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript" };
mkdirSync(SHOTS, { recursive: true });

let chromium;
try {
  ({ chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_CORE ?? "playwright-core"));
} catch {
  console.error("playwright-core not found. Install it or set PLAYWRIGHT_CORE.");
  process.exit(2);
}

const server = createServer(async (req, res) => {
  const path = normalize(join(ROOT, decodeURIComponent(new URL(req.url, "http://localhost").pathname)));
  if (!path.startsWith(ROOT)) return res.writeHead(403).end();
  try {
    res.writeHead(200, { "content-type": TYPES[extname(path)] ?? "application/octet-stream" }).end(await readFile(path));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

const results = [];
const check = (name, ok, detail = "") => results.push({ name, ok: Boolean(ok), detail });
const eq = (name, actual, expected) =>
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`);

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM, headless: true });
const page = await browser.newPage({ viewport: { width: 520, height: 700 }, deviceScaleFactor: 2 });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));
page.on("console", (m) => m.type() === "error" && pageErrors.push(`console: ${m.text()}`));

const shutdown = async (code) => {
  await browser.close();
  server.close();
  process.exit(code);
};

await page.goto(`http://127.0.0.1:${server.address().port}/test/browser/index.html`);
await page.waitForFunction(() => window.__ready === true, null, { timeout: 15000 }).catch(async (e) => {
  console.error("harness never became ready", e.message, pageErrors);
  await shutdown(2);
});
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(800);

const ev = (fn, arg) => page.evaluate(fn, arg);
const scenario = (name) => ev((n) => setScenario(n), name);
const click = (action) => ev((a) => clickAction(a), action);
const calls = () => ev(() => __calls.map((c) => [c[0], c[1], c[2].entity_id]));
const shot = (name) => page.locator("#wrap").screenshot({ path: `${SHOTS}${name}.png` });
const isThumb = (src) => typeof src === "string" && src.startsWith("data:image/svg+xml");
const state = () => ev(() => ({
  badge: $c(".badge").textContent,
  headline: $c(".headline").textContent,
  subtitle: $c(".subtitle").hidden ? null : $c(".subtitle").textContent,
  barHidden: $c(".bar").hidden,
  file: $c(".file").hidden ? null : $c(".file span").textContent,
  chips: $$c(".chip").map((c) => c.textContent.trim()),
  actions: $$c(".actions [data-action]").map((b) => b.dataset.action),
  switchDisabled: $c(".switch").disabled,
  switchOn: $c(".switch").getAttribute("aria-checked"),
  hintIcon: $c(".hint ha-icon")?.getAttribute("icon") ?? null,
  hintText: $c(".hint").textContent,
  dialog: !$c(".dialog").hidden,
  dialogTitle: $c(".dialog strong").textContent,
  detail: $c(".dialog .detail").hidden ? null : $c(".dialog .detail").textContent,
  img: $c(".media img")?.getAttribute("src") ?? null,
  mediaIcon: $c(".media > ha-icon")?.getAttribute("icon") ?? null,
  liveTag: $c(".live-tag")?.textContent ?? null,
  error: $c(".error").textContent,
  cardClass: $c("ha-card").className,
  stream: { ...__stream, configs: undefined },
}));
const header = () => ev(() => ({
  badgeShown: getComputedStyle($c(".badge")).display !== "none",
  powerShown: getComputedStyle($c(".power")).display !== "none",
  offClass: $c("ha-card").classList.contains("off"),
}));
const baseConfig = {
  name: "Prusa CORE One", prefix: "prusa_core_one", camera: "camera.basement_buddy3d",
  power_switch: "switch.plug_01", power_sensor: "sensor.plug_01_power",
};

let s = await state();
eq("printing badge", s.badge, "Printing");
eq("printing headline", s.headline, "2 %");
check("printing subtitle", /^5 h 4\d min left · ETA \d\d:\d\d$/.test(s.subtitle), s.subtitle);
eq("printing chips", s.chips, ["250/250 °C", "85/85 °C", "PETG", "106 W", "23 min"]);
eq("printing buttons", s.actions, ["pause", "cancel", "live"]);
eq("printing locks the switch", [s.switchDisabled, s.switchOn, s.hintIcon], [true, "true", "mdi:lock"]);
check("printing thumbnail", isThumb(s.img), s.img);
eq("printing file name", s.file, "frame_leftreartop_0.2mm_PETG_COREONE_5h53m.gcode");
eq("printing has no error", s.error, "");
await shot("1-printing");

eq("locked power click is ignored", await click("power"), "disabled");
eq("locked power click opens no dialog", (await state()).dialog, false);
eq("rendering calls no services", await calls(), []);

await click("cancel");
eq("cancel shows a confirmation", (await state()).actions, ["cancel-no", "cancel-yes"]);
// textContent would join the button labels.
eq("cancel confirmation text", await ev(() => ({
  prompt: [...$c(".confirm").childNodes].filter((n) => n.nodeName !== "DIV").map((n) => n.textContent).join("").replace(/\s+/g, " ").trim(),
  labels: $$c(".confirm button").map((b) => b.textContent.trim()),
})), { prompt: "Cancel this print? It can't be resumed.", labels: ["Keep printing", "Yes, cancel"] });
eq("cancel presses nothing yet", await calls(), []);
await shot("2-cancel-confirm");
await scenario("printing");
eq("confirmation survives a hass update", (await state()).actions, ["cancel-no", "cancel-yes"]);
await click("cancel-no");
eq("keep printing restores the buttons", (await state()).actions, ["pause", "cancel", "live"]);
eq("keep printing presses nothing", await calls(), []);
await click("cancel");
await page.waitForTimeout(10500);
eq("confirmation reverts after 10 s", (await state()).actions, ["pause", "cancel", "live"]);
eq("revert presses nothing", await calls(), []);
await click("cancel");
await click("cancel-yes");
eq("yes presses cancel once", await calls(), [["button", "press", "button.prusa_core_one_cancel_job"]]);
await click("pause");
eq("pause is one tap", (await calls()).at(-1), ["button", "press", "button.prusa_core_one_pause_job"]);

await ev(() => { __calls.length = 0; window.__videoReady = 0; });
await click("live");
await page.waitForFunction(() => __stream.connected === 1);
const liveMedia = () => ev(() => {
  const loader = $c(".media .loader");
  const stream = $c(".media fake-stream");
  return {
    loader: loader !== null && !loader.hidden,
    ratio: getComputedStyle($c(".media")).aspectRatio,
    radius: getComputedStyle(stream).getPropertyValue("--ha-card-border-radius").trim(),
    border: getComputedStyle(stream).getPropertyValue("--ha-card-border-width").trim(),
    shadow: getComputedStyle(stream).getPropertyValue("--ha-card-box-shadow").trim(),
  };
});
eq("loader shows until the stream has a frame", await liveMedia(), { loader: true, ratio: "16 / 9", radius: "0", border: "0", shadow: "none" });
await shot("3-live-loading");
await ev(() => { window.__videoReady = 2; });
await page.waitForTimeout(1200);
eq("loader hides when the stream has a frame", (await liveMedia()).loader, false);
s = await state();
eq("live stream config", await ev(() => __stream.configs[0]), {
  type: "picture-entity", entity: "camera.basement_buddy3d", camera_view: "live", aspect_ratio: "16:9",
  show_name: false, show_state: false, tap_action: { action: "none" }, hold_action: { action: "none" },
});
check("live countdown", /^LIVE (5:00|4:5\d)$/.test(s.liveTag), s.liveTag);
eq("stop replaces live", s.actions, ["pause", "cancel", "live-stop"]);
eq("stream replaces the thumbnail", s.img, null);
await page.waitForTimeout(1200);
await shot("3-live");
await scenario("printing");
eq("stream survives a hass update", (await state()).stream, { connected: 1, disconnected: 0 });
await click("live-stop");
s = await state();
eq("stop removes the stream", s.stream, { connected: 1, disconnected: 1 });
check("thumbnail returns after stop", isThumb(s.img), s.img);

await click("live");
await page.waitForFunction(() => __stream.connected === 2);
await ev(() => {
  Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
  document.dispatchEvent(new Event("visibilitychange"));
});
eq("hidden tab stops the stream", (await state()).stream, { connected: 2, disconnected: 2 });
await ev(() => { delete document.hidden; });

await click("live");
await page.waitForFunction(() => __stream.connected === 3);
await ev(() => {
  const spacer = document.createElement("div");
  spacer.id = "spacer";
  spacer.style.height = "4000px";
  document.body.append(spacer);
  window.scrollTo(0, 3000);
});
await page.waitForFunction(() => __stream.disconnected === 3, null, { timeout: 3000 }).catch(() => {});
eq("scrolling away stops the stream", (await state()).stream, { connected: 3, disconnected: 3 });
await ev(() => { document.getElementById("spacer").remove(); window.scrollTo(0, 0); });

await ev((c) => card.setConfig({ ...c, live_timeout: 2 }), baseConfig);
await click("live");
await page.waitForFunction(() => __stream.connected === 4);
await page.waitForTimeout(3500);
s = await state();
eq("timeout stops the stream", s.stream, { connected: 4, disconnected: 4 });
eq("timeout restores the Live button", s.actions, ["pause", "cancel", "live"]);
await ev((c) => card.setConfig(c), baseConfig);

await click("live");
await page.waitForFunction(() => __stream.connected === 5);
await scenario("off");
eq("plug off stops the stream", (await state()).stream, { connected: 5, disconnected: 5 });
eq("live calls no services", await calls(), []);

await scenario("printing");
await ev(() => { window.__videoReady = 0; });
await click("live");
await page.waitForFunction(() => __stream.connected === 6);
await page.waitForTimeout(16000);
eq("loader gives way after 15 s without a frame", (await liveMedia()).loader, false);
await click("live-stop");

await scenario("paused");
eq("paused buttons", (await state()).actions, ["resume", "cancel", "live"]);
await scenario("attention");
s = await state();
eq("attention view", [s.badge, s.headline, s.subtitle, s.actions], ["Attention", "37 %", "Check the printer's screen", ["continue", "cancel", "live"]]);
await shot("4-attention");

await scenario("finished_hot");
s = await state();
eq("finished badge, headline and buttons", [s.badge, s.headline, s.actions], ["Finished", "100 %", ["live"]]);
check("finished shows when it ended", /^Done at \d\d:\d\d$/.test(s.subtitle), s.subtitle);
eq("hot nozzle locks power", [s.switchDisabled, s.hintIcon, s.hintText], [true, "mdi:coolant-temperature", "78 °C"]);
eq("finished chips", s.chips, ["78 °C", "61 °C", "PETG", "24 W"]);
eq("hot power click is ignored", await click("power"), "disabled");
await shot("5-finished-hot");

await scenario("idle_cool");
s = await state();
eq("idle badge and headline", [s.badge, s.headline], ["Idle", "Ready"]);
eq("idle shows a placeholder", [s.img, s.mediaIcon, s.barHidden, s.file], [null, "mdi:printer-3d", true, null]);
eq("idle switch is unlocked", [s.switchDisabled, s.hintIcon], [false, null]);
await click("power");
s = await state();
eq("idle power opens the dialog", [s.dialog, s.dialogTitle, s.detail], [true, "Turn off the printer?", null]);
eq("dialog presses nothing", await calls(), []);
await shot("6-idle-turn-off");
await click("power-no");
eq("keep on closes the dialog", (await state()).dialog, false);
await click("power");
await scenario("printing");
eq("dialog closes when a job starts", (await state()).dialog, false);
await click("power-yes");
eq("stale turn off is refused", await calls(), []);
await scenario("idle_cool");
await click("power-yes");
eq("yes without a dialog is refused", await calls(), []);
await scenario("printing");
await ev(() => card._act("cancel-yes"));
eq("yes without a cancel prompt is refused", await calls(), []);
await scenario("idle_cool");
await click("power");
await click("power-yes");
eq("turn off calls once", await calls(), [["homeassistant", "turn_off", "switch.plug_01"]]);

await scenario("unreachable");
s = await state();
eq("unreachable badge and chips", [s.badge, s.headline, s.chips], ["Unavailable", "Unavailable", ["106 W"]]);
await click("power");
s = await state();
eq("unreachable dialog warns", [s.dialog, s.detail], [true, "Printer state unknown (106 W)"]);
await click("power-no");

await ev(() => { __calls.length = 0; });
await scenario("off");
s = await state();
check("off collapses the card", s.cardClass.includes("off"), s.cardClass);
eq("off badge and switch", [s.badge, s.switchOn, s.switchDisabled], ["Off", "false", false]);
await shot("7-off");
await click("power");
s = await state();
eq("turn on is one tap", [s.dialog, await calls()], [false, [["homeassistant", "turn_on", "switch.plug_01"]]]);

await scenario("missing");
s = await state();
eq("missing entities are listed", s.error, "Missing entities: sensor.prusa_core_one_nozzle_temperature, sensor.prusa_core_one_heatbed_target_temperature");
check("missing entities hide the body", s.cardClass.includes("broken"), s.cardClass);
eq("missing entities hide badge and power", await header(), { badgeShown: false, powerShown: false, offClass: false });
await shot("8-missing");
await ev(() => { __calls.length = 0; });
await click("power");
await click("power-yes");
eq("missing entities refuse power", [(await state()).dialog, await calls()], [false, []]);

await scenario("missing_state");
await click("power");
await click("power-yes");
eq("missing state sensor refuses power", [(await state()).dialog, await calls()], [false, []]);

await scenario("printing");
eq("card recovers", [(await state()).error, (await state()).badge], ["", "Printing"]);
eq("header returns", await header(), { badgeShown: true, powerShown: true, offClass: false });

eq("no page errors", pageErrors, []);

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? "ok  " : "FAIL"} ${r.name}${r.ok ? "" : `  ${r.detail}`}`);
console.log(`\n${results.length - failed.length}/${results.length} passed. Screenshots are in ${SHOTS}`);
await shutdown(failed.length ? 1 : 0);
