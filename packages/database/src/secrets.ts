/** Credentials stay local; imported values must never overwrite a target profile. */
export function isSecretSetting(key: string): boolean {
  return /(?:api_key|secret|token)$/i.test(key);
}

/**
 * Settings that describe this device rather than the user's data: credentials, device sync
 * configuration (`sync_*`: device id, transport, folder path, sync base) and the Sign in with
 * ChatGPT registration (`openai_oauth_*`: host ID, issued client ID, account, auth mode, model).
 * Bundles never export them and imports preserve the target's values.
 *
 * The ChatGPT host ID must differ on every device, so none of that state may travel with a sync.
 */
export function isDeviceLocalSetting(key: string): boolean {
  return isSecretSetting(key) || key.startsWith('sync_') || key.startsWith('openai_oauth_');
}
