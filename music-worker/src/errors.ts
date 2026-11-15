/** Error whose message is safe to return to the Discord user. */
export class MusicError extends Error {}

/** Caller sent an unreadable request; answers with 400 instead of 409. */
export class BadRequestError extends MusicError {}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
