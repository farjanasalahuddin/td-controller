import { Injectable, PLATFORM_ID, inject, signal } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { webSocket, WebSocketSubject } from 'rxjs/webSocket';
import { repeat, retry, timer } from 'rxjs';

/** Port of the Web Server DAT in TouchDesigner. */
const TD_PORT = 9980;
/** How long to wait before reconnecting after the socket drops. */
const RECONNECT_MS = 2000;
/** Guest's content page; the QR code shown after upload links to QR_LINK_BASE + <uuid>. */
const QR_LINK_BASE = 'https://192.168.10.94:18443/s/';
/** Uploaded files on the kiosk backend: PHOTO_BASE + <uuid> + /files/<name>-image.jpg */
const PHOTO_BASE = 'https://192.168.10.94:18443/public/sessions/';
/** Longer log entries are cut off in the staff Messages log. */
const MAX_LOG_CHARS = 200;
/** Give up waiting for TD's guest list after this long. */
const GUESTS_TIMEOUT_MS = 5000;

export type ConnectionStatus = 'connecting' | 'connected' | 'closed';
export type ClientRole = 'home' | 'staff';
/** Which view the guest-facing home page is showing. */
export type HomeScreen = 'welcome' | 'waiting' | 'qr';

/** One row of TD's guest table, as used by the staff search. */
export interface Guest {
  uuid: string;
  name: string;
  /** Parsed check-in time, or null if TD's value couldn't be read as a date. */
  time: Date | null;
  /** The time exactly as TD sent it. */
  timeText: string;
}

export interface LogEntry {
  time: Date;
  direction: 'in' | 'out';
  text: string;
}

/**
 * Messages TD can send to the browser:
 *   { "type": "show_qr", "url": "https://..." }   -> home shows a QR code for that URL
 *   { "type": "show_qr", "image": "data:image/png;base64,..." } -> home shows that image as-is
 *   { "type": "show_qr", "id": "<uuid>" }          -> home shows the QR for QR_LINK_BASE + uuid
 *        (TD forwards this after staff press Show QR on a guest in the search)
 *   { "type": "reset" }                            -> home goes back to the welcome screen
 *   { "type": "capture_preview", "image": "data:image/jpeg;base64,..." }
 *        -> staff status card shows this thumbnail of the photo just captured (before upload).
 *           Replaced by the next capture; cleared when the status goes back to idle/ready.
 *   { "type": "guests", "guests": [ { "UUID": "...", "Sl_Name": "Sam", "Time": "2026-11-15 14:32:05" }, ... ] }
 *        -> reply to get_guests; the staff search filters this list. Keys are matched
 *           case-insensitively, ignoring _ - and spaces (Sl_Name/name/fullName, uuid/id,
 *           time/datetime/date/timestamp). Other columns (Video_File, ...) are ignored.
 *           Time = upload time (TD adds the row when the upload succeeds).
 *   { "type": "system", "status": "tracking" }     -> staff page status card. Known statuses:
 *        idle | ready | tracking | recording | recorded | captured | uploaded
 *        (anything else is shown as-is). Optional "name" adds the guest's name,
 *        e.g. { "type": "system", "status": "ready", "name": "Sam" }
 *        On "uploaded" the guest iPad shows a QR for QR_LINK_BASE + the guest's UUID
 *        (optional "id" in the message overrides the UUID it remembers).
 *
 * Messages the browser sends to TD:
 *   { "type": "hello",  "role": "home" | "staff" } -> sent on every (re)connect
 *   { "type": "name",   "value": "Sam", "id": "<uuid>" } -> guest submitted their name; id is a
 *        new UUID v4 for this guest (use it for file names / the upload)
 *   { "type": "get_guests" }                       -> staff opened Search guest; reply with "guests"
 *   { "type": "show_guest_qr", "id": "<uuid>" }    -> staff tapped Show QR for a returning guest;
 *        TD should send { "type": "show_qr", "id": "<uuid>" } to the home tablet
 *   { "type": "button", "id": "start" }            -> a staff (or guest) button was pressed
 *        Guest tablet sends "reset" from "Not you? Start over" and from Done / QR timeout
 *        (same id as the staff Reset guest button)
 */
@Injectable({
  providedIn: 'root',
})
export class TdSocket {
  readonly status = signal<ConnectionStatus>('connecting');
  readonly url = signal('');

  // Home page state, driven by TD.
  readonly screen = signal<HomeScreen>('welcome');
  readonly guestName = signal('');
  /** Unique id for the current guest, created when they submit their name. */
  readonly guestId = signal<string | null>(null);
  readonly qrUrl = signal<string | null>(null);
  readonly qrImage = signal<string | null>(null);

