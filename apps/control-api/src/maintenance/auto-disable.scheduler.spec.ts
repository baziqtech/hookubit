import { ConfigService } from '@nestjs/config';
import { AutoDisableScheduler } from './auto-disable.scheduler';
import {
  AutoDisableOptions,
  AutoDisableReport,
  EndpointAutoDisableService,
} from './endpoint-auto-disable.service';

function config(values: Record<string, unknown> = {}): ConfigService {
  return { get: (name: string): unknown => values[name] } as unknown as ConfigService;
}

class RecordingSweeper {
  calls: AutoDisableOptions[] = [];
  result: AutoDisableReport = { skipped: false, considered: 0, disabled: 0, truncated: false };
  error: Error | null = null;
  /** Resolves the in-flight sweep, so overlap can be driven deterministically. */
  release: (() => void) | null = null;

  async sweep(options: AutoDisableOptions): Promise<AutoDisableReport> {
    this.calls.push(options);
    if (this.error) throw this.error;
    if (this.release === null) return this.result;
    await new Promise<void>((resolve) => {
      this.release = resolve;
    });
    return this.result;
  }

  asService(): EndpointAutoDisableService {
    return this as unknown as EndpointAutoDisableService;
  }
}

function scheduler(
  sweeper: RecordingSweeper,
  values: Record<string, unknown> = {},
): AutoDisableScheduler {
  return new AutoDisableScheduler(config(values), sweeper.asService());
}

describe('AutoDisableScheduler', () => {
  it('uses the documented defaults when nothing is configured', async () => {
    const sweeper = new RecordingSweeper();
    await scheduler(sweeper).tick();

    expect(sweeper.calls).toEqual([{ enabled: true, afterHours: 72, maxPerRun: 200 }]);
  });

  it('passes the configured window and ceiling through', async () => {
    const sweeper = new RecordingSweeper();
    await scheduler(sweeper, {
      ENDPOINT_AUTO_DISABLE_AFTER_HOURS: 168,
      ENDPOINT_AUTO_DISABLE_MAX_PER_RUN: 5,
    }).tick();

    expect(sweeper.calls).toEqual([{ enabled: true, afterHours: 168, maxPerRun: 5 }]);
  });

  /**
   * A pass that is still running must not have a second one queued behind it.
   * That is how a slow database turns a quarter-hourly job into an unbounded
   * pile of overlapping transactions, all contending for the same advisory lock.
   */
  it('skips a tick while the previous pass is still running', async () => {
    const sweeper = new RecordingSweeper();
    // Any non-null value parks the sweep until it is replaced by the resolver.
    sweeper.release = (): void => undefined;
    const subject = scheduler(sweeper);

    const first = subject.tick();
    await subject.tick();
    expect(sweeper.calls).toHaveLength(1);

    sweeper.release?.();
    await first;

    // And the guard clears afterwards, so the job is not wedged for ever.
    sweeper.release = null;
    await subject.tick();
    expect(sweeper.calls).toHaveLength(2);
  });

  /**
   * Housekeeping must never be the reason the control API reports a problem to
   * a caller. A failed pass is a table that grows for another fifteen minutes.
   */
  it('swallows a failed pass and stays runnable', async () => {
    const sweeper = new RecordingSweeper();
    sweeper.error = new Error('database is having a moment');
    const subject = scheduler(sweeper);

    await expect(subject.tick()).resolves.toBeUndefined();

    sweeper.error = null;
    await subject.tick();
    expect(sweeper.calls).toHaveLength(2);
  });

  /**
   * The timer must not hold the process open, or SIGTERM waits for it and a
   * Jest run hangs on it.
   */
  it('starts an unref`d timer, and only when enabled', () => {
    const sweeper = new RecordingSweeper();

    const off = scheduler(sweeper, { ENDPOINT_AUTO_DISABLE_ENABLED: false });
    off.onApplicationBootstrap();
    expect(off['timer']).toBeNull();

    const on = scheduler(sweeper, { ENDPOINT_AUTO_DISABLE_INTERVAL_MINUTES: 1 });
    on.onApplicationBootstrap();
    const timer = on['timer'] as NodeJS.Timeout & { hasRef?: () => boolean };
    expect(timer).not.toBeNull();
    if (typeof timer.hasRef === 'function') expect(timer.hasRef()).toBe(false);
    // Nothing has run yet: the first pass waits a whole interval, so a replica
    // in a crash loop cannot disable endpoints once per restart.
    expect(sweeper.calls).toHaveLength(0);

    on.onApplicationShutdown();
    expect(on['timer']).toBeNull();
  });
});
