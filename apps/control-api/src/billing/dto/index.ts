import { ApiProperty } from '@nestjs/swagger';

/** One metered line, for the period this response covers. */
export class UsageLineDto {
  @ApiProperty({ description: '`events_ingested`, `deliveries` or `replays`.' })
  metric!: string;

  @ApiProperty({ description: 'Counted from the hourly rollups, not from the source tables.' })
  used!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'What the plan includes, or null when the organization has no plan — which is not the ' +
      'same as an allowance of zero.',
  })
  included!: string | null;
}

export class PlanDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() slug!: string;
  @ApiProperty({ description: 'How long payload history is kept, in days.' })
  retention_days!: number;

  @ApiProperty({ type: Number, nullable: true }) max_projects!: number | null;
  @ApiProperty({ type: Number, nullable: true }) max_endpoints!: number | null;
  @ApiProperty({ type: Number, nullable: true }) max_members!: number | null;
  @ApiProperty({ type: String, nullable: true }) included_events_per_month!: string | null;
}

export class BillingDto {
  @ApiProperty({
    type: () => PlanDto,
    nullable: true,
    description:
      'NULL when this organization has no plan assigned. That is the state every organization ' +
      'is in today — no plans are defined — and it is reported honestly rather than as a free ' +
      'tier nobody agreed to.',
  })
  plan!: PlanDto | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: '`trialing`, `active`, `past_due` or `canceled`. Null with no subscription.',
  })
  status!: string | null;

  @ApiProperty({ description: 'Start of the period these numbers cover, inclusive.' })
  period_start!: string;

  @ApiProperty({
    description:
      'End of the period, EXCLUSIVE, and it is the start of the current hour rather than now: ' +
      'usage is rolled up by complete hour, so the hour in progress is not counted yet.',
  })
  period_end!: string;

  @ApiProperty({ type: [UsageLineDto] })
  usage!: UsageLineDto[];

  @ApiProperty({
    description:
      'TRUE when there is a payment provider behind this. It is false everywhere today: there ' +
      'are no invoices, no payment method and no charges. The page says so rather than drawing ' +
      'an empty invoice table.',
  })
  billable!: boolean;
}
