/**
 * Sign in with ChatGPT (SIWC): authorization flow, ID-token validation, rotating refresh tokens,
 * the Responses/SSE transport and device-local credential isolation.
 *
 * Every OpenAI endpoint is a synthetic in-process fake reached through an injected `fetch`; keys,
 * tokens and accounts are generated per test. Nothing here proves live OpenAI acceptance.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { CatalogStore } from '../packages/database/src/store.ts';
import { computeContentHash } from '../packages/database/src/device-sync.ts';
import { isDeviceLocalSetting } from '../packages/database/src/secrets.ts';
import {
  OPENAI_OAUTH_SETTING_KEYS,
  readOpenAIOAuthSettings,
  writeOpenAIOAuthSettings,
} from '../packages/database/src/openai-oauth-store.ts';
import { buildApp } from '../apps/server/src/app.ts';
import { LLMAssistant } from '../apps/server/src/llm/assistant.ts';
import { OpenAIProvider } from '../apps/server/src/llm/providers/openai.ts';
import { ProviderOutputError } from '../apps/server/src/llm/providers/base.ts';
import { ResponsesApiError } from '../apps/server/src/llm/providers/openai-responses.ts';
import { OpenAIAccessTokenSource, type OpenAIOAuthEndpoints } from '../apps/server/src/llm/openai-oauth.ts';
import { LLMError, type OpenAITokenSource } from '../apps/server/src/llm/types.ts';

const ENDPOINTS: OpenAIOAuthEndpoints = {
  issuer: 'https://auth.fake.test',
  discovery: 'https://auth.fake.test/.well-known/openid-configuration',
  authorize: 'https://auth.fake.test/api/accounts/authorize',
  token: 'https://auth.fake.test/api/accounts/oauth/token',
  resource: 'https://api.fake.test/v1',
};
const FULL_SCOPE = 'chatgpt.tokens.use.direct email offline_access openid profile resource.invoke';

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

/** Synthetic OpenAI authorization server + API, driven entirely through `fetch`. */
function fakeOpenAI() {
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const calls: Array<{ url: string; body: URLSearchParams | null; headers: Record<string, string> }> = [];
  const state = {
    /** Overrides applied to the next issued ID token. */
    idToken: { sub: 'user-1', email: 'user@example.test', alg: 'RS256' as 'RS256' | 'ES256', badSignature: false, nonce: null as string | null },
    scope: FULL_SCOPE,
    refreshCounter: 0,
    /** Set to fail the next refresh with this OAuth error / HTTP status. */
    refreshError: null as { status: number; error?: string } | null,
    exchangeFails: false,
    revokeStatus: 200,
    models: [
      { slug: 'gpt-hidden', display_name: 'Hidden', visibility: 'hide' },
      { slug: 'gpt-synthetic-a', display_name: 'Synthetic A', visibility: 'list' },
      { slug: 'gpt-synthetic-b', display_name: 'Synthetic B', visibility: 'list' },
    ],
    /** nonce captured from the authorize URL, echoed into the ID token. */
    pendingNonce: '',
  };

  const signIdToken = (clientId: string) => {
    const { alg, sub, email, badSignature, nonce } = state.idToken;
    const key: KeyObject = alg === 'RS256' ? rsa.privateKey : ec.privateKey;
    const header = b64({ alg, kid: alg === 'RS256' ? 'rsa-1' : 'ec-1', typ: 'JWT' });
    const payload = b64({ iss: ENDPOINTS.issuer, aud: clientId, sub, email, nonce: nonce ?? state.pendingNonce, exp: Math.floor(Date.now() / 1000) + 600 });
    const data = Buffer.from(`${header}.${payload}`);
    const signature = alg === 'RS256' ? sign('RSA-SHA256', data, key) : sign('SHA256', data, { key, dsaEncoding: 'ieee-p1363' });
    if (badSignature) signature[0] ^= 0xff;
    return `${header}.${payload}.${signature.toString('base64url')}`;
  };

  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body instanceof URLSearchParams ? init.body : null;
    calls.push({ url, body, headers: (init?.headers ?? {}) as Record<string, string> });
    if (url === ENDPOINTS.discovery) {
      return json({ issuer: ENDPOINTS.issuer, jwks_uri: 'https://auth.fake.test/jwks', revocation_endpoint: 'https://auth.fake.test/revoke' });
    }
    if (url === 'https://auth.fake.test/jwks') {
      return json({ keys: [
        { ...rsa.publicKey.export({ format: 'jwk' }), kid: 'rsa-1', alg: 'RS256', use: 'sig' },
        { ...ec.publicKey.export({ format: 'jwk' }), kid: 'ec-1', alg: 'ES256', use: 'sig' },
      ] });
    }
    if (url === ENDPOINTS.token && body?.get('grant_type') === 'authorization_code') {
      if (state.exchangeFails) return json({ error: 'invalid_grant' }, 400);
      state.refreshCounter += 1;
      return json({
        access_token: `access-${state.refreshCounter}`, refresh_token: `refresh-${state.refreshCounter}`,
        id_token: signIdToken(body.get('client_id')!), token_type: 'Bearer', expires_in: 3600, scope: state.scope,
      });
    }
    if (url === ENDPOINTS.token && body?.get('grant_type') === 'refresh_token') {
      if (state.refreshError) {
        const { status, error } = state.refreshError;
        return json(error ? { error } : {}, status);
      }
      state.refreshCounter += 1;
      return json({ access_token: `access-${state.refreshCounter}`, refresh_token: `refresh-${state.refreshCounter}`, token_type: 'Bearer', expires_in: 3600, scope: state.scope });
    }
    if (url === 'https://auth.fake.test/revoke') return new Response('', { status: state.revokeStatus });
    if (url === `${ENDPOINTS.resource}/models`) return json({ models: state.models });
    return new Response('not found', { status: 404 });
  }) as typeof fetch;

  return { fetchImpl, calls, state };
}

