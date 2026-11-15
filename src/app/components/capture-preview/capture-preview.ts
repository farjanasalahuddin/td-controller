import { Component, computed, effect, inject, signal } from '@angular/core';
import { TdSocket } from '../../td-socket';

/**
 * Thumbnail of the photo TD just captured (before upload), shown in the staff status card.
 * Tap to see it full-screen. Driven by { "type": "capture_preview", "image": "data:..." } from TD.
 */
@Component({
  selector: 'app-capture-preview',
  templateUrl: './capture-preview.html',
  styleUrl: './capture-preview.css',
  host: { '(document:keydown.escape)': 'enlarged.set(false)' },
})
export class CapturePreview {
  protected readonly td = inject(TdSocket);
  protected readonly enlarged = signal(false);
  /** Wrapped in a list so @for recreates the <img> (and replays the fade) on each new capture. */
  protected readonly images = computed(() => {
    const image = this.td.capturePreview();
    return image ? [image] : [];
  });

  constructor() {
    // Photo cleared (new guest): close the full-screen view so the next capture doesn't open in it.
    effect(() => {
      if (!this.td.capturePreview()) this.enlarged.set(false);
    });
  }
}
