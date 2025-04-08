import { Controller, Post, Body, HttpException, HttpStatus, UseGuards } from '@nestjs/common';
import { PasswordService } from '../../services/passworReset.services'; // Verify this path
import { SendForgotPasswordDto, ResetPasswordDto } from '../../dtos'; // Adjust path as needed
import { ValidationPipe } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBody, ApiResponse as SwaggerApiResponse } from "@nestjs/swagger";
import { AuthGuard } from '@/modules/api/auth/guard';

@ApiTags("user")
@Controller('auth')
@UseGuards(AuthGuard) // Apply AuthGuard globally to the controller
export class PasswordController {
    constructor(private authService: PasswordService) {}

    @Post('forgot-password')
    @ApiOperation({ summary: 'Request password reset', description: 'Sends a password reset email to the user.' })
    @ApiBody({ description: 'User email address for password reset', type: SendForgotPasswordDto })
    @SwaggerApiResponse({ status: 200, description: 'Password reset email sent successfully' })
    @SwaggerApiResponse({ status: 400, description: 'Bad Request - Invalid email or validation error' })
    async forgotPassword(
        @Body(ValidationPipe) dto: SendForgotPasswordDto
    ) {
        try {
            return await this.authService.requestPasswordReset(dto);
        } catch (error) {
            throw new HttpException(error.message, HttpStatus.BAD_REQUEST);
        }
    }

    @Post('reset-password')
    @ApiOperation({ summary: 'Reset password', description: 'Resets the user’s password using a valid token.' })
    @ApiBody({ description: 'New password and token for resetting password', type: ResetPasswordDto })
    @SwaggerApiResponse({ status: 200, description: 'Password reset successfully' })
    @SwaggerApiResponse({ status: 400, description: 'Bad Request - Invalid token or validation error' })
    async resetPassword(
        @Body(ValidationPipe) dto: ResetPasswordDto
    ) {
        try {
            return await this.authService.resetPassword(dto);
        } catch (error) {
            throw new HttpException(error.message, HttpStatus.BAD_REQUEST);
        }
    }
}