  /** Latest system status from TD, e.g. 'tracking' | 'recording' | 'recorded'. null = not known yet. */
  readonly systemStatus = signal<string | null>(null);
  /** When the latest system status arrived. */
  readonly systemStatusAt = signal<Date | null>(null);
  /** Guest name sent with the latest system status, if any (e.g. with "ready"). */
  readonly systemGuestName = signal<string | null>(null);

  /** Thumbnail of the current guest's latest capture (data: URL from TD), shown on the staff page. */
  readonly capturePreview = signal<string | null>(null);

  /** Guest list from TD for the staff search. null = not loaded (or cleared on close). */
  readonly guests = signal<Guest[] | null>(null);
  readonly guestsLoading = signal(false);
  readonly guestsError = signal<string | null>(null);
  private guestsTimer?: ReturnType<typeof setTimeout>;

  // Recent traffic, shown on the staff page.
  readonly log = signal<LogEntry[]>([]);

  private socket$?: WebSocketSubject<unknown>;
  private role: ClientRole | null = null;

  constructor() {
    // Only connect in the browser, not during server-side rendering/prerendering.
    if (!isPlatformBrowser(inject(PLATFORM_ID))) return;

    this.url.set(resolveTdUrl());
    this.socket$ = webSocket<unknown>({
      url: this.url(),
      // Default deserializer is JSON.parse, which throws on plain-text replies
      // and errors (closes) the whole socket. Fall back to raw text.
      deserializer: (e: MessageEvent) => {
        try {
          return JSON.parse(e.data);
        } catch {
          return e.data;
        }
      },
      openObserver: {
        next: () => {
          this.status.set('connected');
          if (this.role) this.send({ type: 'hello', role: this.role });
        },
      },
      closeObserver: { next: () => this.status.set('closed') },
    });

    // Subscribing opens the connection; retry/repeat reconnect after errors or clean closes.
    const reconnect = () => {
      this.status.set('connecting');
      return timer(RECONNECT_MS);
    };
    this.socket$
      .pipe(retry({ delay: reconnect }), repeat({ delay: reconnect }))
      .subscribe(msg => this.handle(msg));
  }

  /** Tell TD which kind of page this tablet is showing. Re-sent on every reconnect. */
  identify(role: ClientRole) {
    this.role = role;
    if (this.status() === 'connected') this.send({ type: 'hello', role });
  }

  pressButton(id: string) {
    this.send({ type: 'button', id });
  }

  /** Guest submitted their name: give them a new unique id and tell TD both. */
  sendName(value: string): string {
    const id = generateUuid();
    this.guestName.set(value);
    this.guestId.set(id);
    this.screen.set('waiting');
    this.send({ type: 'name', value, id });
    return id;
  }

  /** Ask TD for its current guest table (staff search). TD answers with { "type": "guests" }. */
  requestGuests() {
    this.guestsLoading.set(true);
    this.guestsError.set(null);
    this.send({ type: 'get_guests' });
    clearTimeout(this.guestsTimer);
    this.guestsTimer = setTimeout(() => {
      this.guestsLoading.set(false);
      this.guestsError.set("TD didn't send the guest list.");
    }, GUESTS_TIMEOUT_MS);
  }

  /** Staff: ask TD to show a returning guest's QR code on the guest iPad. */
  showGuestQr(id: string) {
    this.send({ type: 'show_guest_qr', id });
  }

  /** Forget the guest list (search closed), so names don't stay on the staff iPad. */
  clearGuests() {
    clearTimeout(this.guestsTimer);
    this.guests.set(null);
    this.guestsLoading.set(false);
    this.guestsError.set(null);
  }

  /** Return the home page to the welcome screen locally (TD can also do this with "reset"). */
  resetHome() {
    this.screen.set('welcome');
    this.guestName.set('');
    this.guestId.set(null);
    this.qrUrl.set(null);
    this.qrImage.set(null);
  }

  private send(msg: object) {
    this.addLog('out', JSON.stringify(msg));
    // WebSocketSubject buffers messages sent while (re)connecting.
    this.socket$?.next(msg);
  }

