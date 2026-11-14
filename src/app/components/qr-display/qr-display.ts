import { Component, DestroyRef, effect, inject, signal } from '@angular/core';
import { toDataURL } from 'qrcode';
import { TdSocket } from '../../td-socket';

/** Go back to the welcome screen automatically after this long on the QR screen. */
const AUTO_RESET_MS = 2 * 60 * 1000;

/** Shows the QR code TD sent, either generated from a URL or as a ready-made image. */
@Component({
  selector: 'app-qr-display',
  templateUrl: './qr-display.html',
  styleUrl: './qr-display.css',
})
export class QrDisplay {
  protected readonly td = inject(TdSocket);
  protected readonly src = signal<string | null>(null);
  protected readonly error = signal(false);

  constructor() {
    // Rebuild the QR image whenever TD sends a new URL/image.
    effect(() => {
      const image = this.td.qrImage();
      const url = this.td.qrUrl();
      this.error.set(false);

      if (image) {
        this.src.set(image);
      } else if (url) {
        toDataURL(url, { width: 640, margin: 2, errorCorrectionLevel: 'M' })
          .then(data => this.src.set(data))
          .catch(err => {
            console.error('Could not generate QR code', err);
            this.error.set(true);
          });
      }
    });

    const timeout = setTimeout(() => this.done(), AUTO_RESET_MS);
    inject(DestroyRef).onDestroy(() => clearTimeout(timeout));
  }

  protected done() {
    this.td.pressButton('qr_done');
    this.td.resetHome();
  }
}
