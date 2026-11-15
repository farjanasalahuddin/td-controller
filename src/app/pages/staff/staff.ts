import { Component, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { TdSocket } from '../../td-socket';
import { ConnectionStatus } from '../../components/connection-status/connection-status';
import { GuestSearch } from '../../components/guest-search/guest-search';

interface StaffButton {
  /** Sent to TD as { "type": "button", "id": <id> } */
  id: string;
  label: string;
  hint?: string;
  tone?: 'default' | 'go' | 'stop';
  /** Disable this button while TD's system status is one of these, e.g. ['tracking'] */
  disabledWhen?: string[];
}

interface ButtonGroup {
  title: string;
  buttons: StaffButton[];
}

/**
 * Edit these to match what your TD network handles in onWebSocketReceiveText.
 * Each press sends { "type": "button", "id": "<id>" }.
 */
const GROUPS: ButtonGroup[] = [
  {
    title: 'Show control',
    buttons: [
      { id: 'start', label: 'Start', hint: 'Start Tracking', tone: 'go', disabledWhen: ['idle', 'tracking', 'recording', 'uploading'] },
      { id: 'stop', label: 'Stop', hint: 'Stop Recording', tone: 'stop', disabledWhen: ['idle', 'ready'] },
      { id: 'capture', label: 'Capture', hint: 'Capture Still Image', disabledWhen: ['idle', 'ready', 'tracking', 'recording', 'uploading'] },
      { id: 'upload', label: 'Upload', disabledWhen: ['idle', 'ready', 'tracking', 'recording', 'recorded', 'uploading', 'uploaded'] },
    ],
  },
  {
    title: 'Guest screen',
    buttons: [
      { id: 'show_qr', label: 'Show QR', hint: 'Ask TD to send the QR to the guest tablet', disabledWhen: ['idle', 'ready', 'tracking', 'recording', 'uploading'] },
      { id: 'reset', label: 'Reset guest', hint: 'Back to the welcome screen', disabledWhen: ['tracking', 'recording', 'uploading'] },
    ],
  },
];

type StatusTone = 'idle' | 'ready' | 'active' | 'busy' | 'live' | 'done';

interface StatusDisplay {
  label: string;
  tone: StatusTone;
  /** Optional second line; gets the guest name TD sent with the status (or null). */
  detail?: (name: string | null) => string;
}

/**
 * How each { "type": "system", "status": "<key>" } from TD is displayed.
 * Statuses not listed here are shown with their raw text.
 */
const STATUSES: Record<string, StatusDisplay> = {
  idle: { label: 'Waiting for guest', tone: 'idle', detail: () => 'Ready for the next guest to enter their name' },
  ready: {
    label: 'Ready to capture',
    tone: 'ready',
    detail: name => (name ? `Guest ${name} is here` : 'A guest has checked in'),
  },
  tracking: { label: 'Tracking', tone: 'active' },
  recording: { label: 'Recording', tone: 'live' },
  recorded: { label: 'Recording saved', tone: 'done' },
  captured: { label: 'Image captured', tone: 'done' },
  uploading: { label: 'Uploading…', tone: 'busy', detail: () => 'Sending photos and video to the server' },
  uploaded: { label: 'Uploaded', tone: 'done' },
};

@Component({
  selector: 'app-staff',
  imports: [ConnectionStatus, DatePipe, GuestSearch, RouterLink],
  templateUrl: './staff.html',
  styleUrl: './staff.css',
})
export class Staff {
  protected readonly td = inject(TdSocket);
  protected readonly groups = GROUPS;
  protected readonly showLog = signal(true);
  /** Guest search overlay; opening it asks TD for the guest table. */
  protected readonly searchOpen = signal(false);
  /** Briefly highlights the last button pressed, as touch feedback. */
  protected readonly lastPressed = signal<string | null>(null);
  private pressTimer?: ReturnType<typeof setTimeout>;

  /** Display info for the current TD system status (null until TD sends one). */
  protected readonly status = computed(() => {
    const key = this.td.systemStatus();
    if (!key) return null;
    const display: StatusDisplay = STATUSES[key] ?? { label: key, tone: 'active' };
    return {
      label: display.label,
      tone: display.tone,
      detail: display.detail?.(this.td.systemGuestName()) ?? null,
    };
  });

  constructor() {
    this.td.identify('staff');
  }

  protected isDisabled(button: StaffButton): boolean {
    const status = this.td.systemStatus();
    return !!status && !!button.disabledWhen?.includes(status);
  }

  protected press(button: StaffButton) {
    if (this.isDisabled(button)) return;
    this.td.pressButton(button.id);
    this.lastPressed.set(button.id);
    clearTimeout(this.pressTimer);
    this.pressTimer = setTimeout(() => this.lastPressed.set(null), 600);
  }
}
