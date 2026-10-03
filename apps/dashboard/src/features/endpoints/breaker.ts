/**
 * What an endpoint's two "stopped" states are allowed to say.
 *
 * `enabled` is operator intent and `status` is the circuit breaker's verdict,
 * and the pair is the most easily misread thing in the product:
 *
 *   enabled: true,  status: 'disabled' — THE PLATFORM stopped it, after a run
 *                                        of consecutive failures. Nobody chose
 *                                        this.
 *   enabled: false                     — A PERSON stopped it.
 *
 * They must not share an affordance. Re-enabling after the breaker opened does
 * nothing to the consumer that was refusing the requests: the next run of
 * failures re-opens the breaker, and the queued deliveries that resume in the
 * meantime arrive at a still-broken consumer as a burst. So the control says
 * "Resume deliveries ANYWAY" — it offers the action without claiming anything
 * has been fixed. "Enable", "Restore" or "Fix" would all claim exactly that.
 *
 * The wording lives here, as data, rather than inline in JSX, because it is the
 * part worth testing and this workspace has no DOM (see HANDOFF.md).
 */
import type { Endpoint } from '../../types/api';

export type EndpointCondition =
  /** Delivering: operator wants it on and the breaker has not intervened. */
  | 'delivering'
  /** The breaker opened. `enabled` is still true — the operator never chose this. */
  | 'auto_disabled'
  /** A person paused it, or it is waiting for a signing secret. */
  | 'operator_paused'
  /** Soft-deleted. Kept forever for the ledger; every write answers 409. */
  | 'deleted';

export function endpointCondition(
  endpoint: Pick<Endpoint, 'enabled' | 'status'>,
): EndpointCondition {
  if (endpoint.status === 'deleted') return 'deleted';
  if (endpoint.enabled && endpoint.status === 'active') return 'delivering';
  if (endpoint.enabled) return 'auto_disabled';
  return 'operator_paused';
}

export interface EndpointControls {
  condition: EndpointCondition;
  /** Null when resuming is not an action that makes sense in this state. */
  resumeLabel: string | null;
  /** Null when there is nothing to pause. */
  pauseLabel: string | null;
  /** Title of the resume confirmation. */
  resumeTitle: string;
  /** The confirm button in that dialog. */
  resumeConfirmLabel: string;
  /**
   * True when resuming must be presented as a decision with a consequence
   * rather than as an ordinary control.
   */
  resumeIsRisky: boolean;
}

export function endpointControls(
  endpoint: Pick<Endpoint, 'enabled' | 'status'>,
): EndpointControls {
  const condition = endpointCondition(endpoint);

  if (condition === 'deleted') {
    return {
      condition,
      resumeLabel: null,
      pauseLabel: null,
      resumeTitle: 'Resume deliveries?',
      resumeConfirmLabel: 'Resume',
      resumeIsRisky: false,
    };
  }

  if (condition === 'auto_disabled') {
    return {
      condition,
      // "anyway" is the whole point: it offers the action and refuses to imply
      // the consumer has been repaired.
      resumeLabel: 'Resume deliveries anyway',
      // Pausing an auto-disabled endpoint is not a no-op. It converts the
      // platform's verdict into a recorded operator decision with a reason,
      // which is what makes the delivery gap explainable next week.
      pauseLabel: 'Pause it instead',
      resumeTitle: 'Resume deliveries anyway?',
      resumeConfirmLabel: 'Resume anyway',
      resumeIsRisky: true,
    };
  }

  if (condition === 'operator_paused') {
    return {
      condition,
      resumeLabel: 'Resume deliveries',
      pauseLabel: null,
      resumeTitle: 'Resume deliveries?',
      resumeConfirmLabel: 'Resume',
      resumeIsRisky: false,
    };
  }

  return {
    condition,
    resumeLabel: null,
    pauseLabel: 'Pause deliveries',
    resumeTitle: 'Resume deliveries?',
    resumeConfirmLabel: 'Resume',
    resumeIsRisky: false,
  };
}
