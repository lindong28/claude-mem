// F4 foundation: classified provider errors with extensible kind field.
export type ProviderErrorClass =
  | 'transient'
  | 'unrecoverable'
  | 'rate_limit'
  | 'quota_exhausted'
  | 'auth_invalid'
  | (string & {}); // open union: providers may emit custom kinds

export class ClassifiedProviderError extends Error {
  readonly kind: ProviderErrorClass;
  readonly retryAfterMs?: number;
  readonly status?: number;
  readonly cause: unknown;

  constructor(message: string, opts: {
    kind: ProviderErrorClass;
    cause: unknown;
    retryAfterMs?: number;
    status?: number;
  }) {
    super(message);
    this.name = 'ClassifiedProviderError';
    this.kind = opts.kind;
    this.cause = opts.cause;
    if (opts.retryAfterMs !== undefined) {
      this.retryAfterMs = opts.retryAfterMs;
    }
    if (opts.status !== undefined) {
      this.status = opts.status;
    }
  }
}

export function isClassified(err: unknown): err is ClassifiedProviderError {
  return err instanceof ClassifiedProviderError;
}

function findStructuredStatus(error: unknown, seen: Set<unknown> = new Set()): number | undefined {
  if (error === null || error === undefined || seen.has(error)) return undefined;
  seen.add(error);
  if (typeof error === 'object') {
    const candidate = error as { status?: unknown; cause?: unknown };
    if (typeof candidate.status === 'number') return candidate.status;
    return findStructuredStatus(candidate.cause, seen);
  }
  return undefined;
}

function containsStatus403Text(error: unknown, seen: Set<unknown> = new Set()): boolean {
  if (error === null || error === undefined || seen.has(error)) return false;
  seen.add(error);
  if (typeof error === 'object') {
    const candidate = error as { message?: unknown; cause?: unknown };
    if (typeof candidate.message === 'string' && /(?:status(?:\s+code)?|error|api|http)\s*[:=]?\s*403\b/i.test(candidate.message)) {
      return true;
    }
    return containsStatus403Text(candidate.cause, seen);
  }
  return typeof error === 'string' && /(?:status(?:\s+code)?|error|api|http)\s*[:=]?\s*403\b/i.test(error);
}

export function providerFailureCode(error: unknown): string {
  const structuredStatus = findStructuredStatus(error);
  if (structuredStatus === 403) return 'NEW_403';
  if (structuredStatus === undefined && containsStatus403Text(error)) return 'NEW_403';
  if (!isClassified(error)) return 'PROVIDER_TRANSIENT';
  switch (error.kind) {
    case 'auth_invalid': return 'PROVIDER_AUTH_INVALID';
    case 'quota_exhausted': return 'PROVIDER_QUOTA_EXHAUSTED';
    case 'rate_limit': return 'PROVIDER_RATE_LIMIT';
    case 'unrecoverable': return 'PROVIDER_UNRECOVERABLE';
    case 'transient': return 'PROVIDER_TRANSIENT';
    default: return 'PROVIDER_OTHER';
  }
}
