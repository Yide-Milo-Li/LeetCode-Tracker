/**
 * Entrypoint for the official ChatGPT Workspace app.
 * Renders the shared embedded workspace within the MCP Apps host frame.
 */
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createChatGPTWorkspace } from '../../../packages/workspace/src/hosts/chatgpt.ts';
import { WorkspaceProvider } from '../../../packages/workspace/src/context.tsx';
import { EmbeddedWorkspace } from '../../../packages/workspace/src/EmbeddedWorkspace.tsx';
import { HostViewport } from './HostViewport.tsx';

const rootElement = document.getElementById('tracker-root')!;
const root = createRoot(rootElement);
const workspace = createChatGPTWorkspace(undefined, 'formal', { onDispose: () => root.unmount() });

function ChatGPTWorkspaceApp({
  initialPreferences,
}: {
  initialPreferences: Awaited<ReturnType<typeof workspace.client.getSettings>>;
}) {
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    const hostTheme = (workspace.app.getHostContext() as { theme?: 'light' | 'dark' } | undefined)?.theme;
    if (hostTheme === 'light' || hostTheme === 'dark') return hostTheme;
    if (initialPreferences.theme === 'dark') return 'dark';
    if (initialPreferences.theme === 'light') return 'light';
    return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light';
  });

  useEffect(() => {
    return workspace.host.subscribe((event) => {
      if (event.type === 'theme') {
        setTheme(event.theme);
      }
    });
  }, []);

  return (
    <WorkspaceProvider
      client={workspace.client}
      host={workspace.host}
      timezone={initialPreferences.timezone}
      language={initialPreferences.language}
      theme={theme}
      palette={initialPreferences.palette}
    >
      <HostViewport host={workspace.host} language={initialPreferences.language}><EmbeddedWorkspace lang={initialPreferences.language} /></HostViewport>
    </WorkspaceProvider>
  );
}

try {
  await workspace.connect();
  const preferences = await workspace.client.getSettings();
  if (!workspace.isDisposed()) {
    workspace.renderReady();
    root.render(<ChatGPTWorkspaceApp initialPreferences={preferences} />);
  }
} catch (error) {
  // Host teardown owns the acknowledgement; an aborted initialization must not close its transport.
  if (!workspace.isDisposed()) {
    await workspace.dispose();
    rootElement.textContent = error instanceof Error ? error.message : String(error);
  }
}
