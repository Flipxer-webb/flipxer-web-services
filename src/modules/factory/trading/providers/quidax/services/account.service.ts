import * as QD from "@/libs/quidax";
import { Logger } from "@nestjs/common";
import * as t from "../types";
import { executeQuidaxCall } from "./error-handler";
import { QuidaxException } from "../errors";

// E0101 is Quidax's error code for "User already exists"
const QUIDAX_USER_EXISTS_ERROR_CODE = "E0101";

/**
 * Generate an aliased email for Gmail addresses to bypass Quidax duplicate check.
 * Gmail ignores everything after + so emails still deliver to the original address.
 * For non-Gmail addresses, adds a timestamp suffix before the @.
 */
function generateAliasedEmail(email: string): string {
    const normalizedEmail = email.toLowerCase().trim();
    const [localPart, domain] = normalizedEmail.split("@");

    // Check if it's a Gmail address (gmail.com or googlemail.com)
    const isGmail = domain.toLowerCase() === "gmail.com" || domain.toLowerCase() === "googlemail.com";

    if (isGmail) {
        // Use Gmail + alias: user@gmail.com -> user+flip123@gmail.com
        const timestamp = Date.now().toString().slice(-6);
        return `${localPart}+flip${timestamp}@${domain}`;
    } else {
        // For other providers, add timestamp suffix: user@example.com -> user.flip123@example.com
        const timestamp = Date.now().toString().slice(-6);
        return `${localPart}.flip${timestamp}@${domain}`;
    }
}

/**
 * Quidax Account Service - Handles sub-account operations
 */
export class QuidaxAccountService {
    private readonly logger = new Logger(QuidaxAccountService.name);
    constructor(private readonly quidax: QD.QuidaxLib) { }

    /**
     * Find an existing sub-account by email address
     * Returns null if not found (does not throw)
     */
    async findSubAccountByEmail(email: string): Promise<QD.IAccount | null> {
        return this.quidax.findSubAccountByEmail(email);
    }

    /**
     * Create a new sub-account, or return existing one if email already registered.
     * If the email is already registered globally in Quidax (E0101 error),
     * automatically retries with an aliased email to work around the duplicate check.
     */
    async createOrFindSubAccount(
        options: t.CreateSubAccountOptions
    ): Promise<QD.QuidaxResponse<QD.CreateSubAccountResponse>> {
        // First, try to find an existing sub-account with this email
        const existingAccount = await this.findSubAccountByEmail(options.email);
        if (existingAccount) {
            this.logger.log(`Found existing Quidax sub-account for ${options.email}: ${existingAccount.id}`);
            return {
                status: "success",
                message: "Existing sub-account found",
                data: existingAccount,
            };
        }

        // If not found, try to create a new one
        try {
            return await this.createSubAccount(options);
        } catch (error) {
            // If we get E0101 (user already exists), the email is registered globally in Quidax
            // (possibly under a different master account from previous registration)
            if (error instanceof QuidaxException && error.code === QUIDAX_USER_EXISTS_ERROR_CODE) {
                this.logger.warn(`E0101 error - email ${options.email} already exists globally in Quidax`);

                // First, retry the lookup in case it was a transient failure
                await new Promise(resolve => setTimeout(resolve, 1000));
                const retryAccount = await this.findSubAccountByEmail(options.email);
                if (retryAccount) {
                    this.logger.log(`Found account on retry lookup: ${retryAccount.id}`);
                    return {
                        status: "success",
                        message: "Existing sub-account found on retry",
                        data: retryAccount,
                    };
                }

                // Email exists globally but not under our master account
                // Create with aliased email to bypass the duplicate check
                const aliasedEmail = generateAliasedEmail(options.email);
                this.logger.log(`Creating sub-account with aliased email: ${aliasedEmail}`);

                try {
                    const aliasResult = await this.createSubAccount({
                        ...options,
                        email: aliasedEmail,
                    });

                    this.logger.log(`Successfully created sub-account with aliased email: ${aliasResult.data.id}`);
                    return aliasResult;
                } catch (aliasError) {
                    this.logger.error(`Failed to create sub-account even with aliased email: ${aliasError instanceof Error ? aliasError.message : String(aliasError)}`);
                    throw aliasError;
                }
            }

            // Re-throw non-E0101 errors
            throw error;
        }
    }

    async createSubAccount(
        options: t.CreateSubAccountOptions
    ): Promise<QD.QuidaxResponse<QD.CreateSubAccountResponse>> {
        return executeQuidaxCall(
            () => this.quidax.createSubAccount(options),
            "create account",
            this.logger
        );
    }

    async getAccountDetail(
        options: t.GetAccountDetailOptions
    ): Promise<QD.QuidaxResponse<QD.GetAccountDetailResponse>> {
        return executeQuidaxCall(
            () => this.quidax.getAccountDetail(options),
            "get account",
            this.logger
        );
    }
}
