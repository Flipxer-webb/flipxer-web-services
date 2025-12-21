import { ApiProperty } from "@nestjs/swagger";
import { IsNotEmpty, IsString, IsOptional, IsObject } from "class-validator";

export class BiometricRegisterOptionsDto {
    @ApiProperty({ description: "Device name for identification", required: false })
    @IsOptional()
    @IsString()
    deviceName?: string;
}

export class BiometricVerifyRegistrationDto {
    @ApiProperty({ description: "Challenge key from registration options" })
    @IsNotEmpty()
    @IsString()
    challengeKey: string;

    @ApiProperty({ description: "WebAuthn registration response from browser" })
    @IsNotEmpty()
    @IsObject()
    response: Record<string, unknown>;

    @ApiProperty({ description: "Device name for identification", required: false })
    @IsOptional()
    @IsString()
    deviceName?: string;
}

export class BiometricAuthOptionsDto {
    // No body needed - user is authenticated via JWT
}

export class BiometricVerifyAuthDto {
    @ApiProperty({ description: "Challenge key from authentication options" })
    @IsNotEmpty()
    @IsString()
    challengeKey: string;

    @ApiProperty({ description: "WebAuthn authentication response from browser" })
    @IsNotEmpty()
    @IsObject()
    response: Record<string, unknown>;
}

export class BiometricRenameDto {
    @ApiProperty({ description: "New name for the credential" })
    @IsNotEmpty()
    @IsString()
    name: string;
}

export class BiometricTransactionVerifyDto {
    @ApiProperty({ description: "Challenge key from authentication options" })
    @IsNotEmpty()
    @IsString()
    challengeKey: string;

    @ApiProperty({ description: "WebAuthn authentication response from browser" })
    @IsNotEmpty()
    @IsObject()
    response: Record<string, unknown>;

    @ApiProperty({ description: "Transaction ID for audit purposes", required: false })
    @IsOptional()
    @IsString()
    transactionId?: string;
}
