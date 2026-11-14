import { Component, inject, input } from '@angular/core';
import { TdSocket } from '../../td-socket';

/** Small pill showing whether we're connected to TouchDesigner. */
@Component({
  selector: 'app-connection-status',
  templateUrl: './connection-status.html',
  styleUrl: './connection-status.css',
})
export class ConnectionStatus {
  protected readonly td = inject(TdSocket);
  readonly showLabel = input(true);

  protected readonly labels = {
    connecting: 'Connecting…',
    connected: 'Connected',
    closed: 'Disconnected',
  } as const;
}
