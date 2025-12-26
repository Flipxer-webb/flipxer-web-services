/**
 * Biometric Authentication Controller
 * 
 * Provides WebAuthn/Passkey endpoints for:
 * - Credential registration (requires password verification)
 * - Biometric login
 * - Transaction verification via biometrics
 * - Credential management (list, revoke)
 */

import {
    Body,
    Controller,
    Delete,
    Get,
    HttpCode,
    HttpException,
    HttpStatus,
    Post,
    Req,
    UseGuards,
    ValidationPipe,
} from '@nestjs/common';
import { Request } from 'express';
import {
    ApiTags,
    ApiOperation,
    ApiBearerAuth,
    ApiResponse,
} from '@nestjs/swagger';
import { User } from '@/modules/api/user';
import { User as UserModel } from '@prisma/client';
import { AuthGuard } from '../../guard';
import { BiometricService } from '../../services/biometric.service';
import { AuthService } from '../../services';
import { SessionService } from '@/modules/api/session/services';
import {
    BiometricRegisterOptionsDto,
    BiometricRegisterDto,
    BiometricLoginOptionsDto,
    BiometricLoginDto,
    BiometricRevokeDto,
    BiometricVerifyTransactionDto,
} from '../../dtos/biometric.dto';

@ApiTags('Biometric Authentication')
@Controller('auth/biometric')
export class BiometricController {
    constructor(
        private readonly biometricService: BiometricService,
        private readonly authService: AuthService,
        private readonly sessionService: SessionService,
    ) { }

    /**
     * Get WebAuthn registration options
     * Requires password verification for security
     */
    @Post('register/options')
    @UseGuards(AuthGuard)
    @ApiBearerAuth()
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Get WebAuthn registration options' })
    @ApiResponse({ status: 200, description: 'Registration options generated' })
    @ApiResponse({ status: 401, description: 'Invalid password' })
    async getRegistrationOptions(
        @User() user: UserModel,
        @Body(ValidationPipe) dto: BiometricRegisterOptionsDto,
    ) {
        try {
            // Verify password before allowing biometric registration
            const isValidPassword = await this.authService.comparePassword(
                dto.password,
                user.password || '',
            );

            if (!isValidPassword) {
                return {
                    success: false,
                    statusCode: HttpStatus.UNAUTHORIZED,
                    message: 'Invalid password',
                };
            }

            const options = await this.biometricService.generateRegistrationOptions(user.id);

            return {
                success: true,
                statusCode: HttpStatus.OK,
                message: 'Registration options generated',
                data: options,
            };
        } catch (error) {
            console.error('[BiometricController] Registration options error:', error);
            console.error('[BiometricController] Error stack:', error instanceof Error ? error.stack : 'No stack');
            throw new HttpException(
                'Failed to generate registration options',
                HttpStatus.INTERNAL_SERVER_ERROR,
            );
        }
    }

    /**
     * Complete biometric credential registration
     */
    @Post('register')
    @UseGuards(AuthGuard)
    @ApiBearerAuth()
    @HttpCode(HttpStatus.CREATED)
    @ApiOperation({ summary: 'Register a new biometric credential' })
    @ApiResponse({ status: 201, description: 'Credential registered successfully' })
    @ApiResponse({ status: 400, description: 'Invalid registration response' })
    async register(
        @User() user: UserModel,
        @Body(ValidationPipe) dto: BiometricRegisterDto,
    ) {
        const result = await this.biometricService.verifyRegistration(
            user.id,
            dto.response,
            dto.deviceName,
        );

        return {
            success: true,
            statusCode: HttpStatus.CREATED,
            message: 'Biometric credential registered successfully',
            data: result,
        };
    }

    /**
     * Get WebAuthn authentication options for login
     */
    @Post('login/options')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Get WebAuthn authentication options for login' })
    @ApiResponse({ status: 200, description: 'Authentication options generated' })
    async getLoginOptions(
        @Body(ValidationPipe) dto: BiometricLoginOptionsDto,
    ) {
        const options = await this.biometricService.generateAuthenticationOptions(dto.email);

        return {
            success: true,
            statusCode: HttpStatus.OK,
            message: 'Authentication options generated',
            data: options,
        };
    }

