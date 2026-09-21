import type { Endpoint } from '../../types/api';

export type StateTone = 'ok' | 'warn' | 'danger' | 'neutral';

export interface EndpointFacts {
  /** What the operator asked for. */
  intent: { label: string; tone: StateTone };
  /** What HookuBit is actually doing about it. */
  platform: { label: string; tone: StateTone };
  /**
   * Whose decision the current situation is. Rendered as a small caption, and
   * it is the part that tells someone which of the two columns to act on.
   */
  source: 'yours' | 'platform' | 'none';
  /** One sentence naming the fix, or null when nothing is wrong. */
  remedy: string | null;
}

/**
 * Two facts about an endpoint, kept apart.
 *
 * ## Why two columns and not one status
 *
 * "Your setting" is what you asked for. "HookuBit" is what we are doing about
 * it. An endpoint you still want delivering that WE stopped is a completely
 * different problem from one you paused yourself, and they are fixed in
 * different ways — the first by clearing a breaker, the second by changing your
 * mind. Folded into one column they read as the same amber badge, and the
 * operator has to know the product well enough to tell which they are looking
 * at.
 *
 * It is also the only honest rendering of the data. `enabled` is operator
 * intent and `status` is the platform's verdict; they are separate columns in
 * the database precisely because they disagree, and an endpoint auto-disabled
 * after too many failures still reads `enabled: true`.
 *
 * ## Why "no live secret" is a platform state and not a warning badge
 *
 * We refuse to make an unsigned request, so an endpoint without a live signing
 * secret is not delivering — whatever the operator set. That is the platform
 * doing something, not a note about configuration, and `POST …/enable` answers
 * 409 until a secret exists. Putting it in the same column as "stopped by us"
 * is what makes "Resume" visibly not the fix.
 */
export function endpointFacts(
  endpoint: Pick<Endpoint, 'status' | 'enabled' | 'has_live_secret'>,
): EndpointFacts {
  if (endpoint.status === 'deleted') {
    return {
      intent: { label: 'Deleted', tone: 'neutral' },
      platform: { label: 'Kept for the record', tone: 'neutral' },
      source: 'yours',
      remedy: null,
    };
  }

  if (!endpoint.enabled || endpoint.status === 'paused') {
    return {
      intent: { label: 'Paused by you', tone: 'warn' },
      platform: { label: 'Not sending', tone: 'neutral' },
      source: 'yours',
      remedy: 'Your decision. Resume it when you are ready — new events create nothing for it.',
    };
  }

  // Checked BEFORE the breaker: an endpoint with no secret cannot be resumed
  // at all, so naming the breaker first would offer a fix that 409s.
  if (!endpoint.has_live_secret) {
    return {
      intent: { label: 'On', tone: 'ok' },
      platform: { label: 'No secret yet', tone: 'warn' },
      source: 'platform',
      remedy: 'We will not make an unsigned request. Issue a signing secret and it starts sending.',
    };
  }

  if (endpoint.status === 'disabled') {
    return {
      intent: { label: 'On', tone: 'ok' },
      platform: { label: 'Stopped by us', tone: 'danger' },
      source: 'platform',
      remedy:
        'You still want this endpoint delivering; we stopped sending because it kept failing. Starting it again is what resumes delivery — you do not need to change your setting.',
    };
  }

  return {
    intent: { label: 'On', tone: 'ok' },
    platform: { label: 'Delivering', tone: 'ok' },
    source: 'none',
    remedy: null,
  };
}

/** The small uppercase caption under the pair. */
export const SOURCE_LABEL: Record<EndpointFacts['source'], string | null> = {
  yours: 'YOUR DECISION',
  platform: 'PLATFORM DECISION',
  none: null,
};
