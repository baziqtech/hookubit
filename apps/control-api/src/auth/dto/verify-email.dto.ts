import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';

export class VerifyEmailDto {
  @ApiProperty({ description: 'Single-use token from the verification email.' })
  @IsString()
  @Length(16, 512)
  token!: string;
}
