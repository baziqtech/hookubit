import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { DeliveryAttempt } from '../../types/api';
import { AttemptHistory, PrunedAttempts } from './DeliveryDetailPage';
import { attemptHistoryState, attemptsWerePruned } from './pruned';

const attempt = (attempt_number: number): DeliveryAttempt => ({
  id: `att_${attempt_number}`,
  delivery_id: 'del_1',
  attempt_number,
  status: 'failure',
  http_status: 503,
  request_headers: null,
  response_headers: null,
  response_body: null,
  response_body_location: null,
  response_size: null,
  error_code: null,
  error_message: 'HTTP 503',
  trace_id: null,
  duration_ms: 120,
  worker_id: 'worker-1',
  started_at: '2026-06-01T00:00:00.000Z',
  completed_at: '2026-06-01T00:00:01.000Z',
  created_at: '2026-06-01T00:00:00.000Z',
});

describe('attemptHistoryState', () => {
  it('reads attempts_pruned_at BEFORE the array, as the DTO says to', () => {
    // The case the field exists for: 5 attempts, empty list, a prune date.
    expect(
      attemptHistoryState({ attempts_pruned_at: '2026-08-01T00:00:00.000Z', attempt_count: 5 }, []),
    ).toEqual({ kind: 'pruned', prunedAt: '2026-08-01T00:00:00.000Z', attemptCount: 5 });
  });

  it('is "none" only when the platform genuinely never tried', () => {
    expect(attemptHistoryState({ attempts_pruned_at: null, attempt_count: 0 }, [])).toEqual({
      kind: 'none',
    });
  });

  it('shows rows that survived rather than hiding them behind the flag', () => {
    expect(
      attemptHistoryState(
        { attempts_pruned_at: '2026-08-01T00:00:00.000Z', attempt_count: 5 },
        [attempt(5)],
      ),
    ).toEqual({ kind: 'present', prunedAt: '2026-08-01T00:00:00.000Z' });
    expect(attemptsWerePruned({ attempts_pruned_at: '2026-08-01T00:00:00.000Z', attempt_count: 5 }, [attempt(5)])).toBe(false);
  });
});

describe('the attempt history on the delivery page', () => {
  const render = (prunedAt: string | null, attemptCount: number, rows: DeliveryAttempt[] = []) =>
    renderToStaticMarkup(
      <AttemptHistory
        embedded={rows}
        truncated={false}
        total={8}
        delivery={{ attempts_pruned_at: prunedAt, attempt_count: attemptCount }}
      />,
    );

  it('renders a pruned delivery as "tried, detail reclaimed" — never as "never tried"', () => {
    const html = render('2026-08-01T00:00:00.000Z', 5);
    expect(html).toContain('data-testid="attempts-pruned"');
    expect(html).toContain('5 attempts were made; the detail was reclaimed by retention');
    expect(html).toContain('1 Aug 2026');
    expect(html).toContain('not a delivery that was never tried');
    expect(html).not.toContain('No attempts yet');
  });

  it('still says "No attempts yet" for a delivery that was never tried', () => {
    const html = render(null, 0);
    expect(html).toContain('No attempts yet');
    expect(html).not.toContain('data-testid="attempts-pruned"');
  });

  it('shows surviving rows and notes the reclamation beside them', () => {
    const html = render('2026-08-01T00:00:00.000Z', 5, [attempt(5)]);
    expect(html).not.toContain('data-testid="attempts-pruned"');
    expect(html).toContain('#5/8');
    expect(html).toContain('reclaimed part of this history');
  });

  it('pluralises', () => {
    expect(renderToStaticMarkup(<PrunedAttempts prunedAt="2026-08-01T00:00:00.000Z" attemptCount={1} />)).toContain(
      '1 attempt was',
    );
  });
});
