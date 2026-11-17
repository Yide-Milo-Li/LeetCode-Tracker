/** Credentials stay local; imported values must never overwrite a target profile. */
export function isSecretSetting(key: string): boolean {
  return /(?:api_key|secret|token)$/i.test(key);
}

/**
 * Settings that describe this device rather than the user's data: credentials plus device sync
 * configuration (`sync_*`: device id, transport, folder path, sync base). Bundles never export them
 * and imports preserve the target's values.
 */
export function isDeviceLocalSetting(key: string): boolean {
  return isSecretSetting(key) || key.startsWith('sync_');
}