/** Running app bound to a real loopback port, because the redirect URI is built from the socket. */
async function startApp(options: { sessionSecret?: string } = {}) {
  const openai = fakeOpenAI();
  const db = new DatabaseSync(':memory:');
  const store = new CatalogStore(db, { skipBackup: true });
  const app = await buildApp({ store, disableStatic: true, ...options, openAIOAuth: { endpoints: ENDPOINTS, fetch: openai.fetchImpl } });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const port = (app.server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  const headers = options.sessionSecret ? { 'x-desktop-session-token': options.sessionSecret } : undefined;
  const api = async (path: string, init: RequestInit = {}) => {
    const response = await fetch(`${base}/api/v1${path}`, {
      ...init,
      headers: { ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...headers, ...(init.headers as Record<string, string> | undefined) },
    });
    return { status: response.status, body: await response.json() as any };
  };
  /** Start a sign-in and return the parsed authorization URL. */
  const connect = async (body: Record<string, unknown> = {}) => {
    const result = await api('/settings/openai/oauth/connect', { method: 'POST', body: JSON.stringify(body) });
    assert.equal(result.status, 200);
    const url = new URL(result.body.authUrl);
    openai.state.pendingNonce = url.searchParams.get('nonce')!;
    return url;
  };
  /** Deliver the browser redirect, as the system browser would (no session header). */
  const callback = (params: Record<string, string>) => fetch(`${base}/auth/callback?${new URLSearchParams(params)}`);
  /** Complete a first-time registration and return the authorization URL that started it. */
  const signIn = async (clientId = 'oaiapp_synthetic_1') => {
    const url = await connect();
    const page = await callback({ code: 'code-1', state: url.searchParams.get('state')!, client_id: clientId });
    return { url, page };
  };
  return { app, db, store, openai, port, base, api, connect, callback, signIn, close: () => app.close() };
}

const tokenCalls = (openai: ReturnType<typeof fakeOpenAI>, grant: string) =>
  openai.calls.filter(call => call.url === ENDPOINTS.token && call.body?.get('grant_type') === grant);

test('first sign-in registers a dynamic client and stores a token-free summary', async () => {
  const t = await startApp();
  try {
    const { url, page } = await t.signIn();
    assert.equal(url.origin + url.pathname, ENDPOINTS.authorize);
    const q = url.searchParams;
    assert.equal(q.get('client_id'), 'dynamic_agent_client');
    assert.equal(q.get('agent_name_hint'), 'LeetCode Tracker');
    assert.match(q.get('ext_agent_host_id')!, /^urn:uuid:[0-9a-f-]{36}$/);
    // Must be the literal loopback address on this server's port; `localhost` is rejected by SIWC.
    assert.equal(q.get('redirect_uri'), `http://127.0.0.1:${t.port}/auth/callback`);
    assert.equal(q.get('scope'), 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct');
    assert.equal(q.get('resource'), ENDPOINTS.resource);
    assert.equal(q.get('response_type'), 'code');
    assert.equal(q.get('code_challenge_method'), 'S256');
    assert.equal(q.get('id_token_hint'), null);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /ChatGPT connected/);

    const [exchange] = tokenCalls(t.openai, 'authorization_code');
    // The issued ID is exchanged, never the registration entry point.
    assert.equal(exchange.body!.get('client_id'), 'oaiapp_synthetic_1');
    assert.equal(exchange.body!.get('redirect_uri'), q.get('redirect_uri'));
    assert.equal(exchange.body!.get('resource'), ENDPOINTS.resource);
    assert.equal(createHash('sha256').update(exchange.body!.get('code_verifier')!).digest('base64url'), q.get('code_challenge'));

    const settings = await t.api('/settings');
    assert.deepEqual(settings.body.openaiOAuth, { connected: true, reconnectRequired: false, accountEmail: 'user@example.test', planScopeGranted: true });
    assert.equal(settings.body.openaiAuthMode, 'chatgpt');
    // First model the account lists for display; hidden models are skipped.
    assert.equal(settings.body.openaiChatgptModel, 'gpt-synthetic-a');
    const serialized = JSON.stringify(settings.body);
    for (const secret of ['refresh-1', 'access-1', 'oaiapp_synthetic_1', 'urn:uuid:']) assert.ok(!serialized.includes(secret), secret);

    const models = await t.api('/settings/openai/oauth/models');
    assert.deepEqual(models.body.models, [
      { slug: 'gpt-synthetic-a', displayName: 'Synthetic A' },
      { slug: 'gpt-synthetic-b', displayName: 'Synthetic B' },
    ]);

    // A state is single-use: replaying the redirect cannot complete a second exchange.
    const replay = await t.callback({ code: 'code-1', state: q.get('state')!, client_id: 'oaiapp_synthetic_1' });
    assert.equal(replay.status, 400);
    assert.equal(tokenCalls(t.openai, 'authorization_code').length, 1);
  } finally { await t.close(); }
});

test('sign-out keeps the registration and host, and a later sign-in re-authorizes the same client', async () => {
  const t = await startApp();
  try {
    const first = await t.signIn();
    const hostId = first.url.searchParams.get('ext_agent_host_id');

    // While still signed in, re-authorization identifies the account with the retained ID token.
    const again = await t.connect();
    assert.equal(again.searchParams.get('client_id'), 'oaiapp_synthetic_1');
    assert.equal(again.searchParams.get('agent_name_hint'), null);
    assert.ok(again.searchParams.get('id_token_hint'));
    assert.equal(again.searchParams.get('login_hint'), 'user@example.test');
    assert.equal(again.searchParams.get('ext_agent_host_id'), hostId);

    const out = await t.api('/settings/openai/oauth/disconnect', { method: 'POST' });
    assert.equal(out.body.connected, false);
    assert.equal(out.body.revocationConfirmed, true);
    const revoke = t.openai.calls.find(call => call.url === 'https://auth.fake.test/revoke')!;
    assert.equal(revoke.body!.get('token'), 'refresh-1');
    assert.equal(revoke.body!.get('token_type_hint'), 'refresh_token');
    assert.equal(revoke.body!.get('client_id'), 'oaiapp_synthetic_1');
    const stored = readOpenAIOAuthSettings(t.db);
    assert.equal(stored.refreshToken, null);
    assert.equal(stored.idToken, null);
    assert.equal(stored.clientId, 'oaiapp_synthetic_1');
    assert.equal(stored.hostId, hostId);

    // After signing out the ID-token hint is gone, but the client and host are reused.
    const back = await t.connect();
    assert.equal(back.searchParams.get('client_id'), 'oaiapp_synthetic_1');
    assert.equal(back.searchParams.get('id_token_hint'), null);
    assert.equal(back.searchParams.get('ext_agent_host_id'), hostId);

    // A different account must not take over this registration.
    t.openai.state.idToken.sub = 'user-2';
    const mismatch = await t.callback({ code: 'code-2', state: back.searchParams.get('state')! });
    assert.equal(mismatch.status, 400);
    assert.match(await mismatch.text(), /different ChatGPT account/);
    assert.equal(readOpenAIOAuthSettings(t.db).refreshToken, null);

    // "Use a different account" registers a new client instead.
    const fresh = await t.connect({ freshRegistration: true });
    assert.equal(fresh.searchParams.get('client_id'), 'dynamic_agent_client');
    assert.equal(fresh.searchParams.get('ext_agent_host_id'), hostId);
    const done = await t.callback({ code: 'code-3', state: fresh.searchParams.get('state')!, client_id: 'oaiapp_synthetic_2' });
    assert.equal(done.status, 200);
    assert.equal(readOpenAIOAuthSettings(t.db).clientId, 'oaiapp_synthetic_2');
    assert.equal(readOpenAIOAuthSettings(t.db).accountSub, 'user-2');
  } finally { await t.close(); }
});

test('unconfirmed revocation still signs out locally and is reported', async () => {
  const t = await startApp();
  try {
    await t.signIn();
    t.openai.state.revokeStatus = 503;
    const out = await t.api('/settings/openai/oauth/disconnect', { method: 'POST' });
    assert.equal(out.body.connected, false);
    assert.equal(out.body.revocationConfirmed, false);
    assert.equal(readOpenAIOAuthSettings(t.db).refreshToken, null);
  } finally { await t.close(); }
});

test('rejects unverifiable identities and declined consent without storing a session', async () => {
  const cases: Array<[string, (state: ReturnType<typeof fakeOpenAI>['state']) => void]> = [
    ['bad signature', state => { state.idToken.badSignature = true; }],
    ['nonce mismatch', state => { state.idToken.nonce = 'another-attempt'; }],
  ];
  for (const [label, corrupt] of cases) {
    const t = await startApp();
    try {
      corrupt(t.openai.state);
      const { page } = await t.signIn();
      assert.equal(page.status, 400, label);
      assert.equal((await t.api('/settings/openai/oauth/status')).body.connected, false, label);
      // The issued client survives so the next attempt does not register a second app.
      assert.equal(readOpenAIOAuthSettings(t.db).pendingClientId, 'oaiapp_synthetic_1', label);
      const retry = await t.connect();
      assert.equal(retry.searchParams.get('client_id'), 'oaiapp_synthetic_1', label);
    } finally { await t.close(); }
  }

  const t = await startApp();
  try {
    // `access_denied` ends the attempt before any code is exchanged.
    const url = await t.connect();
    const denied = await t.callback({ error: 'access_denied', state: url.searchParams.get('state')! });
    assert.equal(denied.status, 400);
    assert.equal(tokenCalls(t.openai, 'authorization_code').length, 0);
    // A registration callback without an issued client ID is incomplete.
    const noClient = await t.connect();
    assert.equal((await t.callback({ code: 'c', state: noClient.searchParams.get('state')! })).status, 400);
    // An unknown state never reaches the token endpoint.
    assert.equal((await t.callback({ code: 'c', state: 'forged', client_id: 'oaiapp_x' })).status, 400);
    assert.equal(tokenCalls(t.openai, 'authorization_code').length, 0);
  } finally { await t.close(); }
});

test('ES256 identities validate, and a grant without plan usage is kept but cannot run requests', async () => {
  const t = await startApp();
  try {
    t.openai.state.idToken.alg = 'ES256';
    t.openai.state.scope = 'email offline_access openid profile';
    const { page } = await t.signIn();
    assert.equal(page.status, 200);
    assert.match(await page.text(), /plan use is not enabled/);
    const settings = (await t.api('/settings')).body;
    assert.deepEqual(settings.openaiOAuth, { connected: true, reconnectRequired: false, accountEmail: 'user@example.test', planScopeGranted: false });
    // Signing in alone does not switch OpenAI away from the API key.
    assert.equal(settings.openaiAuthMode, 'api_key');
    // Enabling it later asks for consent again with the saved client.
    const enable = await t.connect();
    assert.equal(enable.searchParams.get('client_id'), 'oaiapp_synthetic_1');
    assert.equal(enable.searchParams.get('prompt'), 'consent');
  } finally { await t.close(); }
});

test('desktop mode exempts only the OAuth redirect from the session header', async () => {
  const t = await startApp({ sessionSecret: 'synthetic-session-secret-for-openai-oauth' });
  try {
    assert.equal((await fetch(`${t.base}/api/v1/settings/openai/oauth/status`)).status, 401);
    assert.equal((await fetch(`${t.base}/api/v1/settings/openai/oauth/connect`, { method: 'POST' })).status, 401);
    // Reaches the route (and fails on the missing state) instead of being rejected as unauthenticated.
    assert.equal((await fetch(`${t.base}/auth/callback`)).status, 400);
    const { page } = await t.signIn();
    assert.equal(page.status, 200);
    assert.equal((await t.api('/settings/openai/oauth/status')).body.connected, true);
  } finally { await t.close(); }
});

test('refresh is single-flight, persists the rotated token and only ends the session on terminal errors', async () => {
  const openai = fakeOpenAI();
  let now = 1_000_000;
  const rotated: Array<{ refreshToken: string; scope: string | null }> = [];
  let reconnects = 0;
  const build = () => new OpenAIAccessTokenSource(
    { clientId: 'oaiapp_synthetic_1', refreshToken: 'refresh-0', accessToken: { token: 'access-0', expiresAt: now + 3600_000 } },
    ENDPOINTS, openai.fetchImpl,
    { onRotate: tokens => { rotated.push(tokens); }, onReconnectRequired: () => { reconnects += 1; } },
    () => now
  );
  const source = build();
  assert.equal(await source.get(), 'access-0');
  assert.equal(tokenCalls(openai, 'refresh_token').length, 0);

  // Past the refresh margin: concurrent callers share one request, because the refresh token rotates.
  now += 3600_000;
  assert.deepEqual(await Promise.all([source.get(), source.get(), source.get()]), ['access-1', 'access-1', 'access-1']);
  const refreshes = tokenCalls(openai, 'refresh_token');
  assert.equal(refreshes.length, 1);
  assert.equal(refreshes[0].body!.get('client_id'), 'oaiapp_synthetic_1');
  assert.equal(refreshes[0].body!.get('refresh_token'), 'refresh-0');
  assert.equal(refreshes[0].body!.get('resource'), ENDPOINTS.resource);
  assert.equal(refreshes[0].body!.get('scope'), null);
  assert.deepEqual(rotated, [{ refreshToken: 'refresh-1', scope: FULL_SCOPE }]);

  // The next refresh presents the replacement, not the consumed token.
  source.invalidate('access-1');
  assert.equal(await source.get(), 'access-2');
  assert.equal(tokenCalls(openai, 'refresh_token')[1].body!.get('refresh_token'), 'refresh-1');

  // A temporary outage keeps the session.
  openai.state.refreshError = { status: 503 };
  source.invalidate('access-2');
  await assert.rejects(source.get(), (error: unknown) => error instanceof LLMError && error.code === 'OPENAI_OAUTH_UNAVAILABLE');
  assert.equal(reconnects, 0);

  // A terminal code ends it, and later calls fail without contacting OpenAI again.
  openai.state.refreshError = { status: 400, error: 'refresh_token_reused' };
  await assert.rejects(source.get(), (error: unknown) => error instanceof LLMError && error.code === 'OPENAI_OAUTH_RECONNECT_REQUIRED');
  assert.equal(reconnects, 1);
  const before = tokenCalls(openai, 'refresh_token').length;
  await assert.rejects(source.get(), (error: unknown) => error instanceof LLMError && error.code === 'OPENAI_OAUTH_RECONNECT_REQUIRED');
  assert.equal(tokenCalls(openai, 'refresh_token').length, before);
});

test('a rejected stored session marks the connection for re-authorization', async () => {
  const t = await startApp();
  try {
    await t.signIn();
    // Simulate a restart: no cached access token, so the model list needs a refresh first.
    writeOpenAIOAuthSettings(t.db, { [OPENAI_OAUTH_SETTING_KEYS.refreshToken]: 'refresh-stale' });
    await t.app.close();
  } catch (error) { await t.close(); throw error; }

  const openai = fakeOpenAI();
  openai.state.refreshError = { status: 400, error: 'invalid_grant' };
  const app = await buildApp({ store: t.store, disableStatic: true, openAIOAuth: { endpoints: ENDPOINTS, fetch: openai.fetchImpl } });
  try {
    const models = await app.inject({ method: 'GET', url: '/api/v1/settings/openai/oauth/models' });
    assert.equal(models.statusCode, 401);
    assert.equal(JSON.parse(models.payload).error, 'OPENAI_OAUTH_RECONNECT_REQUIRED');
    const settings = JSON.parse((await app.inject({ method: 'GET', url: '/api/v1/settings' })).payload);
    assert.equal(settings.openaiOAuth.reconnectRequired, true);
    // The credentials are kept for diagnosis; only a new sign-in clears the flag.
    assert.equal(readOpenAIOAuthSettings(t.db).clientId, 'oaiapp_synthetic_1');
  } finally { await app.close(); }
});

/** Build an SSE body from events, split at arbitrary byte offsets to exercise reassembly. */
function sse(events: unknown[], chunkSize = 7): Response {
  const bytes = Buffer.from(events.map(event => `event: ${(event as { type: string }).type}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`).join(''));
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += chunkSize) controller.enqueue(bytes.subarray(offset, offset + chunkSize));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

/** Token source stub that counts renewals. */
function stubTokens(connected = true) {
  const state = { issued: 0, invalidated: [] as string[] };
  const source: OpenAITokenSource = {
    isConnected: () => connected,
    get: async () => `token-${++state.issued}`,
    invalidate: token => { state.invalidated.push(token); },
  };
  return { source, state };
}

const completed = (text: string) => [
  { type: 'response.created', response: {} },
  ...[...text].map(delta => ({ type: 'response.output_text.delta', delta })),
  { type: 'response.completed', response: { model: 'gpt-synthetic-a-2026', usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18, input_tokens_details: { cached_tokens: 3 }, output_tokens_details: { reasoning_tokens: 2 } } } },
];

