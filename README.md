# PingDoctor

PingDoctor exists for the moment when your internet starts acting up and you
need an answer:

Is it my Wi-Fi?
Is it my router?
Is it my ISP?
Or is the wider internet having a bad moment?

PingDoctor gives you a way to watch a few useful checkpoints, such as
your local router and a known internet endpoint, so you can quickly see where
the failure is happening.

It is meant to answer two practical questions:

- What is broken right now?
- Has my connection been unstable over the last day or week?

The extension keeps lightweight HTTP(S) checks running in the background and
turns them into a current-status view plus history.

## What It Shows

- Whether your configured targets are responding right now
- Recent failures and slow responses
- A 48-hour latency and outage chart view
- A 7-day health heatmap
- Exportable diagnostics if you want raw data

## How To Think About The Targets

The default setup is meant to separate local problems from broader internet
problems:

- `Wi-Fi Router`: helps answer whether your network card, or wifi router is working.
- `Internet Check`: helps answer whether your internet service provider is failing.

If both fail, the problem is likely local to your network.
If the router is fine but the internet target fails, the problem is more likely
upstream.

This is not a perfect network analyzer, but it is good at providing fast,
practical signal when your connection feels unreliable.

## Technical Constraints

PingDoctor does not use ICMP ping. A target only works if it accepts HTTP or
HTTPS requests from the browser extension.

Default target set:

1. `Wi-Fi Router` -> `192.168.1.1`
2. `Internet Check` -> `https://connectivitycheck.gstatic.com/generate_204`

## Choosing Good Targets

Use targets that respond over HTTP or HTTPS.

- Good local target: your router web UI or gateway IP, such as `192.168.1.1`
- Good internet target: a stable URL such as `https://connectivitycheck.gstatic.com/generate_204`
- Bad default: `8.8.8.8` by itself. That is a DNS resolver IP, not a general-purpose web endpoint. It doesn't respond at http://8.8.8.8

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

## Docs

- [Publishing guide](./docs/publishing.md)
- [Privacy policy](./docs/privacy-policy.md)

## Settings Behavior

In the options page you can configure each target independently:

- Toggle enabled/disabled
- Rename the label
- Change address/IP/URL

At least one target must be enabled.
