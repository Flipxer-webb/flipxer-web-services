import { ApiProperty } from "@nestjs/swagger";
import { IsNotEmpty, IsNumber, IsOptional, IsEnum } from "class-validator";

export class Reset2FARateLimitDto {
    @ApiProperty({ example: 123, description: "User ID to reset rate limit for" })
    @IsNotEmpty()
    @IsNumber()
    userId: number;

    @ApiProperty({ 
        example: "login", 
        description: "Context to reset (login, transaction, or omit for all)",
        required: false,
        enum: ["login", "transaction"]
    })
    @IsOptional()
    @IsEnum(["login", "transaction"])
    context?: "login" | "transaction";
}
