import {
    Injectable,
    ForbiddenException,
    NotFoundException,
    Inject,
} from "@nestjs/common";
import { PrismaService } from "../../../core/prisma/services";
import {
    CreateBankDetailDto,
    UpdateBankDetailDto,
    BankDetailResponseDto,
    VerifyBankAccountDto,
} from "../dtos";
import { ApiResponse, buildResponse } from "@/utils";
import { BankInjectionToken } from "@/modules/factory/bank/types";
import { PaystackBank } from "@/modules/factory/bank/providers/paystack.provider";

@Injectable()
export class BankService {
    constructor(
        private readonly prisma: PrismaService,
        @Inject(BankInjectionToken.PAYSTACK)
        private readonly paystackService: PaystackBank
    ) {}

    async getListOfBanks() {
        const banks = await this.paystackService.getBanks();
        return buildResponse({
            message: "banks successfully retrieved",
            data: banks,
        });
    }

    async verifyBankAccount(options: VerifyBankAccountDto) {
        const account = await this.paystackService.resolveBankAccount({
            account_number: options.accountNumber,
            bank_code: options.bankCode,
        });

        return buildResponse({
            message: "account successfully verified",
            data: {
                accountName: account.data.account_name,
                accountNumber: account.data.account_number,
            },
        });
    }

    async create(
        userId: number,
        dto: CreateBankDetailDto
    ): Promise<ApiResponse<BankDetailResponseDto>> {
        const user = await this.prisma.user.findUnique({
            where: { id: userId },
        });
        if (
            !user ||
            (user.userType !== "INDIVIDUAL" && user.userType !== "BUSINESS")
        ) {
            throw new ForbiddenException(
                "Only INDIVIDUAL and BUSINESS users can add bank details"
            );
        }

        const data = await this.prisma.bankDetail.create({
            data: {
                userId,
                bankName: dto.bankName,
                accountName: dto.accountName,
                accountNumber: dto.accountNumber,
            },
        });

        return buildResponse({
            message: "Bank detail created",
            data,
        });
    }

    async findAll(
        userId: number
    ): Promise<ApiResponse<BankDetailResponseDto[]>> {
        const user = await this.prisma.user.findUnique({
            where: { id: userId },
        });
        if (!user) {
            throw new NotFoundException("User not found");
        }

        const data = await this.prisma.bankDetail.findMany({
            where: { userId },
        });

        return buildResponse({
            message: "Bank details retrieved",
            data,
        });
    }

    async findOne(
        userId: number,
        bankDetailId: number
    ): Promise<ApiResponse<BankDetailResponseDto>> {
        const bankDetail = await this.prisma.bankDetail.findUnique({
            where: { id: bankDetailId },
        });

        return buildResponse({
            message: "Bank detail retrieved",
            data: bankDetail,
        });
    }

    async update(
        userId: number,
        bankDetailId: number,
        dto: UpdateBankDetailDto
    ): Promise<ApiResponse<BankDetailResponseDto>> {
        const bankDetail = await this.prisma.bankDetail.findUnique({
            where: { id: bankDetailId },
        });

        if (!bankDetail || bankDetail.userId !== userId) {
            throw new NotFoundException(
                "Bank detail not found or does not belong to this user"
            );
        }

        const data = await this.prisma.bankDetail.update({
            where: { id: bankDetailId },
            data: {
                bankName: dto.bankName ?? bankDetail.bankName,
                accountName: dto.accountName ?? bankDetail.accountName,
                accountNumber: dto.accountNumber ?? bankDetail.accountNumber,
            },
        });

        return buildResponse({
            message: "Bank detail updated",
            data,
        });
    }

    async remove(
        userId: number,
        bankDetailId: number
    ): Promise<ApiResponse<null>> {
        const bankDetail = await this.prisma.bankDetail.findUnique({
            where: { id: bankDetailId },
        });

        if (!bankDetail || bankDetail.userId !== userId) {
            throw new NotFoundException(
                "Bank detail not found or does not belong to this user"
            );
        }

        await this.prisma.bankDetail.delete({
            where: { id: bankDetailId },
        });

        return buildResponse({
            message: "Bank detail deleted",
            data: null,
        });
    }
}
