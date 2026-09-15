import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deriveEntities, missingEntities, toNumber, toDate, toText,
  formatDuration, formatClock, formatTemp, formatCountdown,
  readSnapshot, computePower, powerHint, powerOffDetail, computeView,
} from "../prusalink-printer-card.js";

const at = (h, m) => new Date(2026, 8, 15, h, m);
const NOW = at(11, 18);
const keys = (items) => items.map((i) => i.key);

function snap(overrides = {}) {
  return {
    printerState: "printing",
    stateChangedAt: at(17, 3),
    plugState: "on",
    powerW: 106,
    nozzle: 250.4, nozzleTarget: 250,
    bed: 85, bedTarget: 85,
    progress: 2,
    filename: "frame_leftreartop_0.2mm_PETG_COREONE_5h53m.gcode",
    material: "PETG",
    printStart: at(10, 55),
    printFinish: at(17, 3),
    hasCamera: true,
    ...overrides,
  };
}

test("deriveEntities builds ids from the prefix", () => {
  const e = deriveEntities({ prefix: "prusa_core_one" });
  assert.equal(e.state, "sensor.prusa_core_one");
  assert.equal(e.nozzle_target, "sensor.prusa_core_one_nozzle_target_temperature");
  assert.equal(e.bed, "sensor.prusa_core_one_heatbed_temperature");
  assert.equal(e.preview, "camera.prusa_core_one_preview");
  assert.equal(e.cancel, "button.prusa_core_one_cancel_job");
  assert.equal("camera" in e, false);
  assert.equal("power_switch" in e, false);
});

test("deriveEntities adds optional entities", () => {
  const e = deriveEntities({ prefix: "p", camera: "camera.cam", power_switch: "switch.plug", power_sensor: "sensor.plug_power" });
  assert.equal(e.camera, "camera.cam");
  assert.equal(e.power_switch, "switch.plug");
  assert.equal(e.power_sensor, "sensor.plug_power");
});

test("missingEntities lists ids that are not in hass states", () => {
  const states = { "sensor.a": { state: "1" }, "sensor.b": { state: "unavailable" } };
  assert.deepEqual(missingEntities(states, { a: "sensor.a", b: "sensor.b", c: "sensor.c" }), ["sensor.c"]);
});

test("parsers return null for unavailable, unknown and invalid states", () => {
  assert.equal(toNumber({ state: "250.5" }), 250.5);
  assert.equal(toNumber({ state: "unavailable" }), null);
  assert.equal(toNumber({ state: "abc" }), null);
  assert.equal(toNumber(undefined), null);
  assert.equal(toText({ state: "unknown" }), null);
  assert.equal(toText({ state: "PETG" }), "PETG");
  assert.equal(toDate({ state: "2026-09-15T15:03:00+00:00" }).toISOString(), "2026-09-15T15:03:00.000Z");
  assert.equal(toDate({ state: "unavailable" }), null);
});

test("formatDuration", () => {
  assert.equal(formatDuration(0), "<1 min");
  assert.equal(formatDuration(-5000), "<1 min");
  assert.equal(formatDuration(23 * 60000), "23 min");
  assert.equal(formatDuration(120 * 60000), "2 h");
  assert.equal(formatDuration(345 * 60000 + 59000), "5 h 45 min");
});

test("formatClock pads hours and minutes", () => {
  assert.equal(formatClock(at(7, 5)), "07:05");
  assert.equal(formatClock(at(17, 3)), "17:03");
});

test("formatTemp shows the target only while heating", () => {
  assert.equal(formatTemp(250.4, 250), "250/250 °C");
  assert.equal(formatTemp(78.2, 0), "78 °C");
  assert.equal(formatTemp(78, null), "78 °C");
  assert.equal(formatTemp(null, 250), null);
});

test("formatCountdown", () => {
  assert.equal(formatCountdown(272000), "4:32");
  assert.equal(formatCountdown(999), "0:01");
  assert.equal(formatCountdown(-1), "0:00");
});

