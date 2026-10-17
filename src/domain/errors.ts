export type LensFailureKind =
  | 'challenge'
  | 'loading'
  | 'empty'
  | 'parser'
  | 'browser'
  | 'timeout';

export class ServiceError extends Error {
  public override readonly name = 'ServiceError';

  public constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode = 500,
    public readonly retryable = false,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export class ValidationError extends ServiceError {
  public constructor(message: string, details?: Record<string, unknown>) {
    super('validation_error', message, 400, false, details);
  }
}

export class AuthenticationError extends ServiceError {
  public constructor() {
    super('unauthorized', 'A valid API key is required.', 401, false);
  }
}

export class RateLimitError extends ServiceError {
  public constructor(limit: number) {
    super(
      'rate_limited',
      'The API rate limit was exceeded; retry after the current window.',
      429,
      true,
      { limit },
    );
  }
}

export class ConflictError extends ServiceError {
  public constructor(message: string, details?: Record<string, unknown>) {
    super('conflict', message, 409, false, details);
  }
}

export class RemoteFetchError extends ServiceError {
  public constructor(message: string, retryable = false, details?: Record<string, unknown>) {
    super('remote_fetch_error', message, 400, retryable, details);
  }
}

export class QueueFullError extends ServiceError {
  public constructor(limit: number) {
    super(
      'queue_full',
      'The search queue is at capacity; retry after queued work completes.',
      429,
      true,
      { limit },
    );
  }
}

export class NotFoundError extends ServiceError {
  public constructor(resource: string, id: string) {
    super('not_found', `${resource} '${id}' was not found.`, 404, false, {
      resource,
      id,
    });
  }
}

export class LensAutomationError extends ServiceError {
  public constructor(
    public readonly kind: LensFailureKind,
    message: string,
    retryable = kind === 'loading' || kind === 'browser' || kind === 'timeout',
    details?: Record<string, unknown>,
  ) {
    super(`lens_${kind}`, message, 502, retryable, details);
  }
}
