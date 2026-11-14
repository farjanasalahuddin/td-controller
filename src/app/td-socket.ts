import { Injectable, PLATFORM_ID, inject, signal } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { webSocket, WebSocketSubject } from 'rxjs/webSocket';
import { repeat, retry, timer } from 'rxjs';

/** Port of the Web Server DAT in TouchDesigner. */
const TD_PORT = 9980;
/** How long to wait before reconnecting after the socket drops. */
const RECONNECT_MS = 2000;

export type ConnectionStatus = 'connecting' | 'connected' | 'closed';
export type ClientRole = 'home' | 'staff';
/** Which view the guest-facing home page is showing. */
export type HomeScreen = 'welcome' | 'waiting' | 'qr';

export interface LogEntry {
  time: Date;
  direction: 'in' | 'out';
  text: string;
}

/**
 * Messages TD can send to the browser:
 *   { "type": "show_qr", "url": "https://..." }   -> home shows a QR code for that URL
 *   { "type": "show_qr", "image": "data:image/png;base64,..." } -> home shows that image as-is
 *   { "type": "reset" }                            -> home goes back to the welcome screen
 *   { "type": "system", "status": "tracking" }     -> staff page status card. Known statuses:
 *        idle | ready | tracking | recording | recorded | captured | uploaded
 *        (anything else is shown as-is). Optional "name" adds the guest's name,
 *        e.g. { "type": "system", "status": "ready", "name": "Sam" }
 *
 * Messages the browser sends to TD:
 *   { "type": "hello",  "role": "home" | "staff" } -> sent on every (re)connect
 *   { "type": "name",   "value": "Sam", "id": "<uuid>" } -> guest submitted their name; id is a
 *        new UUID v4 for this guest (use it for file names / the upload)
 *   { "type": "button", "id": "start" }            -> a staff (or guest) button was pressed
 *        Guest tablet sends: "qr_done" (Done / QR timeout), "reset" ("Not you? Start over", same id as the staff Reset guest button)
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
      case 'show_qr':
        this.qrUrl.set(typeof data['url'] === 'string' ? data['url'] : null);
        this.qrImage.set(typeof data['image'] === 'string' ? data['image'] : null);
        if (this.qrUrl() || this.qrImage()) this.screen.set('qr');
        break;
      case 'reset':
        this.resetHome();
        break;
      case 'system':
        console.log('[TD →] system status:', data['status'], typeof data['status']);
        if (typeof data['status'] === 'string' && data['status'].trim()) {
          this.systemStatus.set(data['status'].trim().toLowerCase());
          this.systemStatusAt.set(new Date());
          const name = data['name'];
          this.systemGuestName.set(typeof name === 'string' && name.trim() ? name.trim() : null);
        }
        break;
    }
  }

  private addLog(direction: LogEntry['direction'], text: string) {
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
