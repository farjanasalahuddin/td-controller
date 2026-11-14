import { TestBed } from '@angular/core/testing';

import { TdSocket } from './td-socket';

describe('TdSocket', () => {
  let service: TdSocket;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(TdSocket);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });
});
