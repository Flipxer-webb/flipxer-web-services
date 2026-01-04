import {
    Injectable,
    CanActivate,
    ExecutionContext,
    ForbiddenException,
    Logger,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { PrismaService } from "@/modules/core/prisma/services";

interface TransactionVerificationPayload {
    userId: number;
    type: "transaction_verification";
    method: string;
    verifiedAt: number;
}

/**
 * TransactionSecurityGuard
 * 
 * Validates that users with security methods enabled have provided
 * a valid verification token before processing transactions.
 * 
 * Flow:
 * 1. User calls verifySecurityMethod API → receives verificationToken
 * 2. User submits transaction with verificationToken in body
 * 3. This guard validates the token before allowing the transaction
 */
@Injectable()
export class TransactionSecurityGuard implements CanActivate {
    private readonly logger = new Logger("TransactionSecurityGuard");

    constructor(
        private readonly jwtService: JwtService,
        private readonly prisma: PrismaService
    ) { }

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const request = context.switchToHttp().getRequest();
        const user = request.user;

        if (!user?.id) {
            throw new ForbiddenException("User not authenticated");
        }

        // Get user's security settings
        const userData = await this.prisma.user.findUnique({
            where: { id: user.id },
            select: {
                securityMethods: true,
                requiredMethodCount: true,
            },
        });

        const securityMethods = (userData?.securityMethods as any) || {};
        const enabledMethods = Object.entries(securityMethods)
            .filter(([_, enabled]) => enabled)
            .map(([method]) => method);

        // If no security methods enabled, allow transaction without verification
        if (enabledMethods.length === 0) {
            this.logger.debug(`User ${user.id} has no security methods enabled, allowing transaction`);
            return true;
        }

        // User has security methods enabled - require verification token
        const verificationToken = request.body?.verificationToken;

        if (!verificationToken) {
            this.logger.warn(`User ${user.id} has security methods enabled but no verification token provided`);
            throw new ForbiddenException({
                message: "Transaction verification required",
                code: "VERIFICATION_REQUIRED",
                enabledMethods,
                requiredMethodCount: userData?.requiredMethodCount ?? 1,
            });
        }

        // Validate the verification token
        try {
            const payload = await this.jwtService.verifyAsync<TransactionVerificationPayload>(
                verificationToken
            );

            // Verify token type
            if (payload.type !== "transaction_verification") {
                throw new ForbiddenException("Invalid verification token type");
            }

            // Verify token belongs to the same user
            if (payload.userId !== user.id) {
                this.logger.warn(`Token user ${payload.userId} doesn't match request user ${user.id}`);
                throw new ForbiddenException("Verification token user mismatch");
            }

            // Check token age (additional safety - JWT expiry should handle this)
            const tokenAgeMs = Date.now() - payload.verifiedAt;
            const maxAgeMs = 5 * 60 * 1000; // 5 minutes

            if (tokenAgeMs > maxAgeMs) {
                throw new ForbiddenException("Verification token expired");
            }

            this.logger.log(`User ${user.id} passed transaction security check (method: ${payload.method})`);
            return true;

        } catch (error) {
            if (error instanceof ForbiddenException) {
                throw error;
            }

            this.logger.error(`Token verification failed: ${error.message}`);
            throw new ForbiddenException({
                message: "Invalid or expired verification token",
                code: "INVALID_TOKEN",
                enabledMethods,
                requiredMethodCount: userData?.requiredMethodCount ?? 1,
            });
        }
    }
}
