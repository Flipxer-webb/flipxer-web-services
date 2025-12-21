import { IsNotEmpty, IsOptional, IsString, IsObject } from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export class VerifyWebAuthnRegistrationDto {
    @ApiProperty({ description: "WebAuthn registration response from browser" })
    @IsNotEmpty()
    @IsObject()
    response: any; // RegistrationResponseJSON

    @ApiPropertyOptional({ description: "Custom name for the passkey" })
    @IsOptional()
    @IsString()
    deviceName?: string;
}

export class VerifyWebAuthnAuthenticationDto {
    @ApiProperty({ description: "WebAuthn authentication response from browser" })
    @IsNotEmpty()
    @IsObject()
    response: any; // AuthenticationResponseJSON
}

export class UpdatePasskeyNameDto {
    @ApiProperty({ description: "New name for the passkey" })
    @IsNotEmpty()
    @IsString()
    deviceName: string;
}

export class TrustDeviceDto {
    @ApiProperty({ description: "Verification code (2FA code)" })
    @IsNotEmpty()
    @IsString()
    code: string;
}
