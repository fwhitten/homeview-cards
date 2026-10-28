import './card';
import { registerCard } from '../core/register';

registerCard({
  type: 'homeview-notification-card',
  name: 'HomeView Notifications',
  description: 'Invisible until something happens, then a fullscreen or pill notification with animated success, warning and progress icons.',
  preview: false,
  docs: 'notifications',
});
