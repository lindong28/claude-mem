import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { SessionRoutes } from '../../../src/services/worker/http/routes/SessionRoutes.js';
import { SettingsDefaultsManager } from '../../../src/shared/SettingsDefaultsManager.js';
import type { ActiveSession } from '../../../src/services/worker-types.js';

function makeSession(): ActiveSession {
  return {
    sessionDbId: 42,
    contentSessionId: 'p3-route-content',
    memorySessionId: 'p3-route-memory',
    project: 'p3-project',
    userPrompt: 'p3 prompt',
    conversationHistory: [],
    lastPromptNumber: 1,
    cumulativeInputTokens: 0,
    cumulativeOutputTokens: 0,
    pendingMessages: [],
    claimedPendingMessageIds: [101, 102, 103],
    abortController: new AbortController(),
    generatorPromise: null,
    currentProvider: null,
    startTime: Date.now(),
  } as ActiveSession;
}

describe('SessionRoutes P3 scheduler failure preservation', () => {
  let settingsSpy: ReturnType<typeof spyOn>;
  let sessionsToCleanup: ActiveSession[];

  beforeEach(() => {
    sessionsToCleanup = [];
    settingsSpy = spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(() => ({
      CLAUDE_MEM_PROVIDER: 'claude',
      CLAUDE_MEM_TIER_ROUTING_ENABLED: 'false',
    } as ReturnType<typeof SettingsDefaultsManager.loadFromFile>));
  });

  afterEach(() => {
    for (const session of sessionsToCleanup) {
      if (session.respawnTimer) {
        clearTimeout(session.respawnTimer);
        session.respawnTimer = undefined;
      }
    }
    settingsSpy.mockRestore();
    mock.restore();
  });

  async function runRejectedClaude(error: Error) {
    const session = makeSession();
    sessionsToCleanup.push(session);
    const resetProcessingToPending = mock(() => 3);
    const failClaimedBatch = mock(() => 3);
    const removeSessionImmediate = mock(() => {});
    const pendingStore = {
      getPendingCount: mock(() => 1),
      peekPendingTypes: mock(() => []),
      resetProcessingToPending,
    };
    const sessionManager = {
      getSession: mock(() => session),
      getPendingMessageStore: mock(() => pendingStore),
      failClaimedBatch,
      removeSessionImmediate,
    };
    const sdkAgent = { startSession: mock(() => Promise.reject(error)) };
    const completionHandler = { finalizeSession: mock(() => {}) };
    const routes = new SessionRoutes(
      sessionManager as any,
      {} as any,
      sdkAgent as any,
      { startSession: mock(() => Promise.resolve()) } as any,
      { startSession: mock(() => Promise.resolve()) } as any,
      {} as any,
      {} as any,
      completionHandler as any,
    );

    routes.ensureGeneratorRunning(session.sessionDbId, 'p3-route-test');
    const generatorPromise = session.generatorPromise;
    expect(generatorPromise).not.toBeNull();
    await generatorPromise;
    return { session, resetProcessingToPending, failClaimedBatch, removeSessionImmediate, completionHandler };
  }

  it('failure-codes a raw Claude 403 batch and does not reset or schedule restart', async () => {
    const result = await runRejectedClaude(new Error('Request failed with status code 403'));
    expect(result.failClaimedBatch).toHaveBeenCalledWith(42, 'NEW_403');
    expect(result.resetProcessingToPending).not.toHaveBeenCalled();
    expect(result.session.respawnTimer).toBeUndefined();
    expect(result.completionHandler.finalizeSession).toHaveBeenCalledWith(42);
  });

  it('failure-codes external SIGTERM and does not reset or schedule restart', async () => {
    const result = await runRejectedClaude(new Error('Claude subprocess exited with signal SIGTERM'));
    expect(result.failClaimedBatch).toHaveBeenCalledWith(42, 'EXTERNAL_SIGTERM');
    expect(result.resetProcessingToPending).not.toHaveBeenCalled();
    expect(result.session.respawnTimer).toBeUndefined();
    expect(result.completionHandler.finalizeSession).toHaveBeenCalledWith(42);
  });
});