const generate = (provider: OpenAIProvider, purpose: 'coaching' | 'progress_import' = 'coaching') => provider.generateContent({
  model: 'gpt-synthetic-a', systemInstruction: 'Be brief.', prompt: 'Rank these.', responseSchema: { type: 'OBJECT' },
  abortSignal: new AbortController().signal, reasoningEffort: 'low', maxOutputTokens: 2048, purpose,
});

test('ChatGPT mode sends a compliant Responses request and reassembles the stream', async () => {
  const tokens = stubTokens();
  const requests: Array<{ url: string; init: RequestInit }> = [];
  // Multi-byte text split across 7-byte chunks must survive decoding.
  const answer = JSON.stringify({ note: '复习 ✓ done' });
  const provider = new OpenAIProvider({
    authMode: 'chatgpt', oauthTokenSource: tokens.source, baseUrl: 'https://gateway.invalid/v1', apiKey: 'sk-unused',
    fetchFn: async (url, init) => { requests.push({ url: String(url), init: init! }); return sse(completed(answer)); },
  });
  assert.equal(provider.isConfigured(), true);
  const result = await generate(provider);
  assert.equal(result.text, answer);
  assert.equal(result.model, 'gpt-synthetic-a-2026');
  assert.deepEqual(result.usage, { inputTokens: 11, outputTokens: 7, cachedInputTokens: 3, reasoningTokens: 2, totalTokens: 18, source: 'provider' });

  // Plan usage always targets the official API with the OAuth token, never a custom gateway or the API key.
  assert.equal(requests[0].url, 'https://api.openai.com/v1/responses');
  assert.equal((requests[0].init.headers as Record<string, string>).Authorization, 'Bearer token-1');
  const body = JSON.parse(String(requests[0].init.body));
  assert.equal(body.store, false);
  assert.equal(body.stream, true);
  assert.equal(body.instructions, 'Be brief.');
  assert.deepEqual(body.input.map((item: { role: string }) => item.role), ['developer', 'user']);
  assert.match(body.input[0].content, /JSON/);
  assert.equal(body.input[1].content, 'Rank these.');
  assert.deepEqual(body.reasoning, { effort: 'low' });
  assert.deepEqual(body.text, { format: { type: 'json_object' } });
  // Fields the ChatGPT plan route rejects.
  for (const field of ['max_output_tokens', 'temperature', 'metadata', 'previous_response_id', 'user']) assert.ok(!(field in body), field);
});

