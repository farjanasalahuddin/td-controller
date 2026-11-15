# TD Controller

Tablet web app for a TouchDesigner-driven video booth. A **guest iPad** collects the guest's name and later shows a QR code to their content; a **staff iPad** operates TouchDesigner (start tracking, stop recording, capture, upload) and shows the live system status.

TouchDesigner is the source of truth: both tablets connect to it over a WebSocket, send it button presses, and display whatever state it sends back.

```
 Guest iPad  (/)  ──┐                       ┌──▶ Kiosk backend (sessions, file uploads)
                    ├──WebSocket :9980──▶ TouchDesigner
 Staff iPad (/staff)┘                       (Web Server DAT)
        │
        └── /api/kiosk/* ──▶ this app's server ──▶ Kiosk backend :18080
```

Built with Angular 20 (standalone components, signals, zoneless change detection, SSR).

## Running it

```bash
npm install
ng serve --host 0.0.0.0     # --host makes it reachable from the iPads
```

Then on the same Wi-Fi network:

| Device | URL |
|---|---|
| Guest iPad | `http://<this-computer-ip>:4200/` |
| Staff iPad | `http://<this-computer-ip>:4200/staff` |

The app connects to TouchDesigner at `ws://<same host the page was loaded from>:9980`, so it works when TD runs on the machine serving the app. To point at a different machine, add `?td=192.168.1.20:9980` to the page URL.

Production build: `ng build`, then `npm run serve:ssr:td-controller` (serves on port 4000, or `PORT`).

## Pages

### Guest (`/`)

1. **Welcome** — guest types their name and taps Continue. The app creates a UUID for the guest, sends the name + UUID to TD, and registers the session with the kiosk backend.
2. **Waiting** — "Thanks, Sam!" until TD sends the QR code. "Not you? Start over" resets.
3. **QR** — appears automatically when TD reports `uploaded`: a QR code linking to the guest's content page (built from their UUID). TD can also send its own URL with `show_qr`. Done (or 2 minutes of inactivity) returns to Welcome.

### Staff (`/staff`)

- **System status card** — current TD status with the time it arrived.
- **Control buttons** — each press sends `{"type":"button","id":"<id>"}` to TD. Buttons are disabled based on the current status.
- **Messages log** — last 50 messages to and from TD, for debugging.

There is no login on `/staff`; it is simply not linked from the guest page.

## WebSocket protocol

All messages are JSON.

### Tablet → TD

| Message | When |
|---|---|
| `{"type":"hello","role":"home"\|"staff"}` | On every connect/reconnect |
| `{"type":"name","value":"Sam","id":"<uuid>"}` | Guest taps Continue |
| `{"type":"button","id":"start"}` | Staff button pressed (ids below) |
| `{"type":"button","id":"reset"}` | Staff "Reset guest", or guest "Not you? Start over" |
| `{"type":"button","id":"qr_done"}` | Guest taps Done on the QR screen (or it times out) |

### TD → tablet

