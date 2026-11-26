/**
 * Device-local persistence for the Sign in with ChatGPT (SIWC) registration.
 *
 * Every key starts with `openai_oauth_`, so `isDeviceLocalSetting` keeps it out of bundles, sync
 * snapshots and content hashes. Access tokens are never written here; they stay in memory.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { OpenAIAuthMode } from '../../contracts/src/llm-models.ts';
import type { OpenAIOAuthSummary } from '../../contracts/src/sync.ts';
import { isDeviceLocalSetting } from './secrets.ts';

/** Scope that authorizes Responses API requests billed to the user's ChatGPT plan. */
export const OPENAI_PLAN_SCOPE = 'chatgpt.tokens.use.direct';

const KEY_PREFIX = 'openai_oauth_';

export const OPENAI_OAUTH_SETTING_KEYS = {
  /** Stable `urn:uuid:` host identifier; created once and kept across sign-outs. */
  hostId: 'openai_oauth_host_id',
  /** Client ID issued by dynamic registration (`oaiapp_...`); kept across sign-outs. */
  clientId: 'openai_oauth_client_id',
  /** Issued ID of a registration whose first code exchange has not succeeded yet. */
  pendingClientId: 'openai_oauth_pending_client_id',
  refreshToken: 'openai_oauth_refresh_token',
  /** Retained only to send as `id_token_hint` on a later sign-in. */
  idToken: 'openai_oauth_id_token',
  accountEmail: 'openai_oauth_account_email',
  /** Validated ID-token subject of the registered account. */
  accountSub: 'openai_oauth_account_sub',
  /** Space-separated scopes from the latest token response. */
  grantScope: 'openai_oauth_grant_scope',
  reconnectRequired: 'openai_oauth_reconnect_required',
  /** Explicit `api_key` / `chatgpt` choice for this device. */
  authMode: 'openai_oauth_mode',
  /** Model slug used with the ChatGPT plan. */
  model: 'openai_oauth_model',
} as const;

export type OpenAIOAuthSettingKey = (typeof OPENAI_OAUTH_SETTING_KEYS)[keyof typeof OPENAI_OAUTH_SETTING_KEYS];

/** Stored registration values; `null` means the row is absent or empty. */
export type OpenAIOAuthSettings = Record<keyof typeof OPENAI_OAUTH_SETTING_KEYS, string | null>;

/** Read every stored SIWC value in one query. */
export function readOpenAIOAuthSettings(db: DatabaseSync): OpenAIOAuthSettings {
  const rows = db.prepare('SELECT key, value FROM settings WHERE substr(key, 1, ?) = ?')
    .all(KEY_PREFIX.length, KEY_PREFIX) as Array<{ key: string; value: string }>;
  const stored = new Map(rows.map(row => [row.key, row.value]));
  return Object.fromEntries(
    Object.entries(OPENAI_OAUTH_SETTING_KEYS).map(([name, key]) => [name, stored.get(key) || null])
  ) as OpenAIOAuthSettings;
}

/**
 * Write or clear SIWC values atomically, so a rotated refresh token never lands without the
 * scopes and flags issued with it.
 *
 * @param values Keys to set; `null` deletes the key.
 * @throws If a key is not device-local, or the write fails (nothing is persisted then).
 */
export function writeOpenAIOAuthSettings(db: DatabaseSync, values: Partial<Record<OpenAIOAuthSettingKey, string | null>>): void {
  const put = db.prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)');
  const del = db.prepare('DELETE FROM settings WHERE key = ?');
  const now = Date.now();
  // A caller already inside a transaction owns the commit; nesting BEGIN would throw.
  const ownsTransaction = !db.isTransaction;
  if (ownsTransaction) db.exec('BEGIN IMMEDIATE');
  try {
    for (const [key, value] of Object.entries(values)) {
      if (!key.startsWith(KEY_PREFIX) || !isDeviceLocalSetting(key)) throw new Error(`Not a device-local setting: ${key}`);
      if (value === null || value === undefined) del.run(key);
      else put.run(key, value, now);
    }
    if (ownsTransaction) db.exec('COMMIT');
  } catch (error) {
    if (ownsTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

/** Whether a space-separated scope string grants ChatGPT plan usage. */
export function grantsOpenAIPlanScope(scope: string | null | undefined): boolean {
  return Boolean(scope?.split(/\s+/).includes(OPENAI_PLAN_SCOPE));
}

/** Derive the token-free connection summary shown in Settings. */
export function summarizeOpenAIOAuth(settings: OpenAIOAuthSettings): OpenAIOAuthSummary {
  return {
    connected: Boolean(settings.clientId && settings.refreshToken),
    reconnectRequired: settings.reconnectRequired === 'true',
    accountEmail: settings.accountEmail,
    planScopeGranted: grantsOpenAIPlanScope(settings.grantScope),
  };
}

/**
 * Resolve the credential source for this device.
 *
 * An explicit choice wins. Without one, a usable ChatGPT connection is used only when no API key
 * is stored, so existing API-key setups never change behavior.
 */
export function resolveOpenAIAuthMode(settings: OpenAIOAuthSettings, hasApiKey: boolean): OpenAIAuthMode {
  if (settings.authMode === 'chatgpt' || settings.authMode === 'api_key') return settings.authMode;
  const summary = summarizeOpenAIOAuth(settings);
  return summary.connected && summary.planScopeGranted && !hasApiKey ? 'chatgpt' : 'api_key';
}
