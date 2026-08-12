import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { EventEmitter } from 'events';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { Database } from 'bun:sqlite';

import { USER_SETTINGS_PATH } from '../../src/shared/paths.js';
import { ModeManager } from '../../src/services/domain/ModeManager.js';
import { SessionQueueProcessor } from '../../src/services/queue/SessionQueueProcessor.js';
import { PendingMessageStore } from '../../src/services/sqlite/PendingMessageStore.js';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { MigrationRunner } from '../../src/services/sqlite/migrations/runner.js';
import { OpenRouterProvider } from '../../src/services/worker/OpenRouterProvider.js';
import { SessionManager } from '../../src/services/worker/SessionManager.js';
import { processAgentResponse } from '../../src/services/worker/agents/ResponseProcessor.js';
import { handleGeneratorExit } from '../../src/services/worker/session/GeneratorExitHandler.js';
import { SessionCompletionHandler } from '../../src/services/worker/session/SessionCompletionHandler.js';
import type { DatabaseManager } from '../../src/services/worker/DatabaseManager.js';
import type { ActiveSession, PendingMessage } from '../../src/services/worker-types.js';

const FIXED_FACTS = [
  'source fact alpha',
  'source fact beta',
  'source fact gamma',
] as const;

type PendingRow = {
  id: number;
  status: 'pending' | 'processing';
  last_failure_code: string | null;
  last_failure_at: number | null;
  tool_response: string | null;
};

interface Harness {
  store: SessionStore;
  pending: PendingMessageStore;
  dbManager: DatabaseManager;
  sessionManager: SessionManager;
  session: ActiveSession;
  sessionDbId: number;
}

function makeHarness(suffix: string): Harness {
  const store = new SessionStore(':memory:');
  const contentSessionId = `p3-content-${suffix}`;
  const memorySessionId = `p3-memory-${suffix}`;
  const sessionDbId = store.createSDKSession(contentSessionId, 'p3-project', 'p3 prompt');
  store.updateMemorySessionId(sessionDbId, memorySessionId);

  const dbManager = {
    getSessionStore: () => store,
    getSessionById: (id: number) => {
      const row = store.getSessionById(id);
      if (!row) throw new Error(`missing test session ${id}`);
      return row;
    },
    getChromaSync: () => null,
  } as unknown as DatabaseManager;

  const sessionManager = new SessionManager(dbManager);
  const session = sessionManager.initializeSession(sessionDbId, 'p3 prompt', 1);
  session.memorySessionId = memorySessionId;
  session.currentProvider = 'openrouter';

  return {
    store,
    pending: sessionManager.getPendingMessageStore(),
    dbManager,
    sessionManager,
    session,
    sessionDbId,
  };
}

function enqueueFact(
  harness: Harness,
  fact: string,
  toolUseId: string,
): number {
  const message: PendingMessage = {
    type: 'observation',
    tool_name: 'Read',
    tool_input: { path: `/fixture/${toolUseId}.txt` },
    tool_response: { fact },
    prompt_number: 1,
    toolUseId,
  };
  return harness.pending.enqueue(
    harness.sessionDbId,
    harness.session.contentSessionId,
    message,
  );
}

function claimFixedCohort(harness: Harness): {
  coveredIds: [number, number, number];
  siblingId: number;
} {
  const ids = FIXED_FACTS.map((fact, index) => enqueueFact(harness, fact, `cohort-${index}`));
  const siblingId = enqueueFact(harness, 'same-session sibling', 'sibling');
  const claimedIds = FIXED_FACTS.map(() => harness.pending.claimNextMessage(harness.sessionDbId)?.id);
  expect(claimedIds).toEqual(ids);
  (harness.session as ActiveSession & { claimedPendingMessageIds: number[] }).claimedPendingMessageIds = [...ids];
  return { coveredIds: ids as [number, number, number], siblingId };
}

function readRows(harness: Harness, ids: number[]): PendingRow[] {
  const placeholders = ids.map(() => '?').join(',');
  return harness.store.db.prepare(`
    SELECT id, status, last_failure_code, last_failure_at, tool_response
      FROM pending_messages
     WHERE id IN (${placeholders})
     ORDER BY id
  `).all(...ids) as PendingRow[];
}

