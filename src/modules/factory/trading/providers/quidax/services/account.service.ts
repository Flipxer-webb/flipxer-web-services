import * as QD from "@/libs/quidax";
import { Logger } from "@nestjs/common";
import * as t from "../types";
import { executeQuidaxCall } from "./error-handler";

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

        // If not found, create a new one
        return this.createSubAccount(options);
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
