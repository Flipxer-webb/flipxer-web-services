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
 * valid verification tokens for ALL their enabled methods.
 * 
 * Logic:
 * - If user has 1 method enabled → require 1 verification
 * - If user has 2 methods enabled → require 2 verifications
 * - If user has N methods enabled → require N verifications
 * - At least 1 method must be enabled to transact
 * 
 * Flow:
 * 1. User verifies each enabled method via verifySecurityMethod API → receives JWT tokens
 * 2. User submits transaction with comma-separated tokens in verificationToken field
 * 3. This guard validates each token and ensures all enabled methods are covered
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
            },
        });

        const securityMethods = (userData?.securityMethods as any) || {};
        const enabledMethods = Object.entries(securityMethods)
            .filter(([_, enabled]) => enabled)
            .map(([method]) => method);

        // If no security methods enabled, block transaction (at least 1 required)
        if (enabledMethods.length === 0) {
            this.logger.warn(`User ${user.id} has no security methods enabled`);
            throw new ForbiddenException({
                message: "At least one security method must be enabled to transact",
                code: "NO_SECURITY_METHODS",
                enabledMethods: [],
                requiredMethodCount: 1,
            });
        }

        // Required count = number of enabled methods
        const requiredMethodCount = enabledMethods.length;

        // User has security methods enabled - require verification token
        const verificationToken = request.body?.verificationToken;

        if (!verificationToken) {
            this.logger.warn(`User ${user.id} has ${requiredMethodCount} security methods enabled but no verification token provided`);
            throw new ForbiddenException({
                message: "Transaction verification required",
                code: "VERIFICATION_REQUIRED",
                enabledMethods,
                requiredMethodCount,
            });
        }

        // Parse tokens (comma-separated for multi-method verification)
        const tokens = verificationToken.split(',').map((t: string) => t.trim()).filter((t: string) => t);
        const verifiedMethods = new Set<string>();

        // Validate each token
        for (const token of tokens) {
            try {
                const payload = await this.jwtService.verifyAsync<TransactionVerificationPayload>(token);

                // Verify token type
                if (payload.type !== "transaction_verification") {
                    this.logger.warn(`Invalid token type: ${payload.type}`);
                    continue;
                }

                // Verify token belongs to the same user
                if (payload.userId !== user.id) {
                    this.logger.warn(`Token user ${payload.userId} doesn't match request user ${user.id}`);
                    continue;
                }

                // Check token age (5 minutes max)
                const tokenAgeMs = Date.now() - payload.verifiedAt;
                const maxAgeMs = 5 * 60 * 1000;

                if (tokenAgeMs > maxAgeMs) {
                    this.logger.warn(`Token for method ${payload.method} expired`);
                    continue;
                }

                // Token is valid - record the verified method
                verifiedMethods.add(payload.method);

            } catch (error) {
                this.logger.error(`Token verification failed: ${error.message}`);
            }
        }

        // Check if ALL enabled methods have been verified
        const missingMethods = enabledMethods.filter(m => !verifiedMethods.has(m));

        if (missingMethods.length > 0) {
            this.logger.warn(`User ${user.id} missing verification for methods: ${missingMethods.join(', ')}`);
            throw new ForbiddenException({
                message: "All enabled security methods must be verified",
                code: "INCOMPLETE_VERIFICATION",
                enabledMethods,
                verifiedMethods: Array.from(verifiedMethods),
                missingMethods,
                requiredMethodCount,
            });
        }

        this.logger.log(`User ${user.id} passed transaction security check (verified: ${Array.from(verifiedMethods).join(', ')})`);
        return true;
    }
}

