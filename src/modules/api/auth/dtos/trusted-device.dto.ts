import { ApiProperty } from "@nestjs/swagger";
import { IsNotEmpty, IsString, Length } from "class-validator";

export class TrustDeviceDto {
    @ApiProperty({
        description: "2FA verification code to confirm trust",
        example: "123456",
    })
    @IsString()
    @IsNotEmpty()
    @Length(6, 6)
    code: string;
}
