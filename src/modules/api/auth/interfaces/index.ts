import { User, UserType } from "@prisma/client";
import { Request } from "express";
import { UserSigInDto } from "../dtos";
import { Optional } from "@/utils";

export interface DataStoredInToken {
    sub: string;
}

export interface RequestWithUser extends Request {
    user: User;
}

export enum LoginPlatform {
    ADMIN = "ADMIN",
    USER = "USER",
}

export type SignInOptions = Optional<UserSigInDto, "userType">;