function observationIds(harness: Harness): number[] {
  return (harness.store.db.prepare('SELECT id FROM observations ORDER BY id').all() as Array<{ id: number }>)
    .map(row => row.id);
}

function readFullRow(harness: Harness, id: number): Record<string, unknown> | null {
  return harness.store.db.prepare('SELECT * FROM pending_messages WHERE id = ?').get(id) as Record<string, unknown> | null;
}

function validCohortResponse(): string {
  return `
    <observation>
      <type>discovery</type>
      <title>P3 fixed cohort</title>
      <narrative>All fixed source facts were consumed.</narrative>
      <facts>
        ${FIXED_FACTS.map(fact => `<fact>${fact}</fact>`).join('\n')}
      </facts>
      <concepts><concept>data-integrity</concept></concepts>
      <files_read></files_read>
      <files_modified></files_modified>
    </observation>
  `;
}

describe('P3 minimal realtime data-preservation floor', () => {
  let openHarnesses: Harness[] = [];
  let originalFetch: typeof globalThis.fetch;
  let modeManagerSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    modeManagerSpy = spyOn(ModeManager, 'getInstance').mockImplementation(() => ({
      getActiveMode: () => ({
        name: 'code',
        prompts: {
          init: 'init prompt',
          observation: 'observation prompt',
          summary: 'summary prompt',
        },
        observation_types: [{ id: 'discovery' }, { id: 'bugfix' }, { id: 'refactor' }],
        observation_concepts: [],
      }),
    } as ModeManager));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const harness of openHarnesses) harness.store.close();
    openHarnesses = [];
    modeManagerSpy.mockRestore();
    mock.restore();
  });

  function harness(suffix: string): Harness {
    const created = makeHarness(suffix);
    openHarnesses.push(created);
    return created;
  }

  it('adds only the nullable failure columns and excludes failed rows from ordinary claim', () => {
    const h = harness('schema-claim');
    const columns = h.store.db.prepare('PRAGMA table_info(pending_messages)').all() as Array<{
      name: string;
      notnull: number;
    }>;
    const failureColumns = columns.filter(column => column.name.startsWith('last_failure_'));
    expect(failureColumns).toEqual([
      expect.objectContaining({ name: 'last_failure_code', notnull: 0 }),
      expect.objectContaining({ name: 'last_failure_at', notnull: 0 }),
    ]);

    const migrationDb = new Database(':memory:');
    try {
      new MigrationRunner(migrationDb).runAllMigrations();
      const migratedFailureColumns = (migrationDb.prepare('PRAGMA table_info(pending_messages)').all() as Array<{
        name: string;
        notnull: number;
      }>).filter(column => column.name.startsWith('last_failure_'));
      expect(migratedFailureColumns.map(({ name, notnull }) => ({ name, notnull })))
        .toEqual(failureColumns.map(({ name, notnull }) => ({ name, notnull })));
      expect(migrationDb.prepare('SELECT version FROM schema_versions WHERE version = 33').get())
        .toEqual({ version: 33 });
    } finally {
      migrationDb.close();
    }

    const failedId = enqueueFact(h, 'failed oldest', 'failed-oldest');
    const failedClaim = h.pending.claimNextMessage(h.sessionDbId);
    expect(failedClaim?.id).toBe(failedId);
    (h.pending as PendingMessageStore & {
      failClaimedBatch(ids: number[], code: string, failedAt?: number): number;
    }).failClaimedBatch([failedId], 'INVALID_RESPONSE', 1700000000000);

    const freshId = enqueueFact(h, 'fresh newer', 'fresh-newer');
    expect(h.pending.claimNextMessage(h.sessionDbId)?.id).toBe(freshId);
    expect(h.pending.claimNextMessage(h.sessionDbId)).toBeNull();
  });

  it('atomically stores cohort facts and deletes only the explicitly covered row IDs', async () => {
    const h = harness('success');
    const { coveredIds, siblingId } = claimFixedCohort(h);

    await processAgentResponse(
      validCohortResponse(),
      h.session,
      h.dbManager,
      h.sessionManager,
      undefined,
      17,
      1700000000000,
      'P3Test',
    );

    expect(readRows(h, coveredIds)).toEqual([]);
    expect(readRows(h, [siblingId])).toEqual([
      expect.objectContaining({
        id: siblingId,
        status: 'pending',
        last_failure_code: null,
        last_failure_at: null,
      }),
    ]);

    const stored = h.store.db.prepare('SELECT facts FROM observations ORDER BY id').all() as Array<{ facts: string }>;
    expect(stored).toHaveLength(1);
    expect(JSON.parse(stored[0].facts)).toEqual(FIXED_FACTS);
    console.log('P3_VERIFY_SUCCESS', JSON.stringify({
      cohort: coveredIds.map((id, index) => ({ id, sourceFact: FIXED_FACTS[index] })),
      siblingId,
      observationFacts: JSON.parse(stored[0].facts),
    }));
  });

  it('keeps the fixed cohort with a stable reason and no observation on invalid response', async () => {
    const h = harness('invalid');
    const { coveredIds, siblingId } = claimFixedCohort(h);
    const before = observationIds(h);

    await processAgentResponse(
      '',
      h.session,
      h.dbManager,
      h.sessionManager,
      undefined,
      0,
      1700000000000,
      'P3Test',
    );

    expect(observationIds(h)).toEqual(before);
    expect(readRows(h, coveredIds)).toEqual(coveredIds.map(id => expect.objectContaining({
      id,
      status: 'pending',
      last_failure_code: 'INVALID_RESPONSE',
      last_failure_at: expect.any(Number),
    })));
    expect(readRows(h, [siblingId])).toEqual([
      expect.objectContaining({ id: siblingId, last_failure_code: null }),
    ]);
    expect(h.pending.claimNextMessage(h.sessionDbId)?.id).toBe(siblingId);
    expect(h.pending.claimNextMessage(h.sessionDbId)).toBeNull();
    console.log('P3_VERIFY_INVALID', JSON.stringify({ coveredIds, siblingId, observationIds: observationIds(h) }));
  });

  it('rolls back a partial observation write before failure-coding the covered cohort', async () => {
    const h = harness('partial-store');
    const { coveredIds, siblingId } = claimFixedCohort(h);
    h.store.db.run(`
      CREATE TRIGGER p3_fail_second_observation
      BEFORE INSERT ON observations
      WHEN NEW.title = 'force second insert failure'
      BEGIN
        SELECT RAISE(ABORT, 'p3 injected storage failure');
      END
    `);
    const response = `
      <observation>
        <type>discovery</type><title>first insert</title><narrative>first</narrative>
        <facts><fact>${FIXED_FACTS[0]}</fact></facts><concepts></concepts>
        <files_read></files_read><files_modified></files_modified>
      </observation>
      <observation>
        <type>discovery</type><title>force second insert failure</title><narrative>second</narrative>
        <facts><fact>${FIXED_FACTS[1]}</fact></facts><concepts></concepts>
        <files_read></files_read><files_modified></files_modified>
      </observation>
    `;

    await expect(processAgentResponse(
      response,
      h.session,
      h.dbManager,
      h.sessionManager,
      undefined,
      0,
      1700000000000,
      'P3Test',
    )).rejects.toThrow('p3 injected storage failure');

    expect(observationIds(h)).toEqual([]);
    expect(readRows(h, coveredIds)).toEqual(coveredIds.map(id => expect.objectContaining({
      id,
      status: 'pending',
      last_failure_code: 'STORE_FAILED',
    })));
    expect(readRows(h, [siblingId])).toEqual([
      expect.objectContaining({ id: siblingId, last_failure_code: null }),
    ]);
    console.log('P3_VERIFY_ATOMIC_FAILURE', JSON.stringify({ coveredIds, siblingId, observationIds: observationIds(h) }));
  });

  it('preserves and failure-codes the covered cohort when memory-session registration fails', async () => {
    const h = harness('registration-failure');
    const { coveredIds, siblingId } = claimFixedCohort(h);
    const before = observationIds(h);
    h.store.ensureMemorySessionIdRegistered = mock(() => {
      throw new Error('p3 injected registration failure');
    });

    await expect(processAgentResponse(
      validCohortResponse(),
      h.session,
      h.dbManager,
      h.sessionManager,
      undefined,
      0,
      1700000000000,
      'P3Test',
    )).rejects.toThrow('p3 injected registration failure');

    expect(observationIds(h)).toEqual(before);
    expect(readRows(h, coveredIds)).toEqual(coveredIds.map(id => expect.objectContaining({
      id,
      status: 'pending',
      last_failure_code: 'STORE_FAILED',
      last_failure_at: expect.any(Number),
    })));
    expect(readRows(h, [siblingId])).toEqual([
      expect.objectContaining({ id: siblingId, status: 'pending', last_failure_code: null }),
    ]);
    expect(h.pending.claimNextMessage(h.sessionDbId)?.id).toBe(siblingId);
    expect(h.pending.claimNextMessage(h.sessionDbId)).toBeNull();
    console.log('P3_VERIFY_REGISTRATION_FAILURE', JSON.stringify({ coveredIds, siblingId, observationIds: observationIds(h) }));
  });

  it('failure-codes only the covered cohort on a non-provider hard-stop clear branch', async () => {
    const h = harness('hard-stop');
    const { coveredIds, siblingId } = claimFixedCohort(h);
    const before = observationIds(h);
    const finalized: number[] = [];

    await handleGeneratorExit(h.session, 'shutdown', {
      sessionManager: h.sessionManager,
      completionHandler: {
        finalizeSession: (id: number) => { finalized.push(id); },
      } as any,
      restartGenerator: () => { throw new Error('hard stop must not restart'); },
    });

    expect(observationIds(h)).toEqual(before);
    expect(readRows(h, coveredIds)).toEqual(coveredIds.map(id => expect.objectContaining({
      id,
      status: 'pending',
      last_failure_code: 'HARD_STOP_SHUTDOWN',
    })));
    expect(readRows(h, [siblingId])).toEqual([
      expect.objectContaining({ id: siblingId, last_failure_code: null }),
    ]);
    expect(finalized).toEqual([h.sessionDbId]);
    console.log('P3_VERIFY_HARD_STOP', JSON.stringify({ coveredIds, siblingId, finalized }));
  });

  it('failure-codes a tracked processing cohort before completed-session short-circuit', () => {
    const h = harness('completed-finalize');
    const { coveredIds, siblingId } = claimFixedCohort(h);
    h.store.markSessionCompleted(h.sessionDbId);
    const completedBefore = h.store.getSessionById(h.sessionDbId);
    const broadcasts: number[] = [];
    const completionHandler = new SessionCompletionHandler(
      h.sessionManager,
      { broadcastSessionCompleted: (id: number) => broadcasts.push(id) } as any,
      h.dbManager,
    );

    completionHandler.finalizeSession(h.sessionDbId);

    expect(readRows(h, coveredIds)).toEqual(coveredIds.map(id => expect.objectContaining({
      id,
      status: 'pending',
      last_failure_code: 'FINALIZE',
      last_failure_at: expect.any(Number),
    })));
    expect(readRows(h, [siblingId])).toEqual([
      expect.objectContaining({ id: siblingId, status: 'pending', last_failure_code: null }),
    ]);
    expect(h.store.getSessionById(h.sessionDbId)).toEqual(completedBefore);
    expect(broadcasts).toEqual([]);
    console.log('P3_VERIFY_COMPLETED_FINALIZE', JSON.stringify({ coveredIds, siblingId }));
  });

  it('S-T2 emits the newer eligible row through the real scheduler and makes forward progress', async () => {
    const h = harness('forward-progress');
    const oldFailedId = enqueueFact(h, 'old failed fact', 'old-failed');
    expect(h.pending.claimNextMessage(h.sessionDbId)?.id).toBe(oldFailedId);
    (h.pending as PendingMessageStore & {
      failClaimedBatch(ids: number[], code: string, failedAt?: number): number;
    }).failClaimedBatch([oldFailedId], 'INVALID_RESPONSE', 1700000000000);
    const oldBefore = readFullRow(h, oldFailedId);

    const freshId = enqueueFact(h, 'fresh forward fact', 'fresh-forward');
    const iterator = h.sessionManager.getMessageIterator(h.sessionDbId);
    const emitted = await Promise.race([
      iterator.next(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('S-T2 scheduler timeout')), 500)),
    ]);
    expect(emitted.done).toBe(false);
    expect(emitted.value?._persistentId).toBe(freshId);

    await processAgentResponse(
      `
        <observation>
          <type>discovery</type><title>fresh forward progress</title>
          <narrative>fresh forward fact persisted</narrative>
          <facts><fact>fresh forward fact</fact></facts><concepts></concepts>
          <files_read></files_read><files_modified></files_modified>
        </observation>
      `,
      h.session,
      h.dbManager,
      h.sessionManager,
      undefined,
      0,
      1700000000000,
      'P3Test',
    );
    h.session.abortController.abort();

    expect(h.store.db.prepare("SELECT COUNT(*) AS count FROM observations WHERE narrative = 'fresh forward fact persisted'").get())
      .toEqual({ count: 1 });
    expect(readFullRow(h, oldFailedId)).toEqual(oldBefore);
    console.log('P3_VERIFY_ST2', JSON.stringify({ oldFailedId, freshId, emittedId: emitted.value?._persistentId }));
  });

  it('records NEW_403 through the real OpenRouter fetch boundary without creating an observation', async () => {
    const h = harness('provider-403');
    const cohortIds = FIXED_FACTS.map((fact, index) => enqueueFact(h, fact, `provider-403-${index}`));
    const siblingId = enqueueFact(h, 'same-session 403 sibling', 'provider-403-sibling');
    const before = observationIds(h);

    mkdirSync(dirname(USER_SETTINGS_PATH), { recursive: true });
    writeFileSync(USER_SETTINGS_PATH, JSON.stringify({
      CLAUDE_MEM_OPENROUTER_API_KEY: 'p3-isolated-test-key',
      CLAUDE_MEM_OPENROUTER_MODEL: 'p3-test-model',
    }));

    let fetchCount = 0;
    globalThis.fetch = mock(async () => {
      fetchCount += 1;
      if (fetchCount === 1) {
        return new Response(JSON.stringify({
          choices: [{ message: { role: 'assistant', content: '<skip_summary reason="p3 init"/>' } }],
          usage: { total_tokens: 1 },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      const claimedRows = FIXED_FACTS.map(() => h.pending.claimNextMessage(h.sessionDbId));
      expect(claimedRows.map(row => row?.id)).toEqual(cohortIds);
      h.session.claimedPendingMessageIds = [...cohortIds];
      return new Response('RESOURCE_EXHAUSTED: quota exceeded', { status: 403 });
    }) as typeof fetch;

    const provider = new OpenRouterProvider(h.dbManager, h.sessionManager);
    h.sessionManager.getMessageIterator = (async function* () {
      yield h.pending.toPendingMessage({
        ...readFullRow(h, cohortIds[0]),
        id: cohortIds[0],
      } as any) as any;
    }) as any;
    await expect(provider.startSession(h.session)).rejects.toThrow('status 403');

    expect(fetchCount).toBe(2);
    expect(observationIds(h)).toEqual(before);
    expect(readRows(h, cohortIds)).toEqual(cohortIds.map(id => expect.objectContaining({
      id,
      status: 'pending',
      last_failure_code: 'NEW_403',
      last_failure_at: expect.any(Number),
    })));
    expect(readRows(h, [siblingId])).toEqual([
      expect.objectContaining({ id: siblingId, status: 'pending', last_failure_code: null }),
    ]);
    expect(h.pending.claimNextMessage(h.sessionDbId)?.id).toBe(siblingId);
    expect(h.pending.claimNextMessage(h.sessionDbId)).toBeNull();
    console.log('P3_VERIFY_403', JSON.stringify({
      cohort: cohortIds.map((id, index) => ({ id, sourceFact: FIXED_FACTS[index] })),
      siblingId,
      fetchCount,
      observationIds: observationIds(h),
    }));
  });

  it('S-F1 contains no second delivery ledger, mapping, sidecar, or failed-row replay edge', () => {
    const h = harness('subtractive');
    const tableNames = (h.store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
      .map(row => row.name.toLowerCase());
    expect(tableNames.filter(name => /(delivery|receipt|dlq|dead.?letter|observation.?map)/.test(name))).toEqual([]);

    const baselineSchema = Bun.spawnSync({
      cmd: ['git', 'show', 'e3cc382f:src/services/sqlite/schema.sql'],
      cwd: new URL('../..', import.meta.url).pathname,
      env: process.env,
    });
    expect(baselineSchema.exitCode).toBe(0);
    const baselineDb = new Database(':memory:');
    type PragmaColumn = { name: string; type: string; notnull: number };
    let baselineColumns: PragmaColumn[];
    try {
      baselineDb.exec(baselineSchema.stdout.toString());
      baselineColumns = baselineDb.prepare('PRAGMA table_info(pending_messages)').all() as typeof baselineColumns;
    } finally {
      baselineDb.close();
    }
    const currentColumns = h.store.db.prepare('PRAGMA table_info(pending_messages)').all() as PragmaColumn[];
    const baselineNames = new Set(baselineColumns.map(column => column.name));
    const currentNames = new Set(currentColumns.map(column => column.name));
    expect(baselineColumns.filter(column => !currentNames.has(column.name))).toEqual([]);
    expect(currentColumns.filter(column => !baselineNames.has(column.name)).map(({ name, type, notnull }) => ({ name, type, notnull })))
      .toEqual([
        { name: 'last_failure_code', type: 'TEXT', notnull: 0 },
        { name: 'last_failure_at', type: 'INTEGER', notnull: 0 },
      ]);

    const pendingSource = readFileSync(new URL('../../src/services/sqlite/PendingMessageStore.ts', import.meta.url), 'utf8');
    expect(pendingSource).not.toMatch(/SET\s+last_failure_code\s*=\s*NULL/i);
    expect(pendingSource).not.toMatch(/(retry|backoff|replay).{0,120}last_failure_code|last_failure_code.{0,120}(retry|backoff|replay)/is);

    const ownedDiff = Bun.spawnSync({
      cmd: [
        'git', 'diff', '--unified=0', 'e3cc382f', '--',
        'src/services/sqlite',
        'src/services/queue',
        'src/services/worker',
        'src/services/worker-types.ts',
      ],
      cwd: new URL('../..', import.meta.url).pathname,
      env: process.env,
    });
    expect(ownedDiff.exitCode).toBe(0);
    const untrackedRuntime = Bun.spawnSync({
      cmd: ['git', 'ls-files', '--others', '--exclude-standard', '--', 'src/services/sqlite', 'src/services/queue', 'src/services/worker', 'src/services/worker-types.ts'],
      cwd: new URL('../..', import.meta.url).pathname,
      env: process.env,
    });
    expect(untrackedRuntime.exitCode).toBe(0);
    const untrackedAdded = untrackedRuntime.stdout.toString().trim().split('\n').filter(Boolean)
      .flatMap(file => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8').split('\n').map(line => `+${line}`));
    const addedLines = ownedDiff.stdout.toString()
      .split('\n')
      .filter(line => line.startsWith('+') && !line.startsWith('+++'))
      .concat(untrackedAdded)
      .join('\n');
    expect(addedLines).not.toMatch(/\b(writeFile(?:Sync)?|appendFile(?:Sync)?|createWriteStream|Bun\.write|openSync)\s*\(/);
    expect(addedLines).not.toMatch(/\b(receipt|dead.?letter|DLQ|delivery.?ledger|observation.?mapping)\b|new\s+Map[^\n]*(?:observation|pending|delivery)/i);
    expect(addedLines).not.toMatch(/SET\s+last_failure_code\s*=\s*NULL/i);
    expect(addedLines).not.toMatch(/(?:retry|backoff|replay|resetProcessingToPending)[^\n]*(?:last_failure|failed.?row)|(?:last_failure|failed.?row)[^\n]*(?:retry|backoff|replay|eligible)/i);
    console.log('P3_VERIFY_SF1', JSON.stringify({
      tableCount: tableNames.length,
      baselinePendingColumnCount: baselineColumns.length,
      currentPendingColumnCount: currentColumns.length,
      forbiddenTables: [],
    }));
  });
});
