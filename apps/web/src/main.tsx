/**
 * Application DOM entrypoint.
 */
import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App.tsx';
import { DesktopGate } from './components/DesktopGate.tsx';
import { initDesktopPlatform } from './platform/index.ts';
import './styles.css';

initDesktopPlatform();

const rootElement = document.getElementById('root');
if (rootElement) {
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <DesktopGate><App /></DesktopGate>
    </React.StrictMode>
  );
}