test('ChatGPT mode maps stream outcomes and renews a rejected access token once', async () => {
  const run = (responses: Array<() => Response>, tokens = stubTokens()) => {
    let index = 0;
    const provider = new OpenAIProvider({ authMode: 'chatgpt', oauthTokenSource: tokens.source, fetchFn: async () => responses[Math.min(index++, responses.length - 1)]() });
    return { provider, tokens, calls: () => index };
  };

  // 401 -> invalidate -> one retry with a fresh token.
  const renewed = run([() => new Response(JSON.stringify({ detail: 'expired' }), { status: 401 }), () => sse(completed('{"ok":true}'))]);
  assert.equal((await generate(renewed.provider)).text, '{"ok":true}');
  assert.deepEqual(renewed.tokens.state.invalidated, ['token-1']);
  assert.equal(renewed.calls(), 2);

  // A second 401 is not retried again and is classified as fatal.
  const rejected = run([() => new Response(JSON.stringify({ detail: 'no permission' }), { status: 401 })]);
  await assert.rejects(generate(rejected.provider), (error: unknown) =>
    error instanceof ResponsesApiError && error.status === 401 && rejected.provider.isFatalAuthError(error));
  assert.equal(rejected.calls(), 2);

  // The model stopped early.
  const truncated = run([() => sse([{ type: 'response.output_text.delta', delta: '{"a":' }, { type: 'response.incomplete', response: { usage: { input_tokens: 5, output_tokens: 9 } } }])]);
  await assert.rejects(generate(truncated.provider), (error: unknown) => error instanceof ProviderOutputError && error.reason === 'truncated' && error.usage?.outputTokens === 9);

  // A usage-limit failure can arrive after streaming began; it reads as HTTP 429 to the retry logic.
  const limited = run([() => sse([{ type: 'response.output_text.delta', delta: '{' }, { type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'limit' } } }])]);
  await assert.rejects(generate(limited.provider), (error: unknown) => error instanceof ResponsesApiError && error.status === 429 && /^\[429\] subscription_sharing_usage_limit_exceeded/.test(error.message));

  // A stream that just ends is not a success.
  const cut = run([() => sse([{ type: 'response.output_text.delta', delta: '{"a":1}' }])]);
  await assert.rejects(generate(cut.provider), (error: unknown) => error instanceof ResponsesApiError && /ended before completion/.test(error.message));

  // Non-JSON output is rejected except for progress imports, which have their own decoder.
  const prose = run([() => sse(completed('not json'))]);
  await assert.rejects(generate(prose.provider), (error: unknown) => error instanceof ProviderOutputError && error.reason === 'invalid');
  assert.equal((await generate(run([() => sse(completed('not json'))]).provider, 'progress_import')).text, 'not json');

  // Without a usable session nothing is sent.
  const offline = run([() => sse(completed('{}'))], stubTokens(false));
  assert.equal(offline.provider.isConfigured(), false);
  await assert.rejects(generate(offline.provider), (error: unknown) => error instanceof LLMError && error.code === 'OPENAI_OAUTH_RECONNECT_REQUIRED');
  assert.equal(offline.calls(), 0);
});

