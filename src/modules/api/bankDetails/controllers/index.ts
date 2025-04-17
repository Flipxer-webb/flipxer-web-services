import {
  Controller,
  Post,
  Get,
  Patch,
  Delete,
  Body,
  Param,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiParam } from '@nestjs/swagger';
import { AuthGuard } from '../../auth/guard';
import { BankDetailsService } from '../services';
import {
  CreateBankDetailDto,
  UpdateBankDetailDto,
  BankDetailResponseDto,
} from '../dtos';
import { ApiResponse } from '@/utils';
import { User } from '@/modules/api/user';
import { User as UserModel } from '@prisma/client';

@ApiTags('Bank Details')
@Controller('bank-details')
@UseGuards(AuthGuard)
@ApiBearerAuth()
export class BankDetailsController {
  constructor(private readonly bankDetailsService: BankDetailsService) {}

  @Post()
  @ApiOperation({
    summary: 'Add a new bank detail for the authenticated user',
    description: 'Creates a bank detail for the authenticated user.',
  })
  async create(
    @User() user: UserModel,
    @Body(ValidationPipe) createBankDetailDto: CreateBankDetailDto,
  ): Promise<ApiResponse<BankDetailResponseDto>> {
    return this.bankDetailsService.create(user.id, createBankDetailDto);
  }

  @Get()
  @ApiOperation({
    summary: 'Get all bank details for the authenticated user',
  })
  async findAll(
    @User() user: UserModel,
  ): Promise<ApiResponse<BankDetailResponseDto[]>> {
    return this.bankDetailsService.findAll(user.id);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get a specific bank detail by ID for the authenticated user',
  })
  @ApiParam({
    name: 'id',
    description: 'ID of the bank detail to retrieve',
    type: Number,
    example: 1,
  })
  async findOne(
    @User() user: UserModel,
    @Param('id') id: string,
  ): Promise<ApiResponse<BankDetailResponseDto>> {
    return this.bankDetailsService.findOne(user.id, parseInt(id));
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Update a specific bank detail by ID for the authenticated user',
  })
  @ApiParam({
    name: 'id',
    description: 'ID of the bank detail to update',
    type: Number,
    example: 1,
  })
  async update(
    @User() user: UserModel,
    @Param('id') id: string,
    @Body(ValidationPipe) updateBankDetailDto: UpdateBankDetailDto,
  ): Promise<ApiResponse<BankDetailResponseDto>> {
    return this.bankDetailsService.update(user.id, parseInt(id), updateBankDetailDto);
  }

  @Delete(':id')
  @ApiOperation({
    summary: 'Delete a specific bank detail by ID for the authenticated user',
  })
  @ApiParam({
    name: 'id',
    description: 'ID of the bank detail to delete',
    type: Number,
    example: 1,
  })
  async remove(
    @User() user: UserModel,
    @Param('id') id: string,
  ): Promise<ApiResponse<null>> {
    return this.bankDetailsService.remove(user.id, parseInt(id));
  }
}