test("readSnapshot maps hass states", () => {
  const e = deriveEntities({ prefix: "p", power_switch: "switch.plug", power_sensor: "sensor.plug_power", camera: "camera.cam" });
  const states = {
    [e.state]: { state: "printing", last_changed: "2026-09-15T09:00:00+00:00" },
    [e.progress]: { state: "2.0" },
    [e.filename]: { state: "part.gcode" },
    [e.print_start]: { state: "2026-09-15T08:55:00+00:00" },
    [e.print_finish]: { state: "unavailable" },
    [e.material]: { state: "---" },
    [e.nozzle]: { state: "250.5" },
    [e.nozzle_target]: { state: "250" },
    [e.bed]: { state: "unavailable" },
    [e.bed_target]: { state: "unknown" },
    "switch.plug": { state: "on" },
    "sensor.plug_power": { state: "106.2" },
  };
  const s = readSnapshot(states, e);
  assert.equal(s.printerState, "printing");
  assert.equal(s.stateChangedAt.toISOString(), "2026-09-15T09:00:00.000Z");
  assert.equal(s.progress, 2);
  assert.equal(s.filename, "part.gcode");
  assert.equal(s.printFinish, null);
  assert.equal(s.material, null);
  assert.equal(s.nozzle, 250.5);
  assert.equal(s.bed, null);
  assert.equal(s.plugState, "on");
  assert.equal(s.powerW, 106.2);
  assert.equal(s.hasCamera, true);
});

test("readSnapshot without a power switch or printer entity", () => {
  const s = readSnapshot({}, deriveEntities({ prefix: "p" }));
  assert.equal(s.plugState, null);
  assert.equal(s.printerState, "unavailable");
  assert.equal(s.hasCamera, false);
});

for (const state of ["printing", "paused", "attention", "busy"]) {
  test(`power off is locked while ${state}`, () => {
    const p = computePower(snap({ printerState: state, nozzle: 25 }));
    assert.equal(p.locked, true);
    assert.equal(p.reason, "job");
    assert.equal(p.confirm, false);
  });
}

test("power off is locked while the nozzle is hot", () => {
  for (const state of ["finished", "stopped", "idle", "error"]) {
    const p = computePower(snap({ printerState: state, nozzle: 78.2 }));
    assert.equal(p.locked, true, state);
    assert.equal(p.reason, "hot");
    assert.equal(p.temp, 78);
  }
});

test("a cool printer can be turned off after a confirmation", () => {
  for (const state of ["idle", "ready", "finished", "stopped", "error"]) {
    const p = computePower(snap({ printerState: state, nozzle: 27 }));
    assert.equal(p.locked, false, state);
    assert.equal(p.confirm, true);
    assert.equal(powerOffDetail(p), null);
  }
});

test("the cooling threshold is configurable", () => {
  assert.equal(computePower(snap({ printerState: "idle", nozzle: 45 }), 40).reason, "hot");
  assert.equal(computePower(snap({ printerState: "idle", nozzle: 45 }), 50).locked, false);
});

test("an unreachable printer can be turned off with a warning", () => {
  const p = computePower(snap({ printerState: "unavailable", nozzle: null }));
  assert.equal(p.locked, false);
  assert.equal(p.confirm, true);
  assert.equal(powerOffDetail(p), "Printer state unknown (106 W)");
});

test("power on is one tap", () => {
  const p = computePower(snap({ plugState: "off", printerState: "unavailable" }));
  assert.equal(p.on, false);
  assert.equal(p.locked, false);
  assert.equal(p.confirm, false);
});

test("an unavailable plug is locked", () => {
  assert.equal(computePower(snap({ plugState: "unavailable" })).reason, "unavailable");
});

test("no power switch means no power control", () => {
  assert.equal(computePower(snap({ plugState: null })).visible, false);
});

