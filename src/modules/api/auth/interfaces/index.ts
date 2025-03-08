import { User } from "@prisma/client";
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
    ADMIN = "ADMIN",       // Admin sign-in platform
    CUSTOMER = "CUSTOMER", // Customer sign-in platform
    BUSINESS = "BUSINESS"  // Business sign-in platform
}

export type SignInOptions = Optional<UserSigInDto, "userType">;
