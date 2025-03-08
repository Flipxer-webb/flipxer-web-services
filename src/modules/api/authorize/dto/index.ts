import { IsInt, IsString } from "class-validator";

export class PermissionDto {
    @IsInt()
    id: number;

    @IsString()
    name: string;

    @IsString()
    description: string;
}
