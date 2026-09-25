import { ApiProperty } from '@nestjs/swagger';

/**
 * The window the numbers in the same response cover, echoed back.
 *
 * Echoed rather than assumed: the request said "24 hours ago", the response says
 * which 24 hours, and a screenshot taken at 03:00 is still interpretable at
 * 09:00. It is also the check that the ceiling was enforced by refusal - if
 * `hours` ever came back smaller than what was asked for, something clamped.
 */
export class AnalyticsWindowDto {
  @ApiProperty({ description: 'Length of the window in hours, as requested.' })
  hours!: number;

  @ApiProperty({ format: 'date-time', description: 'Inclusive lower bound.' })
  from!: string;

  @ApiProperty({ format: 'date-time', description: 'EXCLUSIVE upper bound; "now" at query time.' })
  to!: string;

  @ApiProperty({
    format: 'date-time',
    description: 'Inclusive lower bound of the comparison window, which is the same length.',
  })
  previous_from!: string;

  @ApiProperty({ format: 'date-time', description: 'Exclusive upper bound; equals `from`.' })
  previous_to!: string;
}

/**
 * One row per `DeliveryStatus`, always all nine, always present.
 *
 * A status with no deliveries is `0` and not an absent key. An operator reading
 * "exhausted" off this object needs to be able to tell "none" from "this build
 * does not report it", and a client that has to distinguish `undefined` from `0`
 * will eventually get it wrong in the direction of not showing the failure.
 */
export class DeliveryStatusCountsDto {
  @ApiProperty() pending!: number;
  @ApiProperty() scheduled!: number;
  @ApiProperty() queued!: number;
  @ApiProperty() processing!: number;
  @ApiProperty() succeeded!: number;
  @ApiProperty() failed!: number;
  @ApiProperty() retrying!: number;
  @ApiProperty() exhausted!: number;
  @ApiProperty() cancelled!: number;
}

/**
 * The four numbers an operator actually reads, derived from the nine above.
 *
 * `success_rate` is NULL, never 0, when nothing has settled yet. Zero is a real
 * and alarming value - "everything we tried failed" - and using it for "we have
 * not tried anything" is the difference between a quiet night and a pager.
 */
export class DeliveryOutcomeSummaryDto {
  @ApiProperty({ description: 'Every delivery created in the window, whatever its status.' })
  total!: number;

  @ApiProperty() succeeded!: number;

  @ApiProperty({
    description:
      '`failed` + `exhausted`: attempts that ended badly. `exhausted` is the subset that will ' +
      'never be retried again without a replay.',
  })
  failing!: number;

  @ApiProperty({ description: 'Of `failing`, the ones that gave up: `exhausted`.' })
  exhausted!: number;

  @ApiProperty({
    description:
      'Still moving: `pending`, `scheduled`, `queued`, `processing`, `retrying`. These are not ' +
      'failures yet and are excluded from `success_rate` for that reason.',
  })
  in_flight!: number;

  @ApiProperty({ description: '`cancelled`. Neither a success nor a failure.' })
  cancelled!: number;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      '`succeeded / (succeeded + failed + exhausted)`, in 0..1, over deliveries that have ' +
      'SETTLED. NULL when nothing settled in the window - not 0, which means the opposite.',
  })
  success_rate!: number | null;

  @ApiProperty({ type: DeliveryStatusCountsDto })
  by_status!: DeliveryStatusCountsDto;
}

/** `GET /analytics/deliveries`. */
export class DeliveryOutcomesDto {
  @ApiProperty({ type: AnalyticsWindowDto }) window!: AnalyticsWindowDto;

  @ApiProperty({ type: DeliveryOutcomeSummaryDto }) current!: DeliveryOutcomeSummaryDto;

  @ApiProperty({
    type: DeliveryOutcomeSummaryDto,
    description:
      'The same numbers for the immediately preceding window of equal length. This is what makes ' +
      '"is it getting worse?" answerable from one request.',
  })
  previous!: DeliveryOutcomeSummaryDto;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      '`current.success_rate - previous.success_rate`. Negative means worse. NULL when either ' +
      'window had nothing settled, because a change from "unknown" is not a change.',
  })
  success_rate_delta!: number | null;

  @ApiProperty({ description: '`current.total - previous.total`. Negative means quieter.' })
  total_delta!: number;
}

/** One endpoint in the failure ranking. */
export class FailingEndpointDto {
  @ApiProperty() endpoint_id!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'NULL when the endpoint row is gone. The delivery ledger is ON DELETE RESTRICT and ' +
      'endpoints are soft-deleted, so this should not happen - but the ranking is still the ' +
      'truth about what failed, and dropping the row to hide a missing name would hide the ' +
      'failure with it.',
  })
  name!: string | null;

  @ApiProperty({ type: String, nullable: true }) url!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The endpoint status NOW - `active`, `paused`, `disabled`, `deleted`.',
  })
  status!: string | null;

  @ApiProperty({
    type: Boolean,
    nullable: true,
    description: 'Operator intent NOW. `false` with a `failing` count is an endpoint someone ' +
      'already turned off, or one the circuit breaker did.',
  })
  enabled!: boolean | null;

  @ApiProperty({ description: '`failed` + `exhausted` in the window. The ranking key.' })
  failing!: number;

  @ApiProperty() failed!: number;
  @ApiProperty() exhausted!: number;
  @ApiProperty({ description: 'In the window, and not yet a failure.' }) retrying!: number;

  @ApiProperty({ description: 'Every delivery to this endpoint in the window.' })
  total!: number;

  @ApiProperty({
    description:
      '`failing / total`, in 0..1. Read it beside `failing`: one endpoint at 100% of two ' +
      'deliveries is not the outage; the one at 40% of twelve thousand is.',
  })
  failure_rate!: number;
}

