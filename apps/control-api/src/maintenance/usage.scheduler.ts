import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UsageAggregatorService } from './usage-aggregator.service';

const DEFAULT_INTERVAL_MINUTES = 15;

/**
 * Runs the usage rollup on a timer.
 *
 * ## Why being late is fine and being early is not
 *
 * The sweep only ever writes COMPLETE hours, so running every fifteen minutes
 * does not mean four partial writes an hour — it means the most recent complete
 * hour lands within fifteen minutes of closing. A pass that is skipped entirely
 * costs nothing either: the next one looks back two days and fills whatever is
 * missing, because the work is idempotent and keyed by hour rather than
 * tracked by a watermark.
 *
 * That is also why the first pass waits a full interval rather than running at
 * boot. A deploy that rolls ten replicas would otherwise have ten of them
 * contending for the advisory lock in the same second, nine losing, and the
 * logs reporting nine skips per deploy.
 */
@Injectable()
export class UsageScheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(UsageScheduler.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly config: ConfigService,
    private readonly aggregator: UsageAggregatorService,
  ) {}

  onApplicationBootstrap(): void {
    const minutes = this.intervalMinutes();
    this.logger.log(
      `Usage aggregation is on: complete hours are rolled into usage_records every ${minutes} minutes.`,
    );
    this.timer = setInterval(() => void this.pass(), minutes * 60_000);
    this.timer.unref?.();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async pass(): Promise<void> {
    // A pass that overruns its interval must not start a second one. The
    // advisory lock already stops two REPLICAS overlapping; this stops one
    // replica overlapping itself, which the lock cannot see.
    if (this.running) return;
    this.running = true;
    try {
      await this.aggregator.sweep();
    } catch (err) {
      this.logger.error(
        `Usage aggregation failed: ${err instanceof Error ? err.message : 'unknown error'}`,
      );
    } finally {
      this.running = false;
    }
  }

  private intervalMinutes(): number {
    const raw = Number(this.config.get<string>('USAGE_AGGREGATION_INTERVAL_MINUTES'));
    return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_INTERVAL_MINUTES;
  }
}
