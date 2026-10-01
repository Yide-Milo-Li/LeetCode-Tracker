/** Configuration resets and authorization races run only under owned temporary directories. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpController } from '../apps/server/src/mcp/config.ts';
import fs from 'node:fs';

test('separate library owners never search or modify each other', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tracker-mcp-isolation-'));
  try {
    const first = new McpController(join(dir, 'library A', 'config.json'));
    const second = new McpController(join(dir, '资料库 B', 'config.json'));
    const credential = first.createClient('ChatGPT'); first.update({ aiAccessPaused: false });
    const before = readFileSync(first.configPath, 'utf8');
    second.createClient('DSH'); second.update({ port: 32123 });
    assert.equal(second.authorize(credential.token), null);
    assert.equal(readFileSync(first.configPath, 'utf8'), before);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('failed atomic replacement preserves the prior file and closes authorization', t => {
  const dir = mkdtempSync(join(tmpdir(), 'tracker-mcp-write-'));
  try {
    const owner = new McpController(join(dir, 'config.json'));
    const before = readFileSync(owner.configPath, 'utf8');
    t.mock.method(fs, 'renameSync', () => { throw new Error('synthetic replacement failure'); });
    assert.throws(() => owner.createClient('Codex'), /MCP_CONFIG_WRITE_FAILED/);
    assert.equal(readFileSync(owner.configPath, 'utf8'), before);
    assert.equal(owner.getStatus().errorCode, 'MCP_CONFIG_WRITE_FAILED');
    assert.throws(() => owner.authorize('a'.repeat(64)), /MCP_CONFIG_WRITE_FAILED/);
  } finally { t.mock.restoreAll(); rmSync(dir, { recursive: true, force: true }); }
});

test('fresh config is paused and empty; legacy credentials reset exactly once', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tracker-mcp-config-'));
  try {
    const file = join(dir, 'mcp-config.json');
    const fresh = new McpController(file);
    assert.equal(fresh.getConfig().aiAccessPaused, true);
    assert.deepEqual(fresh.getConfig().clients, []);
    writeFileSync(file, JSON.stringify({port:30333, clientToken:'old-secret', clients:[{token:'old'}],aiAccessPaused:false}));
    const migrated = new McpController(file);
    assert.equal(migrated.getConfig().port,30333);
    assert.equal(migrated.getConfig().aiAccessPaused,true);
    assert.deepEqual(migrated.getConfig().clients,[]);
    assert.ok(!readFileSync(file,'utf8').includes('old-secret'));
    const client = migrated.createClient('Codex');
    migrated.update({aiAccessPaused:false});
    assert.equal(new McpController(file).getConfig().clients[0].token,client.token);
    assert.equal(new McpController(file).getConfig().aiAccessPaused,false);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

test('rotation, revocation and pause-resume invalidate an outstanding authorization', () => {
  const dir=mkdtempSync(join(tmpdir(),'tracker-mcp-auth-'));
  try {
    const owner=new McpController(join(dir,'config.json'));
    const client=owner.createClient('DSH'); owner.update({aiAccessPaused:false});
    const auth=owner.authorize(client.token)!;
    owner.assertAuthorized(auth);
    assert.equal(owner.getConfig().clients[0].lastSuccessfulCallAt,null);
    owner.recordSuccessfulCall(auth);
    assert.ok(owner.getConfig().clients[0].lastSuccessfulCallAt);
    owner.update({aiAccessPaused:true}); owner.update({aiAccessPaused:false});
    assert.throws(()=>owner.assertAuthorized(auth),/AI_ACCESS_PAUSED/);
    const current=owner.authorize(client.token)!;
    const rotated=owner.rotateClient(client.id)!;
    assert.throws(()=>owner.assertAuthorized(current),/MCP_UNAUTHORIZED/);
    assert.equal(owner.authorize(client.token),null);
    owner.revokeClient(rotated.id);
    assert.equal(owner.authorize(rotated.token),null);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('corruption and failed configuration reads fail closed without overwriting the old file', () => {
  const dir=mkdtempSync(join(tmpdir(),'tracker-mcp-failure-'));
  try {
    const file=join(dir,'config.json');
    writeFileSync(file,'{broken');
    const bad=new McpController(file);
    assert.equal(bad.getStatus().errorCode,'MCP_CONFIG_INVALID');
    assert.throws(()=>bad.createClient('Codex'));
    assert.equal(readFileSync(file,'utf8'),'{broken');
    const owner=new McpController(join(dir,'good.json'));
    const client=owner.createClient('Codex');
    writeFileSync(owner.configPath,'{broken');
    assert.throws(()=>owner.authorize(client.token));
    const occupied=join(dir,'directory.json'); mkdirSync(occupied);
    assert.equal(new McpController(occupied).getStatus().state,'unavailable');
    assert.throws(()=>new McpController('relative.json'),/MCP_CONFIG_PATH_REQUIRED/);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
