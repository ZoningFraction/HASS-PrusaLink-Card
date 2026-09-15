# PrusaLink Printer Card

A Lovelace card for Prusa printers that use the PrusaLink integration in Home Assistant.
It shows the job thumbnail, progress, time left, temperatures, material and power draw.
It also has job controls and a live camera view.

## Safety

- Power off is locked while a job is active.
- Power off is also locked while the nozzle is hot. Cutting power stops the hotend fan.
- Otherwise power off asks for confirmation. Power on is one tap.
- Cancel asks for confirmation. The prompt closes after 10 seconds.
- If an entity is missing, the card shows an error and offers no controls.
- The camera streams only after you press Live. The stream stops after `live_timeout` seconds. It also stops when the card leaves the screen or the tab is hidden.

The lock only applies to this card. The switch can still be controlled elsewhere in Home Assistant.

## Install

In HACS, add this repository as a custom repository of type Dashboard.
Then download PrusaLink Printer Card.

## Configure

```yaml
type: custom:prusalink-printer-card
name: Prusa CORE One
prefix: prusa_core_one
camera: camera.printer_cam
power_switch: switch.printer
power_sensor: sensor.printer_power
live_timeout: 300
cool_temperature: 50
```

Only `prefix` is required. `live_timeout` is in seconds. `cool_temperature` is in °C.

PrusaLink creates the temperature sensors disabled. Enable these four:
`<prefix>_nozzle_temperature`, `<prefix>_nozzle_target_temperature`, `<prefix>_heatbed_temperature` and `<prefix>_heatbed_target_temperature`.

## Develop

`npm test` runs the unit tests.

`npm run test:browser` runs the card in headless Chromium against a fake Home Assistant.
It needs playwright-core. Set `PLAYWRIGHT_CORE` to use an existing copy. Set `CHROMIUM` to use a system browser.
Screenshots are saved in `test/browser/shots/`.
