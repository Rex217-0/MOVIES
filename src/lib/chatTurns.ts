/**
 * Pure helpers for the Director's Chair transcript.
 *
 * They live here rather than inside the component so the two decisions that
 * lost the conversation are covered by tests: which turns are restored, and
 * which turns the router receives.
 */

export interface TranscriptTurn {
  role: 'user' | 'assistant';
  content: string;
  error?: string;
}

/**
 * The transcript to display: the restored thread first, then the turns added in
 * this session.
 *
 * Hydration is async, so the user can add a turn before it lands. Concatenating
 * keeps both; assigning the response over the live turns is what erased a
 * message the user had already typed. A turn cannot appear in both lists,
 * because a turn is only persisted once its reply returns, and the reply is
 * requested after hydration has settled.
 */
export function mergeTranscript<T extends TranscriptTurn>(restored: T[], local: T[]): T[] {
  return [...restored, ...local];
}

/**
 * The message list sent to the router.
 *
 * Failed turns are dropped, because replaying an error string as assistant
 * content would feed the model its own outage notice. The new directive is
 * already part of the transcript the caller passes in.
 */
export function toPayload(
  turns: TranscriptTurn[],
): Array<{ role: 'user' | 'assistant'; content: string }> {
  return turns
    .filter((turn) => !turn.error)
    .map((turn) => ({ role: turn.role, content: turn.content }));
}