| Message | Effect |
|---|---|
| `{"type":"system","status":"<status>"}` | Updates the staff status card (optional `"name":"Sam"`) |
| `{"type":"system","status":"uploaded"}` | Also makes the guest iPad show a QR code for `https://192.168.10.94:18443/s/<uuid>` (the guest's UUID; optional `"id"` overrides it). Base link: `QR_LINK_BASE` in `td-socket.ts` |
| `{"type":"show_qr","url":"https://…"}` | Guest iPad shows a QR code for the URL |
| `{"type":"show_qr","image":"data:image/png;base64,…"}` | Guest iPad shows that image as-is |
| `{"type":"reset"}` | Guest iPad returns to Welcome |

Non-JSON replies from TD are logged but otherwise ignored (they no longer close the socket).

### System statuses

Sequence for one guest: `idle → ready → tracking → recording → recorded → captured → uploading → uploaded → idle`

| Status | Card shows | Start | Stop | Capture | Upload | Show QR | Reset |
|---|---|:-:|:-:|:-:|:-:|:-:|:-:|
| `idle` | Waiting for guest | – | – | – | – | – | ✓ |
| `ready` | Ready to capture · Guest Sam is here | ✓ | – | – | – | – | ✓ |
| `tracking` | Tracking | – | ✓ | – | – | – | – |
| `recording` | Recording | – | ✓ | – | – | – | – |
| `recorded` | Recording saved | ✓ | ✓ | ✓ | – | ✓ | ✓ |
| `captured` | Image captured | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `uploading` | Uploading… · Sending photos and video to the server | – | ✓ | – | – | – | – |
| `uploaded` | Uploaded | ✓ | ✓ | ✓ | – | ✓ | ✓ |
| *(none yet)* | Waiting for TD… | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

Unknown statuses are shown as their raw text. Labels and colours are in `STATUSES`, button rules in `GROUPS` (`disabledWhen`), both in [`src/app/pages/staff/staff.ts`](src/app/pages/staff/staff.ts).

## TouchDesigner setup (summary)

The TD side lives in the `.toe` project, not this repo. It needs:

- **Web Server DAT** on port `9980`. Its callbacks track connected tablets by role (from `hello`), handle `name` / `button` messages, and expose a `set_status(status, name=None)` helper that broadcasts `system` messages and stores the latest one, which is sent to each tablet on `hello`.
- **Execute DAT** `onStart` → `set_status('idle')`, so tablets never stay on "Waiting for TD…".
- **Web Client DAT** + an upload Text DAT for sending the guest's photos/video to the backend as `multipart/form-data` (`POST /sessions/<uuid>/files`, field `files` repeated, plus `fullName`). Call `set_status('uploading')` when the request is sent; on a 2xx response → `set_status('uploaded')`.

Send each status when the step has actually happened in TD (e.g. `uploaded` from the upload response), not when the button is pressed.

## Kiosk backend

When a guest submits their name, the guest iPad sends:

```
POST /api/kiosk/sessions   {"uuid": "<uuid>", "fullName": "Sam"}
```

The backend does not send CORS headers, so the browser cannot call it directly. Requests to `/api/kiosk/*` go to this app's own server, which forwards them to `http://192.168.10.94:18080`:

- [`src/server.ts`](src/server.ts) — forwarding route (used by both `ng serve` and production). Override the target with the `KIOSK_API` environment variable.
- [`proxy.conf.json`](proxy.conf.json) — standard dev-server proxy, kept as a fallback.

Failures are retried twice and logged to the guest iPad's console as `[API] could not create session`; the guest flow continues regardless.

## Project structure

```
src/app/
  td-socket.ts                  WebSocket connection, message handling, shared state (signals)
  kiosk-api.ts                  Kiosk backend calls
  pages/home/                   Guest page: switches between Welcome and QR
  pages/staff/                  Staff control panel, status card, button rules
  components/welcome/           Name entry + waiting screen
  components/qr-display/        QR code screen
  components/connection-status/ Connected / Connecting / Disconnected pill
src/server.ts                   SSR server + /api/kiosk forwarding
src/styles.css                  Global theme and touch-sized controls
```

## Troubleshooting

- **Staff card stuck on "Waiting for TD…"** — check the Messages log. No `TD →` lines means TD isn't sending to this tablet (reload the page so it re-sends `hello`). A `system` message without a string `status` is ignored.
- **Debugging on the iPad** — every incoming message is logged to the console as `[TD →]`. Enable Settings → Safari → Advanced → Web Inspector, connect the iPad to a Mac, and open Develop → *iPad* in Safari.
- **Don't send a message from `resetHome()`** in `td-socket.ts`. It also runs when TD sends `reset`, so sending `reset` back to TD there creates an endless loop.

## Development

```bash
ng build      # type-check and build
ng test       # unit tests (Karma)
```
