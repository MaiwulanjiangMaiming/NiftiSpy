/** Message for a caught value without leaking `any` into call sites. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Abort detection for fetch/fs errors that cross the extension boundary. */
export function isAbortError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { name?: string }).name === 'AbortError';
}

/** Coerce a caught value to an Error for state that must hold one. */
export function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}
