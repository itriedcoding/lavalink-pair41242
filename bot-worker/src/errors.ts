/** Error whose message is safe to return to the Discord user. */
export class WorkerError extends Error {}

/** Caller sent an unreadable request; answers with 400 instead of 409. */
export class BadRequestError extends WorkerError {}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
