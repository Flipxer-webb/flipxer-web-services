import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { PrismaService } from "@/modules/core/prisma/services";

@Injectable()
export class AuthSchedulerService {
    private readonly logger = new Logger("AuthScheduler");

    constructor(private readonly prisma: PrismaService) {}

    @Cron("0 3 * * *", { timeZone: "Africa/Lagos" }) // 3am daily
    async cleanupExpiredSessions() {
        const result = await this.prisma.session.deleteMany({
            where: { expiresAt: { lt: new Date() } },
        });
        this.logger.log(`Cleaned up ${result.count} expired session(s)`);
    }
}