test("powerHint explains the lock", () => {
  assert.equal(powerHint(computePower(snap())).icon, "mdi:lock");
  assert.deepEqual(powerHint(computePower(snap({ printerState: "finished", nozzle: 78 }))), {
    icon: "mdi:coolant-temperature", text: "78 °C", title: "Locked until the nozzle is below 50 °C",
  });
  assert.equal(powerHint(computePower(snap({ printerState: "idle", nozzle: 27 }))), null);
});

test("printing shows the running job", () => {
  const v = computeView(snap(), NOW);
  assert.equal(v.mode, "full");
  assert.deepEqual(v.badge, { label: "Printing", tone: "ok" });
  assert.equal(v.headline, "2 %");
  assert.equal(v.subtitle, "5 h 45 min left · ETA 17:03");
  assert.equal(v.progress, 2);
  assert.equal(v.job, true);
  assert.deepEqual(keys(v.buttons), ["pause", "cancel", "live"]);
  assert.deepEqual(v.chips.map((c) => c.text), ["250/250 °C", "85/85 °C", "PETG", "106 W", "23 min"]);
  assert.equal(v.power.locked, true);
});

test("paused and attention change the first button", () => {
  assert.deepEqual(keys(computeView(snap({ printerState: "paused" }), NOW).buttons), ["resume", "cancel", "live"]);
  const a = computeView(snap({ printerState: "attention", printStart: null, printFinish: null }), NOW);
  assert.deepEqual(keys(a.buttons), ["continue", "cancel", "live"]);
  assert.equal(a.subtitle, "Check the printer's screen");
  assert.equal(a.badge.tone, "warn");
  assert.equal(keys(a.chips).includes("elapsed"), false);
});

test("finished and stopped show when they ended", () => {
  const f = computeView(snap({
    printerState: "finished", progress: 100, printStart: null, printFinish: null, nozzle: 78, nozzleTarget: 0,
  }), NOW);
  assert.equal(f.headline, "100 %");
  assert.equal(f.subtitle, "Done at 17:03");
  assert.equal(f.badge.tone, "done");
  assert.deepEqual(keys(f.buttons), ["live"]);
  assert.equal(f.chips[0].text, "78 °C");
  assert.equal(computeView(snap({ printerState: "stopped" }), NOW).subtitle, "Stopped at 17:03");
});

test("idle shows no job", () => {
  const v = computeView(snap({ printerState: "idle", progress: null, filename: null, printStart: null, printFinish: null }), NOW);
  assert.equal(v.headline, "Ready");
  assert.equal(v.job, false);
  assert.equal(v.progress, null);
  assert.equal(v.filename, null);
  assert.equal(v.subtitle, null);
});

test("a plug that is off collapses the card", () => {
  const v = computeView(snap({ plugState: "off", printerState: "unavailable" }), NOW);
  assert.equal(v.mode, "off");
  assert.deepEqual(v.badge, { label: "Off", tone: "off" });
  assert.deepEqual(v.buttons, []);
  assert.equal(v.power.on, false);
});

test("an unreachable printer shows only power", () => {
  const v = computeView(snap({
    printerState: "unavailable", progress: null, filename: null, nozzle: null, nozzleTarget: null,
    bed: null, bedTarget: null, material: null, printStart: null, printFinish: null,
  }), NOW);
  assert.deepEqual(v.badge, { label: "Unavailable", tone: "neutral" });
  assert.equal(v.headline, "Unavailable");
  assert.deepEqual(v.chips.map((c) => c.text), ["106 W"]);
});

test("no camera means no Live button", () => {
  assert.deepEqual(keys(computeView(snap({ hasCamera: false }), NOW).buttons), ["pause", "cancel"]);
});

test("busy counts as a job only with a file", () => {
  assert.equal(computeView(snap({ printerState: "busy" }), NOW).job, true);
  assert.equal(computeView(snap({ printerState: "busy", filename: null }), NOW).job, false);
});
