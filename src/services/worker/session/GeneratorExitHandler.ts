import type { ActiveSession } from '../../worker-types.js';
import type { SessionManager } from '../SessionManager.js';
import type { SessionCompletionHandler } from './SessionCompletionHandler.js';
import { logger } from '../../../utils/logger.js';
import { getSdkProcessForSession, ensureSdkProcessExit } from '../../../supervisor/process-registry.js';
import { RestartGuard } from '../RestartGuard.js';

export interface GeneratorExitDependencies {
  sessionManager: SessionManager;
  completionHandler: SessionCompletionHandler;
  restartGenerator: (session: ActiveSession, source: string) => void;
}

function isHardStopReason(reason: ActiveSession['abortReason']): boolean {
  return reason === 'shutdown' ||
    reason === 'provider-failure' ||
    reason === 'external-sigterm' ||
    reason === 'restart-guard' ||
    reason === 'overflow' ||
    reason === 'quota' ||
    (typeof reason === 'string' && reason.startsWith('quota:'));
}

/**
 * Post-generator-exit handler. Under the new model:
 *   - 'processing' rows reset to 'pending' on next generator start (handled by SessionManager.getMessageIterator).
 *   - Claimed rows are preserved with a stable failure code; unclaimed siblings remain untouched.
 *
 * Behavior:
 *   1. Always: ensure SDK subprocess is dead.
 *   2. Hard-stop reasons (shutdown / restart-guard / overflow / quota): failure-code the claimed batch and finalize.
 *   3. Otherwise (idle / natural completion):
 *        - If 0 pending → finalize.
 *        - If pending > 0 and restart guard allows → respawn with backoff.
 *        - If guard tripped → failure-code the claimed batch and finalize.
 */
export async function handleGeneratorExit(
  session: ActiveSession,
  reason: ActiveSession['abortReason'],
  deps: GeneratorExitDependencies
): Promise<void> {
  const { sessionManager, completionHandler, restartGenerator } = deps;
  const sessionDbId = session.sessionDbId;

  const tracked = getSdkProcessForSession(sessionDbId);
  if (tracked && !tracked.process.killed && tracked.process.exitCode === null) {
    await ensureSdkProcessExit(tracked, 5000);
  }

  session.generatorPromise = null;
  session.currentProvider = null;

  const pendingStore = sessionManager.getPendingMessageStore();

  const terminateSession = (logPrefix: string, failureCode?: string) => {
    try {
      if (failureCode) {
        try {
          sessionManager.failClaimedBatch(sessionDbId, failureCode);
        } catch (e) {
          const normalized = e instanceof Error ? e : new Error(String(e));
          logger.error('SESSION', `${logPrefix} pending preservation failed; continuing finalization`, {
            sessionId: sessionDbId,
            reason
          }, normalized);
        }
      }
      try {
        completionHandler.finalizeSession(sessionDbId);
      } catch (e) {
        const normalized = e instanceof Error ? e : new Error(String(e));
        logger.error('SESSION', `${logPrefix} finalization failed; forcing in-memory session removal`, {
          sessionId: sessionDbId,
          reason
        }, normalized);
      }
    } finally {
      sessionManager.removeSessionImmediate(sessionDbId);
    }
  };

  if (isHardStopReason(reason)) {
    logger.info('SESSION', `Generator exited with hard-stop reason — preserving claimed batch and finalizing`, {
      sessionId: sessionDbId,
      reason
    });
    const normalizedReason = typeof reason === 'string' && reason.startsWith('quota:') ? 'quota' : reason;
    const failureCode = `HARD_STOP_${String(normalizedReason ?? 'UNKNOWN').replace(/-/g, '_').toUpperCase()}`;
    terminateSession('Hard-stop', failureCode);
    return;
  }

  let pendingCount: number;
  try {
    pendingCount = pendingStore.getPendingCount(sessionDbId);
  } catch (e) {
    const normalized = e instanceof Error ? e : new Error(String(e));
    logger.error('SESSION', 'Error during recovery pending-count check; aborting to prevent leaks', {
      sessionId: sessionDbId
    }, normalized);
    terminateSession('Recovery abort', 'PENDING_COUNT_FAILED');
    return;
  }

  if (pendingCount === 0) {
    session.restartGuard?.recordSuccess();
    session.consecutiveRestarts = 0;
    terminateSession('Natural completion');
    return;
  }

  if (!session.restartGuard) session.restartGuard = new RestartGuard();
  const restartAllowed = session.restartGuard.recordRestart();
  session.consecutiveRestarts = (session.consecutiveRestarts || 0) + 1;

  if (!restartAllowed) {
    logger.error('SESSION', `CRITICAL: Restart guard tripped — session is dead, preserving claimed batch and terminating`, {
      sessionId: sessionDbId,
      pendingCount,
      restartsInWindow: session.restartGuard.restartsInWindow,
      windowMs: session.restartGuard.windowMs,
      maxRestarts: session.restartGuard.maxRestarts,
      consecutiveFailures: session.restartGuard.consecutiveFailuresSinceSuccess,
      maxConsecutiveFailures: session.restartGuard.maxConsecutiveFailures,
    });
    session.consecutiveRestarts = 0;
    terminateSession('Restart guard', 'RESTART_GUARD');
    return;
  }

  logger.info('SESSION', `Restarting generator after exit with pending work`, {
    sessionId: sessionDbId,
    pendingCount,
    consecutiveRestarts: session.consecutiveRestarts,
    restartsInWindow: session.restartGuard.restartsInWindow,
    maxRestarts: session.restartGuard.maxRestarts,
  });

  const oldController = session.abortController;
  session.abortController = new AbortController();
  oldController.abort();

  const backoffMs = Math.min(1000 * Math.pow(2, session.consecutiveRestarts - 1), 8000);

  if (session.respawnTimer) {
    clearTimeout(session.respawnTimer);
  }
  session.respawnTimer = setTimeout(() => {
    session.respawnTimer = undefined;
    const stillExists = deps.sessionManager.getSession(sessionDbId);
    if (stillExists && !stillExists.generatorPromise) {
      restartGenerator(stillExists, 'pending-work-restart');
    }
  }, backoffMs);
}