  private handle(msg: unknown) {
    // Every message from TD arrives here.
    console.log('[TD →]', msg);
    this.addLog('in', typeof msg === 'string' ? msg : JSON.stringify(msg));
    if (!msg || typeof msg !== 'object') return;

    const data = msg as Record<string, unknown>;
    switch (data['type']) {
      case 'show_qr': {
        const id = typeof data['id'] === 'string' ? data['id'].trim() : '';
        const url = typeof data['url'] === 'string' ? data['url'] : id ? qrLink(id) : null;
        this.qrUrl.set(url);
        this.qrImage.set(typeof data['image'] === 'string' ? data['image'] : null);
        if (this.qrUrl() || this.qrImage()) this.screen.set('qr');
        break;
      }
      case 'reset':
        this.resetHome();
        break;
      case 'capture_preview': {
        const image = data['image'];
        if (typeof image === 'string' && image.startsWith('data:image/')) this.capturePreview.set(image);
        else console.warn('[TD →] capture_preview without a data:image/... "image"');
        break;
      }
      case 'guests':
        clearTimeout(this.guestsTimer);
        this.guestsLoading.set(false);
        if (Array.isArray(data['guests'])) {
          this.guests.set(data['guests'].map(toGuest).filter((g): g is Guest => g !== null));
          this.guestsError.set(null);
        } else {
          this.guestsError.set('TD sent "guests" without a "guests" list.');
        }
        break;
      case 'system':
        console.log('[TD →] system status:', data['status'], typeof data['status']);
        if (typeof data['status'] === 'string' && data['status'].trim()) {
          this.systemStatus.set(data['status'].trim().toLowerCase());
          this.systemStatusAt.set(new Date());
          const name = data['name'];
          this.systemGuestName.set(typeof name === 'string' && name.trim() ? name.trim() : null);
          // New guest cycle: don't show the previous guest's photo.
          if (['idle', 'ready'].includes(this.systemStatus()!)) this.capturePreview.set(null);

          if (this.systemStatus() === 'uploaded') this.showUploadQr(data['id']);
        }
        break;
    }
  }

  /**
   * Upload finished: show the guest a QR code for their content page.
   * Uses the guest's own UUID; TD can also send it as "id" with the status
   * (e.g. if this tablet reloaded and lost it).
   */
  private showUploadQr(idFromTd: unknown) {
    if (this.role !== 'home') return; // only the guest iPad shows the QR

    const id = typeof idFromTd === 'string' && idFromTd.trim() ? idFromTd.trim() : this.guestId();
    if (!id) {
      console.warn('[QR] "uploaded" received but no guest UUID is known; not showing a QR code');
      return;
    }

    this.qrImage.set(null);
    this.qrUrl.set(qrLink(id));
    this.screen.set('qr');
  }

  private addLog(direction: LogEntry['direction'], text: string) {
    // Keep big messages (e.g. capture_preview images) from flooding the staff log.
    if (text.length > MAX_LOG_CHARS) {
      text = `${text.slice(0, MAX_LOG_CHARS)}… (${Math.round(text.length / 1024)} KB)`;
    }
    this.log.update(entries => [{ time: new Date(), direction, text }, ...entries].slice(0, 50));
  }
}

/**
 * TD's WebSocket address. Defaults to the same machine that served this page, so a
 * tablet opening http://<td-machine-ip>:4200 connects to ws://<td-machine-ip>:9980.
 * Override with ?td=192.168.1.20:9980 in the page URL.
 */
function resolveTdUrl(): string {
  const override = new URLSearchParams(location.search).get('td');
  if (override) return override.startsWith('ws') ? override : `ws://${override}`;
  return `ws://${location.hostname || 'localhost'}:${TD_PORT}`;
}

/** Link the guest's QR code points to. */
function qrLink(uuid: string): string {
  return QR_LINK_BASE + encodeURIComponent(uuid);
}

/** The guest's photo on the kiosk backend (used as a thumbnail in the staff search). */
export function guestPhotoUrl(guest: Guest): string | null {
  if (!guest.uuid || !guest.name) return null;
  return `${PHOTO_BASE}${encodeURIComponent(guest.uuid)}/files/${encodeURIComponent(guest.name)}-image.jpg`;
}

/** Turn one entry of TD's guest list into a Guest. Header names are matched loosely. */
function toGuest(row: unknown): Guest | null {
  if (!row || typeof row !== 'object') return null;
  const byKey = new Map(
    Object.entries(row).map(([k, v]) => [k.toLowerCase().replace(/[\s_-]/g, ''), String(v ?? '').trim()]),
  );
  const pick = (...keys: string[]) => keys.map(k => byKey.get(k)).find(v => v) ?? '';

  const name = pick('slname', 'name', 'fullname', 'guest', 'guestname');
  const uuid = pick('uuid', 'id', 'guestid', 'sessionid');
  if (!name && !uuid) return null; // blank row

  const timeText = pick('time', 'datetime', 'date', 'timestamp', 'created', 'createdat');
  // "2026-11-15 14:32:05" -> "2026-11-15T14:32:05" so Safari reads it (as local time).
  const parsed = timeText ? new Date(timeText.replace(/^(\d{4}-\d{2}-\d{2}) /, '$1T')) : null;
  return { name, uuid, timeText, time: parsed && !isNaN(parsed.getTime()) ? parsed : null };
}

/**
 * Random UUID v4. crypto.randomUUID() only exists on HTTPS or localhost, so when a
 * tablet loads the app over plain http://<ip>:4200 we build one from getRandomValues().
 */
function generateUuid(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();

  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
