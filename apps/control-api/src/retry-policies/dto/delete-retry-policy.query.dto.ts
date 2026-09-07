import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Deleting the project default requires naming its successor, in the same
 * request and therefore in the same transaction.
 *
 * The alternative — "set another policy as default first, then delete" — leaves
 * a window in which the project has policies and no default, and the window is
 * exactly as long as the caller takes to issue the second request (or forever,
 * if they crash between the two). Making the replacement part of the delete
 * makes the invariant hold at every instant a reader could observe.
 */
export class DeleteRetryPolicyQueryDto {
  @ApiPropertyOptional({
    maxLength: 64,
    description:
      'The policy that becomes the project default. REQUIRED when deleting the current ' +
      'default while other policies remain; rejected otherwise, because it would silently ' +
      'change the default as a side effect of a delete that did not need to.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  replacement_id?: string;
}