/** `GET /analytics/endpoints`. */
export class FailingEndpointsDto {
  @ApiProperty({ type: AnalyticsWindowDto }) window!: AnalyticsWindowDto;

  @ApiProperty({ type: [FailingEndpointDto], description: 'Worst first, by `failing`.' })
  data!: FailingEndpointDto[];

  @ApiProperty({
    description:
      'True when more endpoints had failures than `limit`. The ranking is still the worst ones; ' +
      'this says the list is not the whole set.',
  })
  has_more!: boolean;
}

/** `GET /analytics/latency`. */
export class AttemptLatencyDto {
  @ApiProperty({ type: AnalyticsWindowDto }) window!: AnalyticsWindowDto;

  @ApiProperty({ type: Number, nullable: true, description: 'Nearest-rank p50 of `duration_ms`.' })
  p50_ms!: number | null;

  @ApiProperty({ type: Number, nullable: true, description: 'Nearest-rank p95 of `duration_ms`.' })
  p95_ms!: number | null;

  @ApiProperty({ type: Number, nullable: true, description: 'Nearest-rank p99 of `duration_ms`.' })
  p99_ms!: number | null;

  @ApiProperty({ type: Number, nullable: true }) min_ms!: number | null;
  @ApiProperty({ type: Number, nullable: true }) max_ms!: number | null;

  @ApiProperty({ description: 'How many attempts these percentiles were computed from.' })
  sample_size!: number;

  @ApiProperty({
    description:
      'TRUE when the sample IS every measured attempt in the window, so the percentiles are ' +
      'exact. FALSE when the window held more traffic than the sample cap, in which case the ' +
      'numbers describe the MOST RECENT traffic in the window, not the whole of it. This flag ' +
      'is the honest part of the response: an exact percentile over the whole window is not ' +
      'offered today, and the sample cap is what keeps this query bounded for every project.',
  })
  exact!: boolean;

  @ApiProperty({
    description: 'How many deliveries the sampled attempts were drawn from.',
  })
  sampled_deliveries!: number;
}

/** One event type in the volume breakdown. */
export class EventTypeCountDto {
  @ApiProperty() event_type!: string;
  @ApiProperty() count!: number;
}

/** `GET /analytics/events`. */
export class EventVolumeDto {
  @ApiProperty({ type: AnalyticsWindowDto }) window!: AnalyticsWindowDto;

  @ApiProperty({ description: 'Events published in the window.' })
  total!: number;

  @ApiProperty({ description: 'The same count for the preceding window of equal length.' })
  previous_total!: number;

  @ApiProperty({ description: '`total - previous_total`.' })
  total_delta!: number;

  @ApiProperty({ type: [EventTypeCountDto], description: 'Busiest first.' })
  by_type!: EventTypeCountDto[];

  @ApiProperty({ description: 'True when more event types occurred than `limit`.' })
  has_more!: boolean;
}

/**
 * One bar.
 *
 * The three drawn counts are DISJOINT so they stack without double-counting a
 * delivery: one that succeeded on its third attempt is in
 * `delivered_after_retry` and nowhere else.
 */
export class SeriesBucketDto {
  @ApiProperty({ description: 'Start of the bucket, inclusive. Aligned to a UTC boundary.' })
  start!: string;

  @ApiProperty({ description: 'End of the bucket, exclusive. Equal to the next bucket`s start.' })
  end!: string;

  @ApiProperty({ description: 'Succeeded on the first attempt.' })
  delivered_first_try!: number;

  @ApiProperty({ description: 'Succeeded, but only after at least one attempt had failed.' })
  delivered_after_retry!: number;

  @ApiProperty({ description: '`failed` plus `exhausted`: no further attempt is coming.' })
  failed!: number;

  @ApiProperty({
    description:
      'Created in this bucket and still moving. Not drawn, but the reason the newest bar is ' +
      'allowed to look short: without it, work that has not finished yet reads as a collapse ' +
      'in traffic.',
  })
  in_flight!: number;

  @ApiProperty({ description: 'Stopped before it could be sent - usually a paused endpoint.' })
  cancelled!: number;
}

/** `GET /analytics/deliveries/series`. */
export class DeliverySeriesDto {
  @ApiProperty({ type: AnalyticsWindowDto }) window!: AnalyticsWindowDto;

  @ApiProperty({ description: 'The bucket width actually used, e.g. `1h`.' })
  bucket!: string;

  @ApiProperty({ description: 'That width in milliseconds, so a client need not parse the name.' })
  bucket_ms!: number;

  @ApiProperty({
    description:
      'TRUE when the first bucket begins BEFORE the requested window did. Buckets are aligned ' +
      'to the wall clock, so a 24-hour window opened at 14:37 starts inside the 14:00 bucket. ' +
      'Say so on the chart, or the oldest bar looks like a dip that moves every time the page ' +
      'is opened.',
  })
  leading_partial!: boolean;

  @ApiProperty({ type: [SeriesBucketDto], description: 'Oldest first, contiguous, no gaps.' })
  buckets!: SeriesBucketDto[];
}
