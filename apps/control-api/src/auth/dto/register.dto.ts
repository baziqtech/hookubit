import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsOptional, IsString, Length, MaxLength } from 'class-validator';
import { PasswordService } from '../password.service';

export class RegisterDto {
  @ApiProperty({ example: 'ada@example.com', maxLength: 320 })
  @IsEmail()
  @MaxLength(320)
  email!: string;

  @ApiProperty({
    minLength: PasswordService.MIN_LENGTH,
    maxLength: PasswordService.MAX_LENGTH,
    description: 'Never logged, never returned.',
  })
  @IsString()
  @Length(PasswordService.MIN_LENGTH, PasswordService.MAX_LENGTH)
  password!: string;

  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @ApiPropertyOptional({
    maxLength: 200,
    description: 'Organization created for this user. Defaults to the local part of the email.',
  })
  @IsOptional()
  @IsString()
  @Length(2, 200)
  organization_name?: string;
}