test('the assistant treats a ChatGPT session as configured for every capability', async t => {
  const tokens = stubTokens();
  const bodies: any[] = [];
  let reply = () => sse(completed(JSON.stringify({ candidates: [], unparsedSnippets: [] })));
  // Installed before the assistant exists: providers capture `fetch` when they are constructed.
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => { bodies.push(JSON.parse(String(init.body))); return reply(); });
  const assistant = new LLMAssistant({
    provider: 'openai', maxRetriesPerModel: 0, initialBackoffMs: 0,
    providers: { openai: { apiKey: '', model: 'gpt-synthetic-a', authMode: 'chatgpt', oauthTokenSource: tokens.source } },
  });
  assert.equal(assistant.getStatus().configured, true);

  // No API key is stored, yet progress formatting reaches the provider instead of failing as unconfigured.
  const formatted = await assistant.formatProgressText('1. Two Sum Accepted 3');
  assert.equal(formatted.provider, 'openai');
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].store, false);

  // The same holds for the capabilities that otherwise fall back to local rules silently.
  reply = () => sse(completed(JSON.stringify({ dailyCount: 4, unresolved: [] })));
  const override = await assistant.parseOverridePrompt({ prompt: 'four problems today', baseRules: null, knownTags: [] });
  assert.equal(override.provider, 'openai');
  assert.equal(override.patch.dailyCount, 4);

  reply = () => sse(completed(JSON.stringify({ ok: true })));
  assert.deepEqual(await assistant.testConnection({ provider: 'openai', authMode: 'chatgpt' }).then(r => ({ ok: r.ok, model: r.model })), { ok: true, model: 'gpt-synthetic-a' });
  // The connection probe is plain text: no JSON mode and no schema message.
  const probe = bodies.at(-1);
  assert.equal(probe.text, undefined);
  assert.deepEqual(probe.input, [{ role: 'user', content: 'ping' }]);

  // A usage limit surfaces as the quota error the UI already explains.
  reply = () => sse([{ type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'limit' } } }]);
  await assert.rejects(assistant.formatProgressText('1. Two Sum Accepted 3'), (error: unknown) => error instanceof LLMError && error.code === 'OPENAI_QUOTA_EXCEEDED');

  // Losing the session makes the provider unconfigured again; an API key in another mode is unaffected.
  const signedOut = new LLMAssistant({ provider: 'openai', providers: { openai: { apiKey: 'sk-kept', authMode: 'chatgpt', oauthTokenSource: stubTokens(false).source } } });
  assert.equal(signedOut.getStatus().configured, false);
  await assert.rejects(signedOut.formatProgressText('1. Two Sum'), (error: unknown) => error instanceof LLMError && error.code === 'OPENAI_NOT_CONFIGURED');
  signedOut.updateConfig({ providers: { openai: { authMode: 'api_key' } } });
  assert.equal(signedOut.getStatus().configured, true);
});

