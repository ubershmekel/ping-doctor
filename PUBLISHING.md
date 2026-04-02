# Publishing PingDoctor to the Chrome Web Store

## Prerequisites

- A Google account enrolled in the [Chrome Web Store Developer program](https://chrome.google.com/webstore/devconsole)
  - One-time $5 registration fee required if you have not published before

## 1. Build the release package

```bash
npm run release
```

This produces `ping-doctor-<version>.zip` in the project root. The zip contains the
compiled `dist/` contents (no source maps, no node_modules).

> **Before releasing:** bump the `version` field in both `manifest.json` and `package.json`
> to match your new release (e.g. `1.0.1`). The zip filename and store version are
> derived from `manifest.json`.

## 2. Open the Developer Dashboard

Go to [https://chrome.google.com/webstore/devconsole](https://chrome.google.com/webstore/devconsole)
and sign in with your developer account.

## 3. First publish — create a new item

1. Click **New item** (top-right).
2. Upload the zip file produced in step 1.
3. Fill in the store listing:
   - **Name** — PingDoctor
   - **Summary** — one-line description (≤ 132 chars)
   - **Description** — can be copied/adapted from `README.md`
   - **Category** — Productivity
   - **Language** — English
4. Upload screenshots (1280×800 or 640×400) and optionally a promotional tile (440×280).
5. Set **Visibility**:
   - *Public* — listed in the store, anyone can install
   - *Unlisted* — only people with the direct link can install (good for beta testing)
   - *Private* — only users in your Google group or your own account
6. Fill in the **Privacy** tab:
   - Declare why `host_permissions: <all_urls>` is needed (the extension fetches
     user-configured URLs to check their availability).
   - State that no personal data is collected or transmitted to third-party servers.
7. Click **Submit for review**.

Google's review typically takes 1–3 business days for a new item.

## 4. Subsequent updates — publish a new version

1. Bump `version` in `manifest.json` (and `package.json` for consistency).
2. Run `npm run release` to produce a new zip.
3. On the dashboard, click your extension → **Package** tab → **Upload new package**.
4. Upload the new zip and click **Submit for review**.

> The store will reject an upload whose `manifest.json` version is not strictly greater
> than the currently published version.

## 5. Permissions justification cheat-sheet

The reviewer may ask you to justify each permission. Use the table below as a reference.

| Permission | Justification |
|---|---|
| `storage` | Persists user-configured endpoints and ping history locally via `chrome.storage.local`. |
| `alarms` | Schedules recurring background pings via `chrome.alarms` without keeping a persistent page open. |
| `host_permissions: <all_urls>` | The user can configure any URL (including local network addresses such as `http://192.168.1.1`) as a ping target. The extension fetches only those URLs. No data is sent to any third party. |

## Useful links

- [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole)
- [Publish in the Chrome Web Store](https://developer.chrome.com/docs/webstore/publish/)
- [Extension quality guidelines](https://developer.chrome.com/docs/webstore/program-policies/quality-guidelines-faq/)
- [Manifest V3 permission guidelines](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions)
