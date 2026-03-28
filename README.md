# PingDoctor

PingDoctor is a Chrome extension that continuously probes configurable network
targets and tracks outages, latency, and uptime trends.

## Features

- Background checks on a configurable interval (`15s`, `30s`, or `60s`)
- Fully user-defined targets (label, address/URL, enabled/disabled)
- Works with any number of active targets
- Outage log, 24h latency chart, and 7-day heatmap
- Export diagnostics as JSON

Default target set:

1. `Wifi Router` -> `192.168.1.1`
2. `Internet Modem` -> `8.8.8.8`
3. `Internet Site` -> `connectivitycheck.gstatic.com/generate_204`

## Router IP Tips

If your first target is your local router, use your default gateway address.

- Windows: run `ipconfig` and use `Default Gateway`
- macOS: run `route -n get default` and use `gateway`
- Linux: run `ip route` and use the value after `default via`

Common values include `192.168.1.1`, `192.168.0.1`, and `10.0.0.1`.

## Development

Install dependencies:

```bash
npm install
```

Run tests:

```bash
npm test
```

Build extension assets:

```bash
npm run build
```

Recommended day-to-day workflow (no manual rebuild each edit):

1. Start watch build once:

```bash
npm run dev
```

2. In Chrome, load **`dist/`** as the unpacked extension.
3. Make code changes in `src/`; Vite rebuilds to `dist/` automatically.
4. In `chrome://extensions`, click **Reload** on PingDoctor to pick up new built files.
5. Refresh the opened popup/options page tab after reloading the extension.

When you need extension Reload vs just page refresh:

- Background/service worker changes (`src/background/**`): **must Reload extension**
- Manifest changes (`manifest.json`): **must Reload extension**
- Popup/options UI code (`src/popup/**`, `src/options/**`): usually **Reload extension**, then refresh that page
- Pure content in already-open page can appear after page refresh, but safest loop is still Reload + refresh

Quick verify loop:

```bash
npm test
```

## Load In Chrome

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select `dist/` (recommended)

## Settings Behavior

In the options page you can configure each target independently:

- Toggle enabled/disabled
- Rename the label
- Change address/IP/URL

At least one target must be enabled.
