import { ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { CreateEndpointDto } from './create-endpoint.dto';

/**
 * Every field optional, same constraints. `status` is deliberately NOT here:
 * enabling, disabling and deleting are separate routes because each one has a
 * precondition the others do not (an endpoint cannot be enabled without a live
 * signing secret; a delete must never become a hard delete). A writable `status`
 * would let a PATCH walk straight past all three.
 */
export class UpdateEndpointDto extends PartialType(CreateEndpointDto) {}

export class DisableEndpointDto {
  @ApiPropertyOptional({
    maxLength: 200,
    description: 'Recorded in the audit log so the delivery gap can be explained later.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
}
