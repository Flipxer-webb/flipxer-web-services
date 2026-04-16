import * as QD from "@/libs/quidax";
import { Logger } from "@nestjs/common";
import * as t from "../types";
import { executeQuidaxCall } from "./error-handler";
import { QuidaxException } from "../errors";

// E0101 is Quidax's error code for "User already exists"
const QUIDAX_USER_EXISTS_ERROR_CODE = "E0101";

/**
 * Prefix an email with the environment tag so that non-production environments
 * create distinct Quidax sub-accounts and never collide with production data.
 *
 * Production  → unchanged  (john@example.com)
 * Staging     → stg_john@example.com
 * Development → dev_john@example.com
 */
export function namespaceEmail(email: string): string {
    const env = process.env.ENVIRONMENT || process.env.NODE_ENV || "development";
    if (env === "production") return email;

    const prefix = env === "staging" ? "stg" : "dev";
    const [localPart, domain] = email.split("@");
    return `${prefix}_${localPart}@${domain}`;
}

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
     * Find an existing sub-account by email address.
     * The email is namespaced by environment before lookup.
     * Returns null if not found (does not throw)
     */
    async findSubAccountByEmail(email: string): Promise<QD.IAccount | null> {
        return this.quidax.findSubAccountByEmail(namespaceEmail(email));
    }

    /**
     * Create a new sub-account, or return existing one if email already registered.
     * The email is namespaced by environment before any Quidax API call so that
     * staging/development never collide with production sub-accounts.
     *
     * If the email is already registered globally in Quidax (E0101 error),
     * automatically retries with an aliased email to work around the duplicate check.
     */
    async createOrFindSubAccount(
        options: t.CreateSubAccountOptions
    ): Promise<QD.QuidaxResponse<QD.CreateSubAccountResponse>> {
        // Namespace once — all downstream calls in this method use nsOptions
        const nsOptions: t.CreateSubAccountOptions = {
            ...options,
            email: namespaceEmail(options.email),
        };
        this.logger.log(
            `createOrFindSubAccount: original=${options.email} → namespaced=${nsOptions.email}`,
        );

        // First, try to find an existing sub-account with the namespaced email
        const existingAccount = await this.quidax.findSubAccountByEmail(nsOptions.email);
        if (existingAccount) {
            this.logger.log(`Found existing Quidax sub-account for ${nsOptions.email}: ${existingAccount.id}`);
            return {
                status: "success",
                message: "Existing sub-account found",
                data: existingAccount,
            };
        }

        // If not found, try to create a new one
        try {
            return await executeQuidaxCall(
                () => this.quidax.createSubAccount(nsOptions),
                "create account",
                this.logger,
            );
        } catch (error) {
            // If we get E0101 (user already exists), the email is registered globally in Quidax
            // (possibly under a different master account from previous registration)
            if (error instanceof QuidaxException && error.code === QUIDAX_USER_EXISTS_ERROR_CODE) {
                this.logger.warn(`E0101 error - email ${nsOptions.email} already exists globally in Quidax`);

                // First, retry the lookup in case it was a transient failure
                await new Promise(resolve => setTimeout(resolve, 1000));
                const retryAccount = await this.quidax.findSubAccountByEmail(nsOptions.email);
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
                const aliasedEmail = generateAliasedEmail(nsOptions.email);
                this.logger.log(`Creating sub-account with aliased email: ${aliasedEmail}`);

                try {
                    const aliasResult = await executeQuidaxCall(
                        () => this.quidax.createSubAccount({ ...nsOptions, email: aliasedEmail }),
                        "create account",
                        this.logger,
                    );

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
        const nsOptions = { ...options, email: namespaceEmail(options.email) };
        return executeQuidaxCall(
            () => this.quidax.createSubAccount(nsOptions),
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
