/** Fixed official destinations carry no user data and are mirrored by native URL validation. */
export const pluginSetupLinks = {
  tunnels: 'https://platform.openai.com/settings/organization/tunnels',
  keys: 'https://platform.openai.com/api-keys',
  plugins: 'https://chatgpt.com/plugins',
  customMcp: 'https://developers.openai.com/api/docs/guides/custom-mcp-server',
  tunnelGuide:
    'https://developers.openai.com/api/docs/guides/secure-mcp-tunnels',
} as const;
export interface TunnelConfiguration {
  enabled: boolean;
  tunnelId: string;
  clientId: string;
}
export interface TunnelVerification {
  clientId: string;
  credentialVersion: number;
  startedAt: number;
}
export interface TunnelStatus {
  state: string;
  code: string | null;
  ready: boolean;
  configuration: TunnelConfiguration;
  credentialSaved: boolean;
  credentialPending: boolean;
  verification: TunnelVerification | null;
}
/** Native commands accept IDs and acknowledgements only; credentials stay in native memory. */
function invoke<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  return (
    window as unknown as {
      __TAURI_INTERNALS__: {
        invoke: <R>(command: string, args?: unknown) => Promise<R>;
      };
    }
  ).__TAURI_INTERNALS__.invoke<T>(command, args);
}
export const tunnelApi = {
  status: () => invoke<TunnelStatus>('get_tunnel_status'),
  promptKey: (lang: 'en' | 'zh') =>
    invoke<boolean>('prompt_tunnel_key', { lang }),
  importKey: () => invoke<boolean>('import_tunnel_key'),
  save: (configuration: TunnelConfiguration, reuseCredential: boolean) =>
    invoke<void>('configure_tunnel', { configuration, reuseCredential }),
  diagnose: () => invoke<string>('diagnose_tunnel'),
  retry: () => invoke<void>('retry_tunnel'),
  beginVerification: () => invoke<void>('begin_tunnel_verification'),
};
/** Proof belongs to the active grant and a fresh check window; health/discovery cannot satisfy it. */
export function hasFreshHostCall(
  status: TunnelStatus | null,
  client:
    | {
        id: string;
        credentialVersion: number;
        revoked: boolean;
        lastSuccessfulCallAt: number | null;
      }
    | undefined,
): boolean {
  const proof = status?.verification;
  return Boolean(
    status?.ready &&
      status.configuration.enabled &&
      proof &&
      client &&
      !client.revoked &&
      client.id === status.configuration.clientId &&
      client.id === proof.clientId &&
      client.credentialVersion === proof.credentialVersion &&
      client.lastSuccessfulCallAt !== null &&
      client.lastSuccessfulCallAt > proof.startedAt,
  );
}
