import {
    Injectable,
    CanActivate,
    ExecutionContext,
    ForbiddenException,
    Logger,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { PrismaService } from "@/modules/core/prisma/services";
import * as crypto from "node:crypto";

interface TransactionVerificationPayload {
    userId: number;
    type: "transaction_verification";
    method: string;
    verifiedAt: number;
    contextHash?: string | null; // SHA256 hash binding token to transaction
}

/**
 * TransactionSecurityGuard
 * 
 * Enforces 2FA as the MANDATORY BASELINE for all transactions.
 * Additional security methods (SMS, Email, Trading Password, Biometric) 
 * provide extra protection on top of 2FA.
 * 
 * CRITICAL SECURITY: Tokens are bound to specific transactions via contextHash.
 * A token issued for one transaction cannot be used for a different transaction.
 * 
 * Logic:
 * - 2FA (Authenticator) is ALWAYS required - if not enabled, transaction blocked
 * - Additional methods (sms, email, tradingPassword, biometric) are optional
 * - If additional methods are enabled, they must ALSO be verified
 * - Token contextHash MUST match current transaction context (strict enforcement)
 * 
 * Flow:
 * 1. Check if 2FA is enabled → if not, block with "ENABLE_2FA_REQUIRED"
 * 2. Check for additional security methods enabled
 * 3. Require verification tokens for 2FA + all additional enabled methods
 * 4. Validate that token contextHash matches current transaction (prevents replay)
 */
@Injectable()
export class TransactionSecurityGuard implements CanActivate {
    private readonly logger = new Logger("TransactionSecurityGuard");

    constructor(
        private readonly jwtService: JwtService,
        private readonly prisma: PrismaService
    ) { }

    /**
     * Compute SHA256 hash of transaction context for verification binding.
     * Format: "amount|CURRENCY|recipient" normalized to uppercase currency.
     */
    private computeContextHash(amount: any, currency: any, recipient: any): string {
        const normalized = `${amount ?? ''}|${(currency ?? '').toString().toUpperCase()}|${recipient ?? ''}`;
        return crypto.createHash('sha256').update(normalized).digest('hex');
    }

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

        // Compute expected context hash from current request
        // TASK-007: Support `asset` as alias for `currency` (Buy/Sell DTOs use `asset`)
        const { amount, currency, asset, recipient, address, walletAddress, recipientWalletAddress, recipientEmail, destinationTag } = request.body;
        const currencyValue = currency || asset || '';  // Fallback chain: currency -> asset -> empty
        const recipientValue = recipient || address || walletAddress || recipientWalletAddress || recipientEmail || destinationTag || '';
        const expectedContextHash = this.computeContextHash(amount, currencyValue, recipientValue);

        this.logger.debug(`Context hash inputs: amount=${amount}, currency=${currencyValue}, recipient=${recipientValue?.substring(0, 10)}...`);

        // Parse tokens (comma-separated for multi-method verification)
        const tokens = verificationToken.split(',').map((t: string) => t.trim()).filter(Boolean);
        const verifiedMethods = await this.validateTokens(tokens, user.id, expectedContextHash);

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

        this.logger.log(`User ${user.id} passed security check with context binding (verified: ${Array.from(verifiedMethods).join(', ')})`);
        return true;
    }

    private async validateTokens(
        tokens: string[],
        userId: number,
        expectedContextHash: string,
    ): Promise<Set<string>> {
        const verifiedMethods = new Set<string>();

        for (const token of tokens) {
            try {
                const method = await this.validateSingleToken(token, userId, expectedContextHash);
                if (method) {
                    verifiedMethods.add(method);
                }
            } catch (error) {
                if (error instanceof ForbiddenException) throw error;
                this.logger.error(`Token verification failed: ${error.message}`);
            }
        }

        return verifiedMethods;
    }

    private async validateSingleToken(
        token: string,
        userId: number,
        expectedContextHash: string,
    ): Promise<string | null> {
        const payload = await this.jwtService.verifyAsync<TransactionVerificationPayload>(token);

        if (payload.type !== "transaction_verification") {
            this.logger.warn(`Invalid token type: ${payload.type}`);
            return null;
        }

        if (payload.userId !== userId) {
            this.logger.warn(`Token user ${payload.userId} doesn't match request user ${userId}`);
            return null;
        }

        const tokenAgeMs = Date.now() - payload.verifiedAt;
        if (tokenAgeMs > 5 * 60 * 1000) {
            this.logger.warn(`Token for method ${payload.method} expired`);
            return null;
        }

        if (!payload.contextHash) {
            this.logger.error(`SECURITY: Token for user ${userId} missing contextHash - REJECTING`);
            throw new ForbiddenException({
                message: "Verification token must be bound to transaction context",
                code: "CONTEXT_HASH_REQUIRED",
            });
        }

        if (payload.contextHash !== expectedContextHash) {
            this.logger.error(
                `SECURITY: Context hash mismatch for user ${userId}! ` +
                `Token hash: ${payload.contextHash.substring(0, 16)}... ` +
                `Expected: ${expectedContextHash.substring(0, 16)}...`
            );
            throw new ForbiddenException({
                message: "Verification token was not issued for this transaction",
                code: "CONTEXT_MISMATCH",
            });
        }

        return payload.method;
    }
}
