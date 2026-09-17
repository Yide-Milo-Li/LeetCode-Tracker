/** Credentials stay local; imported values must never overwrite a target profile. */
export function isSecretSetting(key: string): boolean {
  return /(?:api_key|secret|token)$/i.test(key);
}
