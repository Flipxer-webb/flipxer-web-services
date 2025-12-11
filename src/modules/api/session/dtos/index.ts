import { ApiProperty } from "@nestjs/swagger";
import { IsString, IsNotEmpty, IsOptional } from "class-validator";

export class RevokeSessionDto {
    @ApiProperty({ description: "Session ID to revoke" })
    @IsString()
    @IsNotEmpty()
    sessionId: string;
}

export class CreateSessionDto {
    @ApiProperty({ description: "Device name" })
    @IsString()
    @IsOptional()
    deviceName?: string;

    @ApiProperty({ description: "Device type (mobile, desktop, tablet)" })
    @IsString()
    @IsOptional()
    deviceType?: string;

    @ApiProperty({ description: "Browser name" })
    @IsString()
    @IsOptional()
    browser?: string;

    @ApiProperty({ description: "Operating system" })
    @IsString()
    @IsOptional()
    os?: string;
}

export class ExtendSessionDto {
    @ApiProperty({ description: "Session ID to extend" })
    @IsString()
    @IsNotEmpty()
    sessionId: string;
}
