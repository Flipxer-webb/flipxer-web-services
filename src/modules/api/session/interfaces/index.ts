import { Request } from "express";
import { User } from "@prisma/client";

export interface SessionInfo {
    deviceName?: string;
    deviceType?: string;
    browser?: string;
    os?: string;
    ipAddress?: string;
    location?: string;
    deviceToken?: string;
}

export interface RequestWithSession extends Request {
    user: User;
    sessionId?: string;
}

export interface SessionResponse {
    id: string;
    deviceName: string | null;
    deviceType: string | null;
    browser: string | null;
    os: string | null;
    ipAddress: string | null;
    location: string | null;
    isActive: boolean;
    isCurrent: boolean;
    lastActiveAt: Date;
    createdAt: Date;
}
