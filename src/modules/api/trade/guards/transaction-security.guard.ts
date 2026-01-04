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
 * Enforces 2FA as the MANDATORY BASELINE for all transactions.
 * Additional security methods (SMS, Email, Trading Password, Biometric) 
 * provide extra protection on top of 2FA.
 * 
 * Logic:
 * - 2FA (Authenticator) is ALWAYS required - if not enabled, transaction blocked
 * - Additional methods (sms, email, tradingPassword, biometric) are optional
 * - If additional methods are enabled, they must ALSO be verified
 * 
 * Flow:
 * 1. Check if 2FA is enabled → if not, block with "ENABLE_2FA_REQUIRED"
 * 2. Check for additional security methods enabled
 * 3. Require verification tokens for 2FA + all additional enabled methods
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

        // Get user's security settings including 2FA status
        const userData = await this.prisma.user.findUnique({
            where: { id: user.id },
            select: {
                isTwoFactorEnabled: true,
                twoFactorSecret: true,
                securityMethods: true,
            },
        });

        // STEP 1: Check if 2FA is enabled (MANDATORY BASELINE)
        const has2FAEnabled = userData?.isTwoFactorEnabled && userData?.twoFactorSecret;

        if (!has2FAEnabled) {
            this.logger.warn(`User ${user.id} does not have 2FA enabled - blocking transaction`);
            throw new ForbiddenException({
                message: "Two-Factor Authentication (2FA) must be enabled to perform transactions",
                code: "ENABLE_2FA_REQUIRED",
            });
        }

        // STEP 2: Determine required methods
        // 2FA (authenticator) is always required
        const requiredMethods = new Set<string>(["authenticator"]);

        // Check for additional security methods enabled (excluding authenticator)
        const securityMethods = (userData?.securityMethods as any) || {};
        const additionalMethods = ["sms", "email", "tradingPassword", "biometric"];

        for (const method of additionalMethods) {
            if (securityMethods[method] === true) {
                requiredMethods.add(method);
            }
        }

        const requiredMethodList = Array.from(requiredMethods);
        this.logger.debug(`User ${user.id} requires verification for: ${requiredMethodList.join(', ')}`);

        // STEP 3: Require verification token(s)
        const verificationToken = request.body?.verificationToken;

        if (!verificationToken) {
            this.logger.warn(`User ${user.id} has ${requiredMethodList.length} method(s) but no token provided`);
            throw new ForbiddenException({
                message: "Transaction verification required",
                code: "VERIFICATION_REQUIRED",
                requiredMethods: requiredMethodList,
                requiredMethodCount: requiredMethodList.length,
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

        // STEP 4: Check if ALL required methods have been verified
        const missingMethods = requiredMethodList.filter(m => !verifiedMethods.has(m));

        if (missingMethods.length > 0) {
            this.logger.warn(`User ${user.id} missing verification for: ${missingMethods.join(', ')}`);
            throw new ForbiddenException({
                message: "All required security methods must be verified",
                code: "INCOMPLETE_VERIFICATION",
                requiredMethods: requiredMethodList,
                verifiedMethods: Array.from(verifiedMethods),
                missingMethods,
                requiredMethodCount: requiredMethodList.length,
            });
        }

        this.logger.log(`User ${user.id} passed security check (verified: ${Array.from(verifiedMethods).join(', ')})`);
        return true;
    }
}


