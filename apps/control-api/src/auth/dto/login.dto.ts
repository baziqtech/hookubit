import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, MaxLength } from 'class-validator';
import { PasswordService } from '../password.service';

export class LoginDto {
  @ApiProperty({ example: 'ada@example.com' })
  @IsEmail()
  @MaxLength(320)
  email!: string;

  @ApiProperty({ description: 'Never logged, never returned.' })
  @IsString()
  @MaxLength(PasswordService.MAX_LENGTH)
  password!: string;
}
