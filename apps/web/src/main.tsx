/**
 * Application DOM entrypoint.
 */
import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App.tsx';
import { DesktopGate } from './components/DesktopGate.tsx';
import { initDesktopPlatform } from './platform/index.ts';
import './styles.css';

declare const __DESKTOP_E2E__: boolean;
// Compile-time removal keeps automation commands and dependencies out of ordinary web/native builds.
if (__DESKTOP_E2E__) await import('@wdio/tauri-plugin');

initDesktopPlatform();

const rootElement = document.getElementById('root');
if (rootElement) {
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <DesktopGate><App /></DesktopGate>
    </React.StrictMode>
  );
}
