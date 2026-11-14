import { Routes } from '@angular/router';
import { Home } from './pages/home/home';
import { Staff } from './pages/staff/staff';

export const routes: Routes = [
  { path: '', component: Home, title: 'Welcome' },
  { path: 'staff', component: Staff, title: 'Staff controls' },
  { path: '**', redirectTo: '' },
];
