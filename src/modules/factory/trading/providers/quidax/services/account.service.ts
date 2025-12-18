import * as QD from "@/libs/quidax";
import { Logger } from "@nestjs/common";
import * as t from "../types";
import { executeQuidaxCall } from "./error-handler";

// E0101 is Quidax's error code for "User already exists"
const QUIDAX_USER_EXISTS_ERROR_CODE = "E0101";

/**
 * Quidax Account Service - Handles sub-account operations
 */
export class QuidaxAccountService {
    private readonly logger = new Logger(QuidaxAccountService.name);
    constructor(private readonly quidax: QD.QuidaxLib) {}

    /**
     * Find an existing sub-account by email address
     * Returns null if not found (does not throw)
     */
    async findSubAccountByEmail(email: string): Promise<QD.IAccount | null> {
        return this.quidax.findSubAccountByEmail(email);
    }

    /**
     * Create a new sub-account, or return existing one if email already registered
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
                data: existingAccount as QD.CreateSubAccountResponse,
            };
        }

        // If not found, try to create a new one
        try {
            return await this.createSubAccount(options);
        } catch (error) {
            // If we get E0101 (user already exists), the lookup might have failed
            // Retry the lookup one more time before failing
            if (error instanceof QD.QuidaxValidationError && error.code === QUIDAX_USER_EXISTS_ERROR_CODE) {
                this.logger.warn(`E0101 error - user may already exist. Retrying lookup for ${options.email}`);
                
                // Wait a moment and retry the lookup
                await new Promise(resolve => setTimeout(resolve, 1000));
                
                const retryAccount = await this.findSubAccountByEmail(options.email);
                if (retryAccount) {
                    this.logger.log(`Found account on retry lookup: ${retryAccount.id}`);
                    return {
                        status: "success",
                        message: "Existing sub-account found on retry",
                        data: retryAccount as QD.CreateSubAccountResponse,
                    };
                }
                
                // If still not found, the email might be registered under a different format
                this.logger.error(`E0101 error but cannot find account for ${options.email} - email may be registered differently in Quidax`);
            }
            
            // Re-throw the original error
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
