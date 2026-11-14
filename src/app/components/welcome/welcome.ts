import { Component, inject, signal } from '@angular/core';
import { TdSocket } from '../../td-socket';
import { KioskApi } from '../../kiosk-api';

/** Guest-facing welcome: enter your name, then wait for TD to send the QR code. */
@Component({
  selector: 'app-welcome',
  templateUrl: './welcome.html',
  styleUrl: './welcome.css',
})
export class Welcome {
  protected readonly td = inject(TdSocket);
  private readonly api = inject(KioskApi);
  protected readonly name = signal('');

  /** Guest backs out after entering a name: tell TD, then go back to the name form. */
  protected startOver() {
    this.td.pressButton('reset');
    this.td.resetHome();
  }

  protected submit(event: Event) {
    event.preventDefault();
    const value = this.name().trim();
    if (!value) return;
    const id = this.td.sendName(value);
    this.api.createSession(id, value).subscribe({
      next: () => console.log('[API] session created', id),
      error: err => console.error('[API] could not create session', id, err),
    });
    this.name.set('');
    // Hide the on-screen keyboard on tablets.
    (document.activeElement as HTMLElement | null)?.blur();
  }
}