test('settings switch between ChatGPT and API key without losing the stored key', async () => {
  const t = await startApp();
  try {
    const patch = (payload: Record<string, unknown>) => t.api('/settings', { method: 'PATCH', body: JSON.stringify(payload) });
    assert.equal((await patch({ llmProvider: 'openai', openaiApiKey: 'sk-synthetic-kept', openaiModel: 'gpt-6-luna' })).status, 200);
    await t.signIn();
    let settings = (await t.api('/settings')).body;
    assert.equal(settings.openaiAuthMode, 'chatgpt');
    assert.equal(settings.openaiApiKey, 'sk-synthetic-kept');
    // The API-key model list stays static; the ChatGPT model is a separate, dynamic slug.
    assert.equal(settings.openaiModel, 'gpt-6-luna');
    assert.equal((await patch({ openaiChatgptModel: 'gpt-synthetic-b' })).body.openaiChatgptModel, 'gpt-synthetic-b');
    assert.equal((await patch({ openaiChatgptModel: 'not a slug!' })).status, 400);
    assert.equal((await patch({ openaiModel: 'gpt-synthetic-b' })).status, 400);

    settings = (await patch({ openaiAuthMode: 'api_key' })).body;
    assert.equal(settings.openaiAuthMode, 'api_key');
    assert.equal(settings.openaiOAuth.connected, true);
    assert.equal(settings.openaiApiKey, 'sk-synthetic-kept');
  } finally { await t.close(); }
});

