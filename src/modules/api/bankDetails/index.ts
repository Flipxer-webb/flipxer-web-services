import { Module } from '@nestjs/common';
import { BankDetailsService } from './services';
import { BankDetailsController } from './controllers';
import { PrismaService } from '../../core/prisma/services'; // Assumed existing Prisma service

@Module({
  providers: [BankDetailsService, PrismaService],
  controllers: [BankDetailsController],
})
export class BankDetailsModule {}