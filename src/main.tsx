import {DeviceShell} from './ui/deviceLayout';
import { createRoot } from 'react-dom/client';
import { Multiplayer } from './ui/Multiplayer';
import './ui/styles.css';
import './ui/map/map.css';

createRoot(document.getElementById('root')!).render(
  <><Multiplayer /><DeviceShell /></>,
);

import './ui/device.css';