test('ChatGPT registration state never leaves the device', async () => {
  for (const key of Object.values(OPENAI_OAUTH_SETTING_KEYS)) assert.ok(isDeviceLocalSetting(key), key);

  const source = new CatalogStore(new DatabaseSync(':memory:'), { skipBackup: true });
  // The writer refuses keys that would sync, and leaves nothing behind when it does.
  assert.throws(() => writeOpenAIOAuthSettings(source.db, { [OPENAI_OAUTH_SETTING_KEYS.hostId]: 'urn:uuid:x', ['openai_model' as never]: 'x' }), /device-local/);
  assert.equal(readOpenAIOAuthSettings(source.db).hostId, null);
  const target = new CatalogStore(new DatabaseSync(':memory:'), { skipBackup: true });
  await source.updateSettings({ language: 'zh' });
  const before = computeContentHash((source.exportMigrationBundle(5) as any).tables);
  const values = Object.fromEntries(Object.values(OPENAI_OAUTH_SETTING_KEYS).map(key => [key, `source-${key}`]));
  writeOpenAIOAuthSettings(source.db, values);
  const bundle = source.exportMigrationBundle(5) as any;
  assert.ok(!JSON.stringify(bundle).includes('openai_oauth_'), 'no ChatGPT sign-in state in an export');
  // Signing in does not make the profile look changed to device sync.
  assert.equal(computeContentHash(bundle.tables), before);

  // Importing another device's data keeps this device's host ID and credentials.
  writeOpenAIOAuthSettings(target.db, { [OPENAI_OAUTH_SETTING_KEYS.hostId]: 'urn:uuid:target-host', [OPENAI_OAUTH_SETTING_KEYS.refreshToken]: 'target-refresh' });
  await target.importSnapshotBundle(bundle);
  const kept = readOpenAIOAuthSettings(target.db);
  assert.equal(kept.hostId, 'urn:uuid:target-host');
  assert.equal(kept.refreshToken, 'target-refresh');
  assert.equal(kept.clientId, null);
  assert.equal(target.getSettings().language, 'zh');
});
