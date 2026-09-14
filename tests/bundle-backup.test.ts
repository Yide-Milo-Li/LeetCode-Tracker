/**
 * Automated tests for Snapshot Bundle Export and Import with pre-restore safety SQLite backup:
 * - Lossless JSON bundle structure and metadata validation
 * - Pre-restore atomic safety backup generation (.sqlite)
 * - Restoring settings, strategies, practice records, and problem notes
 * - Rollback and schema error handling on invalid bundle payload
 */
import { it, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { CatalogStore } from '../packages/database/src/index.ts';

describe('Snapshot Bundle Export & Import', () => {
  let tempDir: string;
  let dbPath: string;
  let backupDir: string;
  let db: DatabaseSync;
  let store: CatalogStore;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-test-'));
    dbPath = path.join(tempDir, 'tracker-test.db');
    backupDir = path.join(tempDir, 'backups');
    fs.mkdirSync(backupDir, { recursive: true });

    db = new DatabaseSync(dbPath);
    store = new CatalogStore(db, { backupDir, skipBackup: true });

    const jsonl = [
      '{"id": "1", "title": "Two Sum", "difficulty": "Easy", "tags": ["Array", "Hash Table"]}',
      '{"id": "2", "title": "Add Two Numbers", "difficulty": "Medium", "tags": ["Linked List"]}',
    ].join('\n');
    await store.importJsonl(jsonl);
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it('exports a complete lossless snapshot bundle with metadata and records', async () => {
    await store.createPracticeRecord({
      questionFrontendId: '1',
      practicedAt: '2026-09-10T10:00:00.000Z',
      timePrecision: 'datetime',
      durationMinutes: 25,
      completed: true,
      notes: 'Clean hash table solution',
    });
    store.upsertProblemNote('1', '## Core Idea\nUse a dictionary for two-sum complement.');
    await store.updateSettings({ language: 'zh', theme: 'dark', timezone: 'Asia/Shanghai' });

    const bundle = store.exportSnapshotBundle();

    assert.equal(bundle.format, 'leetcode-tracker-snapshot');
    assert.equal(bundle.version, 1);
    assert.ok(bundle.exportedAt > 0);

    assert.equal(bundle.practiceRecords.length, 1);
    assert.equal(bundle.problemNotes.length, 1);
    assert.equal(bundle.problemNotes[0].questionId, '1');
    assert.equal(bundle.settings.language, 'zh');
    assert.equal(bundle.settings.timezone, 'Asia/Shanghai');
  });

  it('creates an automated pre-restore safety SQLite backup and restores data', async () => {
    // Populate original database record
    await store.createPracticeRecord({
      questionFrontendId: '1',
      practicedAt: '2026-09-01',
      timePrecision: 'date',
      completed: true,
      notes: 'Original note',
    });

    // Create a bundle from an external/newer system
    const bundleToImport = {
      format: 'leetcode-tracker-snapshot' as const,
      version: 1 as const,
      exportedAt: Date.now(),
      settings: {
        language: 'en',
        theme: 'light',
        timezone: 'America/New_York',
      },
      strategies: [],
      strategyVersions: [],
      weekdayAssignments: [],
      practiceRecords: [
        {
          id: 'rec-100',
          questionId: '1',
          completed: 1,
          practicedAt: '2026-09-12T14:00:00.000Z',
          timePrecision: 'datetime',
          durationMinutes: 18,
          sourceTimezone: null,
          revision: 1,
          status: 'active',
          notes: 'Imported practice note',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          revokedAt: null,
        },
        {
          id: 'rec-200',
          questionId: '2',
          completed: 1,
          practicedAt: '2026-09-12T15:00:00.000Z',
          timePrecision: 'datetime',
          durationMinutes: 30,
          sourceTimezone: null,
          revision: 1,
          status: 'active',
          notes: 'Linked list carry math',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          revokedAt: null,
        },
      ],
      problemNotes: [
        {
          questionId: '2',
          content: '## Add Two Numbers\nHandle carry digit carefully.',
          updatedAt: Date.now(),
        },
      ],
      progressSnapshots: [],
      dailyPlans: [],
      reviewStates: [],
    };

    // Execute import
    const result = await store.importSnapshotBundle(bundleToImport);

    assert.equal(result.success, true);
    assert.equal(result.restoredRecords, 2);
    assert.equal(result.restoredNotes, 1);
    assert.ok(result.safetyBackupPath, 'Safety backup path must be returned');

    // Verify safety backup file exists on disk
    assert.ok(fs.existsSync(result.safetyBackupPath), 'Safety backup file must exist on disk');

    // Verify restored records in DB
    const p1Records = store.queryPracticeRecords({ questionFrontendId: '1' });
    assert.equal(p1Records.total, 1);
    assert.equal(p1Records.items[0].id, 'rec-100');

    const p2Records = store.queryPracticeRecords({ questionFrontendId: '2' });
    assert.equal(p2Records.total, 1);
    assert.equal(p2Records.items[0].id, 'rec-200');

    // Verify restored problem notes in DB
    const note2 = store.getProblemNote('2');
    assert.ok(note2);
    assert.equal(note2.content, '## Add Two Numbers\nHandle carry digit carefully.');

    // Verify restored settings
    const settings = store.getSettings();
    assert.equal(settings.language, 'en');
    assert.equal(settings.theme, 'light');
    assert.equal(settings.timezone, 'America/New_York');
  });

  it('rejects invalid bundle schema and rolls back without data corruption', async () => {
    await store.createPracticeRecord({
      questionFrontendId: '1',
      practicedAt: '2026-09-01',
      timePrecision: 'date',
      completed: true,
      notes: 'Safe original record',
    });

    const malformedBundle = {
      version: 999, // unsupported version
      data: 'not an object',
    };

    await assert.rejects(
      async () => await store.importSnapshotBundle(malformedBundle),
      (err: any) => err.name === 'ZodError' || /invalid/i.test(err.message)
    );

    // Assert original data is intact
    const records = store.queryPracticeRecords({});
    assert.equal(records.total, 1);
    assert.equal(records.items[0].notes, 'Safe original record');
  });

  it('excludes provider API keys from exported bundle and preserves local credentials on restore', async () => {
    // 1. Configure settings with API keys
    await store.updateSettings({
      geminiApiKey: 'secret-gemini-key-123',
      openaiApiKey: 'secret-openai-key-456',
      deepseekApiKey: 'secret-deepseek-key-789',
      language: 'zh',
      timezone: 'Asia/Shanghai',
    });

    // 2. Export snapshot bundle
    const bundle = store.exportSnapshotBundle();

    // Verify secrets are NOT present in the bundle
    assert.equal(bundle.settings.gemini_api_key, undefined);
    assert.equal(bundle.settings.openai_api_key, undefined);
    assert.equal(bundle.settings.deepseek_api_key, undefined);
    assert.equal(bundle.settings.language, 'zh');
    assert.equal(bundle.settings.timezone, 'Asia/Shanghai');

    // 3. Prepare another database with its own local key
    const tempDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-target-test-'));
    const dbPath2 = path.join(tempDir2, 'target.db');
    const backupDir2 = path.join(tempDir2, 'backups');
    fs.mkdirSync(backupDir2, { recursive: true });
    const db2 = new DatabaseSync(dbPath2);
    const store2 = new CatalogStore(db2, { backupDir: backupDir2, skipBackup: true });

    try {
      await store2.updateSettings({
        openaiApiKey: 'existing-local-openai-key-999',
        language: 'en',
      });

      // Restore the secret-free bundle into the target database
      await store2.importSnapshotBundle(bundle);

      // Verify general settings updated to bundle values
      const restoredSettings = store2.getSettings();
      assert.equal(restoredSettings.language, 'zh');
      assert.equal(restoredSettings.timezone, 'Asia/Shanghai');

      // Verify existing local API key was NOT erased or overwritten
      assert.equal(restoredSettings.openaiApiKey, 'existing-local-openai-key-999');
    } finally {
      db2.close();
      fs.rmSync(tempDir2, { recursive: true, force: true });
    }
  });
});