    /**
     * Complete biometric login
     * Returns JWT tokens like regular login
     */
    @Post('login')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Login with biometric authentication' })
    @ApiResponse({ status: 200, description: 'Login successful' })
    @ApiResponse({ status: 401, description: 'Biometric authentication failed' })
    async login(
        @Body(ValidationPipe) dto: BiometricLoginDto,
        @Req() req: Request,
    ) {
        const authResult = await this.biometricService.verifyAuthentication(
            dto.response,
            dto.email,
        );

        // If 2FA is enabled, return temp token for 2FA verification
        if (authResult.requiresTwoFactor) {
            // Generate temporary token for 2FA flow
            const tempToken = await this.authService.generateTempTokenFor2FA(authResult.userId);

            return {
                success: true,
                statusCode: HttpStatus.OK,
                message: 'Biometric authentication successful, 2FA required',
                data: {
                    requiresTwoFactor: true,
                    tempToken,
                },
            };
        }

        // Generate full session and tokens
        const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0] || req.ip || 'Unknown';

        const session = await this.sessionService.createSession(authResult.userId, {
            deviceType: dto.deviceType || 'unknown',
            browser: dto.browser || 'Unknown',
            os: dto.os || 'Unknown',
            ipAddress: ip,
        });

        const tokens = await this.authService.generateTokensForUser(authResult.userId, session.sessionId);

        return {
            success: true,
            statusCode: HttpStatus.OK,
            message: 'Biometric login successful',
            data: {
                accessToken: tokens.accessToken,
                refreshToken: tokens.refreshToken,
                sessionId: session.sessionId,
            },
        };
    }

    /**
     * List all biometric credentials for logged-in user
     */
    @Get('credentials')
    @UseGuards(AuthGuard)
    @ApiBearerAuth()
    @ApiOperation({ summary: 'List registered biometric credentials' })
    @ApiResponse({ status: 200, description: 'Credentials retrieved' })
    async listCredentials(@User() user: UserModel) {
        const credentials = await this.biometricService.listCredentials(user.id);

        return {
            success: true,
            statusCode: HttpStatus.OK,
            message: 'Biometric credentials retrieved',
            data: { credentials },
        };
    }

    /**
     * Revoke a biometric credential
     */
    @Delete('credentials')
    @UseGuards(AuthGuard)
    @ApiBearerAuth()
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Revoke a biometric credential' })
    @ApiResponse({ status: 200, description: 'Credential revoked' })
    @ApiResponse({ status: 404, description: 'Credential not found' })
    async revokeCredential(
        @User() user: UserModel,
        @Body(ValidationPipe) dto: BiometricRevokeDto,
    ) {
        await this.biometricService.revokeCredential(user.id, dto.credentialId);

        return {
            success: true,
            statusCode: HttpStatus.OK,
            message: 'Biometric credential revoked successfully',
        };
    }

    /**
     * Check if user has biometric credentials
     */
    @Get('status')
    @UseGuards(AuthGuard)
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Check if user has biometric credentials' })
    @ApiResponse({ status: 200, description: 'Status retrieved' })
    async getStatus(@User() user: UserModel) {
        const hasCredentials = await this.biometricService.hasCredentials(user.id);

        return {
            success: true,
            statusCode: HttpStatus.OK,
            message: 'Biometric status retrieved',
            data: { hasCredentials },
        };
    }

    /**
     * Get transaction verification options
     */
    @Post('transaction/options')
    @UseGuards(AuthGuard)
    @ApiBearerAuth()
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Get biometric verification options for transaction' })
    @ApiResponse({ status: 200, description: 'Transaction verification options generated' })
    async getTransactionOptions(@User() user: UserModel) {
        const options = await this.biometricService.generateTransactionVerificationOptions(user.id);

        return {
            success: true,
            statusCode: HttpStatus.OK,
            message: 'Transaction verification options generated',
            data: options,
        };
    }

    /**
     * Verify transaction with biometrics
     */
    @Post('transaction/verify')
    @UseGuards(AuthGuard)
    @ApiBearerAuth()
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Verify transaction with biometric authentication' })
    @ApiResponse({ status: 200, description: 'Transaction verified' })
    @ApiResponse({ status: 401, description: 'Verification failed' })
    async verifyTransaction(
        @User() user: UserModel,
        @Body(ValidationPipe) dto: BiometricVerifyTransactionDto,
    ) {
        const verified = await this.biometricService.verifyTransactionAuthorization(
            user.id,
            dto.response,
        );

        if (!verified) {
            return {
                success: false,
                statusCode: HttpStatus.UNAUTHORIZED,
                message: 'Biometric transaction verification failed',
            };
        }

        return {
            success: true,
            statusCode: HttpStatus.OK,
            message: 'Transaction verified successfully',
            data: { verified: true },
        };
    }
}
