/**
 * DTOs for Biometric Authentication endpoints
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional, IsEmail, IsObject, MaxLength, MinLength } from 'class-validator';

/**
 * DTO for initiating biometric registration
 */
export class BiometricRegisterOptionsDto {
    @ApiProperty({ description: 'Current user password for verification', example: 'Password123!' })
    @IsString()
    @IsNotEmpty()
    password: string;
}

/**
 * DTO for completing biometric registration
 */
export class BiometricRegisterDto {
    @ApiProperty({ description: 'WebAuthn credential response from browser', type: 'object' })
    @IsObject()
    @IsNotEmpty()
    response: any; // RegistrationResponseJSON from @simplewebauthn/types

    @ApiProperty({ description: 'User-friendly name for the device', example: 'MacBook Pro Touch ID' })
    @IsString()
    @IsNotEmpty()
    @MinLength(1)
    @MaxLength(100)
    deviceName: string;
}

/**
 * DTO for initiating biometric login
 */
export class BiometricLoginOptionsDto {
    @ApiPropertyOptional({ description: 'User email (optional for conditional UI)', example: 'user@example.com' })
    @IsEmail()
    @IsOptional()
    email?: string;
}

/**
 * DTO for completing biometric login
 */
export class BiometricLoginDto {
    @ApiProperty({ description: 'WebAuthn assertion response from browser', type: 'object' })
    @IsObject()
    @IsNotEmpty()
    response: any; // AuthenticationResponseJSON from @simplewebauthn/types

    @ApiPropertyOptional({ description: 'User email (if provided during options request)' })
    @IsEmail()
    @IsOptional()
    email?: string;

    @ApiPropertyOptional({ description: 'Device type for session tracking', example: 'desktop' })
    @IsString()
    @IsOptional()
    deviceType?: string;

    @ApiPropertyOptional({ description: 'Browser info for session tracking', example: 'Chrome' })
    @IsString()
    @IsOptional()
    browser?: string;

    @ApiPropertyOptional({ description: 'OS info for session tracking', example: 'macOS' })
    @IsString()
    @IsOptional()
    os?: string;
}

/**
 * DTO for revoking a biometric credential
 */
export class BiometricRevokeDto {
    @ApiProperty({ description: 'Credential ID to revoke' })
    @IsString()
    @IsNotEmpty()
    credentialId: string;
}

/**
 * DTO for transaction verification via biometrics
 */
export class BiometricVerifyTransactionDto {
    @ApiProperty({ description: 'WebAuthn assertion response from browser', type: 'object' })
    @IsObject()
    @IsNotEmpty()
    response: any; // AuthenticationResponseJSON from @simplewebauthn/types
}
