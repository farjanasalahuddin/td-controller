import { Component, DestroyRef, computed, inject, output, signal } from '@angular/core';
import { formatDate } from '@angular/common';
import { Guest, TdSocket, guestPhotoUrl } from '../../td-socket';

/** Don't render more rows than this at once; typing narrows it down. */
const MAX_ROWS = 100;
/**
 * Show QR is disabled while one of these is the system status: the guest iPad is busy
 * with the current guest, and the QR screen's Done/timeout sends "reset" to TD.
 */
const GUEST_IN_PROGRESS = ['ready', 'tracking', 'recording', 'recorded', 'captured', 'uploading'];

/**
 * Full-screen guest search for the staff iPad.
 * Opening it asks TD for the current guest table (get_guests); all filtering happens here.
 * Closing it clears the list again.
 */
@Component({
  selector: 'app-guest-search',
  templateUrl: './guest-search.html',
  styleUrl: './guest-search.css',
  host: { '(document:keydown.escape)': 'close.emit()' },
})
export class GuestSearch {
  protected readonly td = inject(TdSocket);
  readonly close = output<void>();

  protected readonly query = signal('');
  /** Row tapped to show its details (keyed by uuid, falling back to list index). */
  protected readonly selected = signal<string | null>(null);

  /** TD's guests, newest first. */
  private readonly sorted = computed(() =>
    [...(this.td.guests() ?? [])].sort((a, b) => (b.time?.getTime() ?? 0) - (a.time?.getTime() ?? 0)),
  );

  /** Guests whose name (or UUID) contains what staff typed. Accents and case are ignored. */
  protected readonly matches = computed(() => {
    const q = normalize(this.query());
    const all = this.sorted();
    return q ? all.filter(g => normalize(g.name).includes(q) || g.uuid.toLowerCase().startsWith(q)) : all;
  });

  protected readonly shown = computed(() => this.matches().slice(0, MAX_ROWS));
  /** Thumbnails that failed to load (not uploaded yet, wrong name, untrusted certificate…). */
  protected readonly brokenPhotos = signal<ReadonlySet<string>>(new Set());
  protected readonly qrBlocked = computed(() => GUEST_IN_PROGRESS.includes(this.td.systemStatus() ?? ''));
  /** UUID whose QR was just sent, for brief "Sent" feedback. */
  protected readonly qrSent = signal<string | null>(null);
  private qrSentTimer?: ReturnType<typeof setTimeout>;
  protected readonly photoUrl = guestPhotoUrl;
  protected readonly maxRows = MAX_ROWS;

  constructor() {
    this.td.requestGuests();
    // Don't keep everyone's names on the staff iPad after the search is closed.
    inject(DestroyRef).onDestroy(() => this.td.clearGuests());
  }

  protected refresh() {
    this.td.requestGuests();
  }

  protected toggle(key: string) {
    this.selected.set(this.selected() === key ? null : key);
  }

  protected showQr(guest: Guest) {
    if (!guest.uuid || this.qrBlocked()) return;
    this.td.showGuestQr(guest.uuid);
    this.qrSent.set(guest.uuid);
    clearTimeout(this.qrSentTimer);
    this.qrSentTimer = setTimeout(() => this.qrSent.set(null), 2000);
  }

  protected photoFailed(url: string) {
    this.brokenPhotos.update(set => new Set(set).add(url));
  }

  protected key(guest: Guest, index: number): string {
    return guest.uuid || `row-${index}`;
  }

  /** "Today 14:32", "Yesterday 11:10", "13 Nov 16:05", or TD's raw text if it wasn't a date. */
  protected when(guest: Guest): string {
    if (!guest.time) return guest.timeText;
    const days = Math.round((startOfDay(new Date()) - startOfDay(guest.time)) / 86_400_000);
    const time = formatDate(guest.time, 'HH:mm', 'en-US');
    if (days === 0) return `Today ${time}`;
    if (days === 1) return `Yesterday ${time}`;
    return formatDate(guest.time, 'd MMM HH:mm', 'en-US');
  }
}

function normalize(text: string): string {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}
