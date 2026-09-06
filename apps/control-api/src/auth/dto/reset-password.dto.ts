import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';
import { PasswordService } from '../password.service';

export class ResetPasswordDto {
  @ApiProperty({ description: 'Single-use token from the password reset email.' })
  @IsString()
  @Length(16, 512)
  token!: string;

  @ApiProperty({
    minLength: PasswordService.MIN_LENGTH,
    maxLength: PasswordService.MAX_LENGTH,
  })
  @IsString()
  @Length(PasswordService.MIN_LENGTH, PasswordService.MAX_LENGTH)
  password!: string;
}
