export interface AuditContext {
    adminId?: number;
    ipAddress?: string;
    userAgent?: string;
}

export interface AuditLogParams {
    action: string;
    resource: string;
    resourceId?: string;
    details?: Record<string, any>;
    adminId?: number;
    ipAddress?: string;
    userAgent?: string;
}
