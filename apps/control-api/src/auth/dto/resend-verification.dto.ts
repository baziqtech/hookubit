import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, MaxLength } from 'class-validator';

export class ResendVerificationDto {
  @ApiProperty({ example: 'ada@example.com' })
  @IsEmail()
  @MaxLength(320)
  email!: string;
}
