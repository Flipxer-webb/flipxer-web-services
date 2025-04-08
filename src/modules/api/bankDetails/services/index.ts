import { Injectable, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../core/prisma/services'; // Adjust path as needed
import { CreateBankDetailDto, UpdateBankDetailDto, BankDetailResponseDto } from '../dtos';

@Injectable()
export class BankDetailsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(userId: number, dto: CreateBankDetailDto): Promise<BankDetailResponseDto> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || (user.userType !== 'INDIVIDUAL' && user.userType !== 'BUSINESS')) {
      throw new ForbiddenException('Only INDIVIDUAL and BUSINESS users can add bank details');
    }

    return this.prisma.bankDetail.create({
      data: {
        userId,
        bankName: dto.bankName,
        accountName: dto.accountName,
        accountNumber: dto.accountNumber,
      },
    });
  }

  async findAll(userId: number): Promise<BankDetailResponseDto[]> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    return this.prisma.bankDetail.findMany({
      where: { userId },
    });
  }

  async findOne(userId: number, bankDetailId: number): Promise<BankDetailResponseDto> {
    const bankDetail = await this.prisma.bankDetail.findUnique({
      where: { id: bankDetailId },
    });

    if (!bankDetail || bankDetail.userId !== userId) {
      throw new NotFoundException('Bank detail not found or does not belong to this user');
    }

    return bankDetail;
  }

  async update(userId: number, bankDetailId: number, dto: UpdateBankDetailDto): Promise<BankDetailResponseDto> {
    const bankDetail = await this.findOne(userId, bankDetailId);

    return this.prisma.bankDetail.update({
      where: { id: bankDetailId },
      data: {
        bankName: dto.bankName ?? bankDetail.bankName,
        accountName: dto.accountName ?? bankDetail.accountName,
        accountNumber: dto.accountNumber ?? bankDetail.accountNumber,
      },
    });
  }

  async remove(userId: number, bankDetailId: number): Promise<void> {
    await this.findOne(userId, bankDetailId);
    await this.prisma.bankDetail.delete({
      where: { id: bankDetailId },
    });
  }
}