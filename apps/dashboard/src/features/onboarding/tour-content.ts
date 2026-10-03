/**
 * The product tour: "what is this and what can it do for me?"
 *
 * Deliberately NOT the setup checklist. The checklist answers "what do I do
 * next" and is derived from live state; this is orientation, and it is static
 * prose. Conflating them would produce a tour that nags about tasks and a
 * checklist that lectures about concepts, and neither would be good at its job.
 * The last step hands off to the checklist rather than repeating it.
 *
 * Four ideas, because these four are what make the product make sense and
 * everything else is detail:
 *
 *   1. routing       one event → N deliveries → each with its own attempts
 *   2. signing       the consumer can prove it was really you
 *   3. retries       a flaky endpoint recovers without anyone being paged
 *   4. the ledger    which is the answer to "what happened to this event?"
 *
 * Content lives here as data so the step count, order and copy are reviewable
 * in one place, and so the component stays about behaviour.
 */

export interface TourStep {
  id: string;
  /** Short label for the progress dots' accessible name. */
  label: string;
  title: string;
  /** Two or three short paragraphs. Longer than this does not get read. */
  body: string[];
  /** Optional concrete example, rendered in a monospace aside. */
  aside?: { label: string; lines: string[] };
}

export const TOUR_STEPS: TourStep[] = [
  {
    id: 'welcome',
    label: 'What this is',
    title: 'Webhooks that arrive, or tell you why they did not',
    body: [
      'Your system publishes an event once. HookuBit gets it to every consumer that asked for it — retrying failures, signing each request, and keeping a permanent record of every attempt.',
      'The record is the product. When someone asks at 2am whether finance ever received a settlement, the answer is on a page here rather than in a database query.',
    ],
  },
  {
    id: 'routing',
    label: 'Routing',
    title: 'One event becomes many deliveries',
    body: [
      'You publish one event. We create one delivery per matching subscription — up front, before anything is sent — so the table is the record of what should arrive.',
      'Each delivery then retries on its own. A partner being down does not delay the delivery to your ledger, and either one can be replayed alone.',
    ],
    aside: {
      label: 'payment.settled',
      lines: [
        'event  evt_01J…            published once',
        '  ├─ delivery → finance-api      succeeded, 1 attempt',
        '  ├─ delivery → ledger-service   succeeded, 1 attempt',
        '  └─ delivery → partner-bank     retrying, attempt 3 of 8',
      ],
    },
  },
  {
    id: 'signing',
    label: 'Signing',
    title: 'Your consumer can prove it was really you',
    body: [
      'Every request carries a Webhook-Signature header — an HMAC over the timestamp and the exact bytes of the body. Your consumer recomputes it with the endpoint secret and rejects anything that does not match.',
      'Rotating a secret emits both the old and new signature for an overlap window, so consumers roll over without dropping a single delivery.',
    ],
    aside: {
      label: 'what the endpoint receives',
      lines: [
        'Webhook-Id: evt_01J…',
        'Webhook-Attempt: 2',
        'Webhook-Signature: t=1757155200,v1=6f2c…,v1=b03e…',
      ],
    },
  },
  {
    id: 'resilience',
    label: 'Retries',
    title: 'A flaky endpoint recovers on its own',
    body: [
      'Timeouts, 429s and 5xx responses are retried with exponential backoff. Other 4xx responses are treated as permanent and are not retried — a signature your consumer rejects is a bug, not a blip.',
      'An endpoint that fails consistently trips its circuit breaker and is set aside, so one unresponsive partner cannot starve everyone else. Deliveries keep their place in the ledger the whole time.',
    ],
  },
  {
    id: 'handoff',
    label: 'Your turn',
    title: 'Now set yours up',
    body: [
      'The Get started page tracks what this project still needs — an API key, an endpoint, a subscription — and gives you a ready-to-run request to publish your first event.',
      'You can reopen this tour any time from Product tour at the bottom of the sidebar.',
    ],
  },
];
