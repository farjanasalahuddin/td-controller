import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, retry, timer } from 'rxjs';

/**
 * Kiosk backend. Requests go to /api/kiosk/... on this app's own server, which forwards
 * them to the backend (proxy.conf.json during `ng serve`, src/server.ts in production).
 */
@Injectable({
  providedIn: 'root',
})
export class KioskApi {
  private readonly http = inject(HttpClient);

  /** Register a new guest session. Retries twice on network/server errors. */
  createSession(uuid: string, fullName: string): Observable<unknown> {
    return this.http
      .post('/api/kiosk/sessions', { uuid, fullName })
      .pipe(retry({ count: 2, delay: () => timer(1000) }));
  }
}
