import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "@/modules/core/prisma/services";
import { AuditLogParams, AuditContext } from "./interfaces";

@Injectable()
export class AuditLogService {
    private readonly logger = new Logger(AuditLogService.name);

    constructor(private readonly prisma: PrismaService) {}

    async log(params: AuditLogParams): Promise<void> {
        try {
            await this.prisma.auditLog.create({
                data: {
                    action: params.action,
                    resource: params.resource,
                    resourceId: params.resourceId,
                    details: params.details ?? {},
                    adminId: params.adminId,
                    ipAddress: params.ipAddress,
                    userAgent: params.userAgent,
                },
            });
        } catch (error) {
            this.logger.error(
                `Failed to create audit log: action=${params.action} resource=${params.resource}`,
                error,
            );
        }
    }

    async logWithContext(
        action: string,
        resource: string,
        context: AuditContext,
        resourceId?: string,
        details?: Record<string, any>,
    ): Promise<void> {
        await this.log({
            action,
            resource,
            resourceId,
            details,
            adminId: context.adminId,
            ipAddress: context.ipAddress,
            userAgent: context.userAgent,
        });
    }

    /**
     * Extract audit context from an Express request object.
     */
    static extractContext(req: any): AuditContext {
        return {
            adminId: req?.user?.id,
            ipAddress: req?.ip,
            userAgent: req?.headers?.["user-agent"],
        };
    }
}
