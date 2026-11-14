import { Component, inject } from '@angular/core';
import { TdSocket } from '../../td-socket';
import { Welcome } from '../../components/welcome/welcome';
import { QrDisplay } from '../../components/qr-display/qr-display';
import { ConnectionStatus } from '../../components/connection-status/connection-status';

/** Guest-facing page. Which component shows is driven by TD via TdSocket.screen. */
@Component({
  selector: 'app-home',
  imports: [Welcome, QrDisplay, ConnectionStatus],
  templateUrl: './home.html',
  styleUrl: './home.css',
})
export class Home {
  protected readonly td = inject(TdSocket);

  constructor() {
    this.td.identify('home');
  }
}
