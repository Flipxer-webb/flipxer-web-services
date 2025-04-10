import { Controller, Post, Body, UsePipes, ValidationPipe, UseGuards } from '@nestjs/common';
import { SendRecoveryPinDto, VerifyRecoveryPinDto } from '../../dtos/recovery-email';
import { ApiTags, ApiOperation, ApiResponse, ApiBody } from '@nestjs/swagger';
import { AuthGuard } from '@/modules/api/auth/guard';
import { RecoveryEmailService } from '../../services/recovery-email';

@ApiTags('Recovery Email')
@Controller('recovery-email')
@UseGuards(AuthGuard)
export class RecoveryEmailController {
  constructor(private readonly recoveryEmailService: RecoveryEmailService) {}

  @Post('send-pin')
  @UsePipes(new ValidationPipe())
  @ApiOperation({ summary: 'Send a 6-digit recovery PIN to the specified recovery email' })
  @ApiBody({ type: SendRecoveryPinDto })
  @ApiResponse({ status: 201, description: 'Recovery PIN sent successfully', type: Object })
  @ApiResponse({ status: 400, description: 'Bad Request - User not found' })
  @ApiResponse({ status: 401, description: 'Unauthorized - Authentication required' })
  async sendRecoveryPin(@Body() dto: SendRecoveryPinDto) {
    return this.recoveryEmailService.sendRecoveryPin(dto);
  }

  @Post('verify-pin')
  @UsePipes(new ValidationPipe())
  @ApiOperation({ summary: 'Verify the 6-digit PIN and update the recovery email' })
  @ApiBody({ type: VerifyRecoveryPinDto })
  @ApiResponse({ status: 201, description: 'Recovery email updated successfully', type: Object })
  @ApiResponse({ status: 400, description: 'Bad Request - Invalid PIN or PIN expired' })
  @ApiResponse({ status: 401, description: 'Unauthorized - Authentication required' })
  async verifyRecoveryPin(@Body() dto: VerifyRecoveryPinDto) {
    return this.recoveryEmailService.verifyRecoveryPin(dto);
  }
}