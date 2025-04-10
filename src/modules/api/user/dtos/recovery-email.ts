import { IsEmail, IsString, Length } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class SendRecoveryPinDto {
  @ApiProperty({
    description: 'The registered email address of the user',
    example: 'user@example.com',
  })
  @IsEmail()
  email: string;
}

export class VerifyRecoveryPinDto {
  @ApiProperty({
    description: 'The registered email address of the user',
    example: 'user@example.com',
  })
  @IsEmail()
  email: string;

  @ApiProperty({
    description: 'The recovery email address to be updated for the user',
    example: 'recovery@example.com',
  })
  @IsEmail()
  recoveryEmail: string;

  @ApiProperty({
    description: 'The 6-digit PIN sent to the user for verification',
    example: '123456',
    minLength: 6,
    maxLength: 6,
  })
  @IsString()
  @Length(6, 6)
  pin: string;
}
