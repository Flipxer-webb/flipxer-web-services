import { IsEmail, IsEnum, IsNotEmpty, IsString } from "class-validator";

enum Gender {
    MALE = "MALE",
    FEMALE = "FEMALE",
}

export class SignUpDto {
    @IsNotEmpty()
    @IsString()
    firstName: string;

    @IsNotEmpty()
    @IsString()
    lastName: string;

    @IsEmail({}, { message: "Invalid email address" })
    email: string;
}

export class SignInDto {
    @IsEmail({}, { message: "Invalid email address" })
    email: string;

    @IsString({ message: "Invalid password format" })
    password: string;
}

export enum UserSignInAppType {
    CUSTOMER = "CUSTOMER",
    BUSINESS = "BUSINESS",
}
export class UserSigInDto extends SignInDto {
    @IsEnum(UserSignInAppType)
    appType: UserSignInAppType;
}
