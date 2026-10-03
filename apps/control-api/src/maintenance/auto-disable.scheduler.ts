import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DEFAULT_AUTO_DISABLE_AFTER_HOURS,
  DEFAULT_AUTO_DISABLE_INTERVAL_MINUTES,
  DEFAULT_AUTO_DISABLE_MAX_PER_RUN,
} from './auto-disable-policy';
import { withSpan } from '../tracing/with-span';
import {
  AutoDisableOptions,
  EndpointAutoDisableService,
} from './endpoint-auto-disable.service';

/**
 * The timer that drives the endpoint auto-disable sweep.
 *
 * ## Why a bare interval rather than @nestjs/schedule
 *
 * There is one job. `@nestjs/schedule` brings a dependency, a discovery pass
 * over every provider and a cron parser to express "every fifteen minutes",
 * which `setInterval` already expresses. If a second and a third periodic job
 * appear, that is the moment to adopt it - not before.
 *
 * ## Why a background writer in an HTTP service is safe here
 *
 * Three properties, and all three are load-bearing:
 *
 *  - **Single runner.** Every replica runs this timer; the sweep takes a
 *    transaction-scoped advisory lock, so exactly one pass runs at a time
 *    across the fleet and the losers return immediately. See the sweep's
 *    docblock.
 *  - **It cannot hold the process open.** The interval is `unref`'d, so it is
 *    not a reason `SIGTERM` waits and not a reason a Jest run hangs.
 *  - **It cannot overlap itself.** A pass that is still running skips the next
 *    tick rather than queueing a second one behind it, which is how a slow
 *    database turns a fifteen-minute job into an unbounded pile of them.
 *
 * ## Failure
 *
 * A failed pass is logged and dropped. Retention of dead endpoints is a
 * housekeeping property; a sweep that cannot run is a table that grows for
 * another quarter of an hour, and it must never be the reason the control API
 * reports itself unhealthy or refuses a request.
 */
@Injectable()
export class AutoDisableScheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(AutoDisableScheduler.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly config: ConfigService,
    private readonly sweeper: EndpointAutoDisableService,
  ) {}

  onApplicationBootstrap(): void {
    const options = this.options();
    if (!options.enabled) {
      this.logger.warn(
        'Endpoint auto-disable is off (ENDPOINT_AUTO_DISABLE_ENABLED=false). An endpoint whose ' +
          'circuit breaker never closes will keep accruing a delivery row for every matching ' +
          'event, each of which is claimed, refused, deferred and finally expired.',
      );
      return;
    }
    const everyMs = this.intervalMinutes() * 60_000;
    this.logger.log(
      `Endpoint auto-disable is on: an endpoint whose circuit breaker has been open for ` +
        `${options.afterHours}h is disabled, at most ${options.maxPerRun} per pass, every ` +
        `${this.intervalMinutes()} minutes.`,
    );
    // The FIRST pass waits a whole interval rather than running at boot. A
    // replica in a crash loop would otherwise run a pass per restart, and the
    // one job that switches customers' endpoints off should not be triggered by
    // an unhealthy process.
    this.timer = setInterval(() => void this.tick(), everyMs);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Exported for tests; the interval is the only production caller. */
  async tick(): Promise<void> {
    if (this.running) {
      this.logger.warn('The previous endpoint auto-disable pass is still running; skipping this tick.');
      return;
    }
    this.running = true;
    try {
      // A root span for the pass. The sweep has no request behind it, so
      // without one its database spans would be a scatter of parentless
      // single-span traces; with one, a pass is a single trace and "why was the
      // auto-disable sweep slow last night?" is answerable. Inert - literally
      // just the callback - when tracing is off.
      const report = await withSpan('endpoint auto-disable sweep', {}, () =>
        this.sweeper.sweep(this.options()),
      );
      if (report.skipped) {
        this.logger.debug('Another replica holds the auto-disable lock; nothing to do.');
        return;
      }
      if (report.disabled > 0) {
        this.logger.log(
          `Auto-disabled ${report.disabled} of ${report.considered} endpoint(s) whose circuit breaker had been open past the window.`,
        );
      }
      if (report.truncated) {
        this.logger.warn(
          'The endpoint auto-disable pass hit its per-run ceiling; more endpoints are waiting. ' +
            'That is a lot of endpoints failing at once - check for a shared cause before raising ' +
            'ENDPOINT_AUTO_DISABLE_MAX_PER_RUN.',
        );
      }
    } catch (err) {
      this.logger.error(`Endpoint auto-disable pass failed: ${String(err)}`);
    } finally {
      this.running = false;
    }
  }

  private options(): AutoDisableOptions {
    return {
      enabled: this.config.get<boolean>('ENDPOINT_AUTO_DISABLE_ENABLED') ?? true,
      afterHours:
        this.config.get<number>('ENDPOINT_AUTO_DISABLE_AFTER_HOURS') ??
        DEFAULT_AUTO_DISABLE_AFTER_HOURS,
      maxPerRun:
        this.config.get<number>('ENDPOINT_AUTO_DISABLE_MAX_PER_RUN') ??
        DEFAULT_AUTO_DISABLE_MAX_PER_RUN,
    };
  }

  private intervalMinutes(): number {
    return (
      this.config.get<number>('ENDPOINT_AUTO_DISABLE_INTERVAL_MINUTES') ??
      DEFAULT_AUTO_DISABLE_INTERVAL_MINUTES
    );
  }
}
