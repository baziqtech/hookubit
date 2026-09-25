import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { NotificationDestination } from '@prisma/client';
import { IsArray, IsIn, IsOptional, IsString, Length } from 'class-validator';
import { NOTIFICATION_EVENT_NAMES } from '../notification-rules';

export class DestinationDto {
  @ApiProperty() id!: string;
  @ApiProperty() project_id!: string;

  @ApiProperty({ enum: ['email', 'slack'] })
  kind!: string;

  @ApiProperty({ description: 'The address. Lower-cased on the way in.' })
  target!: string;

  @ApiProperty() label!: string;

  @ApiProperty({
    enum: ['pending', 'confirmed', 'failing', 'disabled'],
    description:
      '`pending` receives NOTHING. A destination is silent until somebody who can read the ' +
      'address clicks the confirmation link — which is also the only check available that the ' +
      'address is real, so a typo sits here visibly rather than swallowing every alert.',
  })
  status!: string;

  @ApiProperty({
    type: [String],
    description:
      'Which triggers this destination has asked for. An EMPTY list receives nothing and is a ' +
      'legal, deliberate state: it is how a destination is muted without deleting it and losing ' +
      'its confirmation.',
  })
  events!: string[];

  @ApiProperty({ type: String, nullable: true }) confirmed_at!: string | null;
  @ApiProperty({ type: String, nullable: true }) last_sent_at!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Why the last attempt to reach this destination failed, if one did.',
  })
  last_error!: string | null;

  @ApiProperty() created_at!: string;
}

export class DestinationListDto {
  @ApiProperty({ type: [DestinationDto] }) data!: DestinationDto[];
  @ApiProperty() has_more!: boolean;
  @ApiProperty({ type: Number, nullable: true }) next_offset!: number | null;
}

export class CreateDestinationDto {
  @ApiProperty({
    enum: ['email'],
    description:
      "Only 'email' today. A Slack destination needs an app installed in your workspace; " +
      'accepting the value before that exists would create a row nothing can deliver to.',
  })
  @IsIn(['email'])
  kind!: string;

  @ApiProperty({ example: 'payments-oncall@example.com' })
  @IsString()
  @Length(3, 320)
  target!: string;

  @ApiPropertyOptional({ description: 'What to call it on screen. Defaults to the address.' })
  @IsOptional()
  @IsString()
  @Length(1, 200)
  label?: string;

  @ApiPropertyOptional({
    type: [String],
    enum: NOTIFICATION_EVENT_NAMES,
    description: 'Omitted, the destination is subscribed to everything.',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  events?: string[];
}

export class UpdateDestinationDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(1, 200)
  label?: string;

  @ApiPropertyOptional({
    type: [String],
    enum: NOTIFICATION_EVENT_NAMES,
    description: 'REPLACES the list. An empty array mutes the destination without deleting it.',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  events?: string[];
}

export class ConfirmDestinationDto {
  @ApiProperty({ description: 'The token from the confirmation link.' })
  @IsString()
  @Length(10, 200)
  token!: string;
}

export class ConfirmedDestinationDto {
  @ApiProperty() project_name!: string;
  @ApiProperty({ description: 'The address that was confirmed, so the page can name it.' })
  target!: string;
}

export function toDestinationDto(row: NotificationDestination): DestinationDto {
  return {
    id: row.id,
    project_id: row.projectId,
    kind: row.kind,
    target: row.target,
    label: row.label,
    status: row.status,
    events: row.events,
    confirmed_at: row.confirmedAt ? row.confirmedAt.toISOString() : null,
    last_sent_at: row.lastSentAt ? row.lastSentAt.toISOString() : null,
    last_error: row.lastError ?? null,
    created_at: row.createdAt.toISOString(),
  };
}
