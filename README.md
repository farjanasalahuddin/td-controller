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

- **System status card** — current TD status with the time it arrived. After a capture it also shows a thumbnail of the photo on the right (tap to enlarge); a new capture replaces it, and it clears when the status returns to `idle` / `ready`.
- **Control buttons** — each press sends `{"type":"button","id":"<id>"}` to TD. Buttons are disabled based on the current status.
- **Messages log** — last 50 messages to and from TD, for debugging.
- **Search guest** — opens a full-screen search. Opening it (or tapping Refresh) asks TD for its guest table; the staff iPad then filters it as you type (name, ignoring case and accents, or the start of a UUID), newest first. Each row shows a thumbnail of the guest's photo from the kiosk backend (`https://192.168.10.94:18443/public/sessions/<uuid>/files/<name>-image.jpg`, `PHOTO_BASE` in `td-socket.ts`), or "No photo" if it can't load. Tapping a guest shows their name, upload time and UUID, and a **Show QR** button (sends it to the guest iPad) (disabled while a guest is in progress — `ready` through `uploading` — because the QR screen's Done sends `reset`). The list is cleared when the search is closed. If TD doesn't answer within 5 seconds it shows "Try again".

There is no login on `/staff`; it is simply not linked from the guest page.

## WebSocket protocol

All messages are JSON.

### Tablet → TD

| Message | When |
|---|---|
| `{"type":"hello","role":"home"\|"staff"}` | On every connect/reconnect |
| `{"type":"name","value":"Sam","id":"<uuid>"}` | Guest taps Continue |
| `{"type":"button","id":"start"}` | Staff button pressed (ids below) |
| `{"type":"get_guests"}` | Staff opens Search guest or taps Refresh |
| `{"type":"show_guest_qr","id":"<uuid>"}` | Staff taps Show QR on a guest in the search. TD should forward `{"type":"show_qr","id":"<uuid>"}` to the guest iPad |
| `{"type":"button","id":"reset"}` | Staff "Reset guest", guest "Not you? Start over", or guest Done on the QR screen (also after the 2-minute timeout) |

### TD → tablet

| Message | Effect |
|---|---|
| `{"type":"system","status":"<status>"}` | Updates the staff status card (optional `"name":"Sam"`) |
| `{"type":"system","status":"uploaded"}` | Also makes the guest iPad show a QR code for `https://192.168.10.94:18443/s/<uuid>` (the guest's UUID; optional `"id"` overrides it). Base link: `QR_LINK_BASE` in `td-socket.ts` |
| `{"type":"show_qr","url":"https://…"}` | Guest iPad shows a QR code for the URL |
| `{"type":"show_qr","id":"<uuid>"}` | Guest iPad shows the QR code for that guest (`QR_LINK_BASE` + uuid) |
| `{"type":"show_qr","image":"data:image/png;base64,…"}` | Guest iPad shows that image as-is |
| `{"type":"reset"}` | Guest iPad returns to Welcome |
| `{"type":"capture_preview","image":"data:image/jpeg;base64,…"}` | Staff status card shows this thumbnail of the photo just captured (send to `role='staff'` only, ~400px JPEG) |
| `{"type":"guests","guests":[{"UUID":"…","Sl_Name":"Sam","Time":"2026-11-15 14:32:05"}, …]}` | Reply to `get_guests` (send it only to the asking tablet). Keys are matched case-insensitively, ignoring `_`/`-`/spaces: `Sl_Name`/`name`/`fullName`, `UUID`/`id`, `Time`/`datetime`/`date`/`timestamp`; other columns (`Video_File`, `Photo_File`) are ignored. `Time` is the upload time and should include the date (`YYYY-MM-DD HH:MM:SS` or ISO) |

Non-JSON replies from TD are logged but otherwise ignored (they no longer close the socket).

### System statuses

Sequence for one guest: `idle → ready → tracking → recording → recorded → captured → uploading → uploaded → idle`

| Status | Card shows | Start | Stop | Capture | Upload | Reset |
|---|---|:-:|:-:|:-:|:-:|:-:|
| `idle` | Waiting for guest | – | – | – | – | ✓ |
| `ready` | Ready to capture · Guest Sam is here | ✓ | – | – | – | ✓ |
| `tracking` | Tracking | – | ✓ | – | – | – |
| `recording` | Recording | – | ✓ | – | – | – |
| `recorded` | Recording saved | ✓ | ✓ | ✓ | – | ✓ |
| `captured` | Image captured | ✓ | ✓ | ✓ | ✓ | ✓ |
| `uploading` | Uploading… · Sending photos and video to the server | – | ✓ | – | – | – |
| `uploaded` | Uploaded | ✓ | ✓ | ✓ | – | ✓ |
| *(none yet)* | Waiting for TD… | ✓ | ✓ | ✓ | ✓ | ✓ |

Unknown statuses are shown as their raw text. Labels and colours are in `STATUSES`, button rules in `GROUPS` (`disabledWhen`), both in [`src/app/pages/staff/staff.ts`](src/app/pages/staff/staff.ts).

## TouchDesigner setup (summary)

The TD side lives in the `.toe` project, not this repo. It needs:

- **Web Server DAT** on port `9980`. Its callbacks track connected tablets by role (from `hello`), handle `name` / `button` messages, and expose a `set_status(status, name=None)` helper that broadcasts `system` messages and stores the latest one, which is sent to each tablet on `hello`.
- **Guest table** (Table DAT, also written to CSV) with a header row, `UUID | Sl_Name | Video_File | Photo_File | Time`, one row added when a guest's upload succeeds (so `Time` is the upload time and only guests with content are searchable). On `get_guests`, the callbacks turn each row into a dict using the header and reply with `webSocketSendText(client, ...)` to that tablet only.
- **Capture preview**: after a capture, a Fit TOP (~400px) → `saveByteArray('.jpg')` → base64 → `send({'type':'capture_preview','image':'data:image/jpeg;base64,'+…}, role='staff')`.
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
  components/guest-search/      Staff guest search overlay
  components/capture-preview/   Captured-photo thumbnail in the staff status card
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
