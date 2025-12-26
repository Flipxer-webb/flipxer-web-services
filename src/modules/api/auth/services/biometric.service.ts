/**
 * Biometric Authentication Service
 * 
 * Implements WebAuthn/Passkey support for:
 * - Registration of biometric credentials (with password verification)
 * - Login via biometric authentication
 * - Transaction verification via biometrics
 * 
 * Uses @simplewebauthn/server for WebAuthn protocol handling.
 */

import { Injectable, Logger, HttpStatus, HttpException } from '@nestjs/common';
import { PrismaService } from '@/modules/core/prisma/services';
import {
    generateRegistrationOptions,
    verifyRegistrationResponse,
    generateAuthenticationOptions,
    verifyAuthenticationResponse,
    VerifiedRegistrationResponse,
    VerifiedAuthenticationResponse,
} from '@simplewebauthn/server';
import type {
    RegistrationResponseJSON,
    AuthenticationResponseJSON,
    AuthenticatorTransportFuture,
    PublicKeyCredentialDescriptorJSON,
} from '@simplewebauthn/types';

// RP (Relying Party) configuration
const RP_NAME = process.env.APP_NAME || 'Flipxer';
const RP_ID = process.env.WEBAUTHN_RP_ID || 'localhost';
const RP_ORIGIN = process.env.WEBAUTHN_ORIGIN || 'http://localhost:3000';

export interface BiometricRegistrationOptions {
    challenge: string;
    rp: { name: string; id: string };
    user: { id: string; name: string; displayName: string };
    pubKeyCredParams: { alg: number; type: string }[];
    timeout: number;
    attestation: string;
    excludeCredentials: PublicKeyCredentialDescriptorJSON[];
}

export interface BiometricAuthenticationOptions {
    challenge: string;
    timeout: number;
    rpId: string;
    allowCredentials: PublicKeyCredentialDescriptorJSON[];
    userVerification: string;
}

export interface BiometricCredentialSummary {
    id: string;
    deviceName: string;
    createdAt: Date;
    lastUsedAt: Date | null;
}

@Injectable()
export class BiometricService {
    private readonly logger = new Logger(BiometricService.name);

    // Store challenges temporarily (in production, use Redis with short TTL)
    private challenges = new Map<string, string>();
    private readonly CHALLENGE_TTL_MS = 5 * 60 * 1000; // 5 minutes

    constructor(private readonly prisma: PrismaService) { }

    /**
     * Generate registration options for WebAuthn credential creation
     * This is called before the browser creates a new credential
     */
    async generateRegistrationOptions(userId: number): Promise<BiometricRegistrationOptions> {
        const user = await this.prisma.user.findUnique({
            where: { id: userId },
            include: { biometricCredentials: true },
        });

        if (!user) {
            throw new HttpException('User not found', HttpStatus.NOT_FOUND);
        }

        // Get existing credentials to exclude (prevent re-registration of same authenticator)
        const excludeCredentials: PublicKeyCredentialDescriptorJSON[] = user.biometricCredentials.map(cred => ({
            id: cred.id,
            type: 'public-key',
            transports: cred.transports as AuthenticatorTransportFuture[],
        }));

        const options = await generateRegistrationOptions({
            rpName: RP_NAME,
            rpID: RP_ID,
            userID: new TextEncoder().encode(user.identifier),
            userName: user.email,
            userDisplayName: `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.email,
            attestationType: 'none', // We don't need attestation for passkeys
            excludeCredentials,
            authenticatorSelection: {
                residentKey: 'preferred',
                userVerification: 'required', // Always require biometric/PIN
                authenticatorAttachment: 'platform', // Prefer built-in authenticators
            },
            timeout: 60000,
        });

        // Store challenge for verification (with cleanup)
        const challengeKey = `reg:${userId}`;
        this.challenges.set(challengeKey, options.challenge);
        setTimeout(() => this.challenges.delete(challengeKey), this.CHALLENGE_TTL_MS);

        this.logger.log(`Generated registration options for user ${userId}`);

        return options as BiometricRegistrationOptions;
    }

    /**
     * Verify and store a newly created WebAuthn credential
     */
    async verifyRegistration(
        userId: number,
        response: RegistrationResponseJSON,
        deviceName: string,
    ): Promise<{ credentialId: string }> {
        const challengeKey = `reg:${userId}`;
        const expectedChallenge = this.challenges.get(challengeKey);

        if (!expectedChallenge) {
            throw new HttpException('Registration challenge expired or not found', HttpStatus.BAD_REQUEST);
        }

        // Clean up challenge after use
        this.challenges.delete(challengeKey);

        let verification: VerifiedRegistrationResponse;
        try {
            verification = await verifyRegistrationResponse({
                response,
                expectedChallenge,
                expectedOrigin: RP_ORIGIN,
                expectedRPID: RP_ID,
                requireUserVerification: true,
            });
        } catch (error: any) {
            this.logger.error(`Registration verification failed: ${error.message}`);
            throw new HttpException('Failed to verify biometric registration', HttpStatus.BAD_REQUEST);
        }

        if (!verification.verified || !verification.registrationInfo) {
            throw new HttpException('Biometric registration verification failed', HttpStatus.BAD_REQUEST);
        }

        const { registrationInfo } = verification;

        // Check for duplicate credential ID
        const existingCredential = await this.prisma.userBiometricCredential.findUnique({
            where: { id: registrationInfo.credential.id },
        });

        if (existingCredential) {
            throw new HttpException('This biometric credential is already registered', HttpStatus.CONFLICT);
        }

        // Store the credential
        await this.prisma.userBiometricCredential.create({
            data: {
                id: registrationInfo.credential.id,
                userId,
                publicKey: Buffer.from(registrationInfo.credential.publicKey).toString('base64'),
                publicKeyAlgorithm: registrationInfo.credential.publicKey.byteLength > 0
                    ? registrationInfo.credentialType === 'public-key' ? -7 : -257 // ES256 or RS256
                    : -7,
                counter: registrationInfo.credential.counter,
                transports: (registrationInfo.credential.transports || []) as string[],
                deviceName,
                aaguid: registrationInfo.aaguid || null,
            },
        });

        this.logger.log(`Registered new biometric credential for user ${userId}: ${deviceName}`);

        return { credentialId: registrationInfo.credential.id };
    }

    /**
     * Generate authentication options for WebAuthn login
     */
    async generateAuthenticationOptions(email?: string): Promise<BiometricAuthenticationOptions & { userId?: number }> {
        let allowCredentials: PublicKeyCredentialDescriptorJSON[] = [];
        let userId: number | undefined;

        if (email) {
            const user = await this.prisma.user.findUnique({
                where: { email },
                include: { biometricCredentials: true },
            });

            if (user && user.biometricCredentials.length > 0) {
                userId = user.id;
                allowCredentials = user.biometricCredentials.map(cred => ({
                    id: cred.id,
                    type: 'public-key',
                    transports: cred.transports as AuthenticatorTransportFuture[],
                }));
            }
        }

        const options = await generateAuthenticationOptions({
            rpID: RP_ID,
            allowCredentials,
            userVerification: 'required',
            timeout: 60000,
        });

        // Store challenge for verification
        const challengeKey = email ? `auth:${email}` : `auth:conditional`;
        this.challenges.set(challengeKey, options.challenge);
        setTimeout(() => this.challenges.delete(challengeKey), this.CHALLENGE_TTL_MS);

        return {
            ...options,
            userId,
        } as BiometricAuthenticationOptions & { userId?: number };
    }

    /**
     * Verify a WebAuthn authentication assertion
     * Returns user info if verification succeeds
     */
    async verifyAuthentication(
        response: AuthenticationResponseJSON,
        email?: string,
    ): Promise<{ userId: number; requiresTwoFactor: boolean; isTwoFactorEnabled: boolean }> {
        // Find the credential
        const credential = await this.prisma.userBiometricCredential.findUnique({
            where: { id: response.id },
            include: { user: true },
        });

        if (!credential) {
            throw new HttpException('Biometric credential not recognized', HttpStatus.UNAUTHORIZED);
        }

        // Get challenge
        const challengeKey = email ? `auth:${email}` : `auth:conditional`;
        const expectedChallenge = this.challenges.get(challengeKey);

        if (!expectedChallenge) {
            throw new HttpException('Authentication challenge expired or not found', HttpStatus.BAD_REQUEST);
        }

        this.challenges.delete(challengeKey);

        let verification: VerifiedAuthenticationResponse;
        try {
            verification = await verifyAuthenticationResponse({
                response,
                expectedChallenge,
                expectedOrigin: RP_ORIGIN,
                expectedRPID: RP_ID,
                credential: {
                    id: credential.id,
                    publicKey: new Uint8Array(Buffer.from(credential.publicKey, 'base64')),
                    counter: credential.counter,
                    transports: credential.transports as AuthenticatorTransportFuture[],
                },
                requireUserVerification: true,
            });
        } catch (error: any) {
            this.logger.error(`Authentication verification failed: ${error.message}`);
            throw new HttpException('Biometric authentication failed', HttpStatus.UNAUTHORIZED);
        }

        if (!verification.verified) {
            throw new HttpException('Biometric authentication verification failed', HttpStatus.UNAUTHORIZED);
        }

        // Update counter for replay protection
        await this.prisma.userBiometricCredential.update({
            where: { id: credential.id },
            data: {
                counter: verification.authenticationInfo.newCounter,
                lastUsedAt: new Date(),
            },
        });

        this.logger.log(`Biometric authentication successful for user ${credential.userId}`);

        return {
            userId: credential.userId,
            requiresTwoFactor: credential.user.isTwoFactorEnabled,
            isTwoFactorEnabled: credential.user.isTwoFactorEnabled,
        };
    }

    /**
     * List all biometric credentials for a user
     */
    async listCredentials(userId: number): Promise<BiometricCredentialSummary[]> {
        const credentials = await this.prisma.userBiometricCredential.findMany({
            where: { userId },
            orderBy: { createdAt: 'desc' },
        });

        return credentials.map(cred => ({
            id: cred.id,
            deviceName: cred.deviceName,
            createdAt: cred.createdAt,
            lastUsedAt: cred.lastUsedAt,
        }));
    }

    /**
     * Revoke a biometric credential
     */
    async revokeCredential(userId: number, credentialId: string): Promise<void> {
        const credential = await this.prisma.userBiometricCredential.findUnique({
            where: { id: credentialId },
        });

        if (!credential) {
            throw new HttpException('Credential not found', HttpStatus.NOT_FOUND);
        }

        if (credential.userId !== userId) {
            throw new HttpException('Cannot revoke credential belonging to another user', HttpStatus.FORBIDDEN);
        }

        await this.prisma.userBiometricCredential.delete({
            where: { id: credentialId },
        });

        this.logger.log(`Revoked biometric credential ${credentialId} for user ${userId}`);
    }

    /**
     * Check if user has any biometric credentials registered
     */
    async hasCredentials(userId: number): Promise<boolean> {
        const count = await this.prisma.userBiometricCredential.count({
            where: { userId },
        });
        return count > 0;
    }

    /**
     * Verify biometric for transaction authorization
     * Re-uses authentication flow but with transaction context
     */
    async generateTransactionVerificationOptions(userId: number): Promise<BiometricAuthenticationOptions> {
        const credentials = await this.prisma.userBiometricCredential.findMany({
            where: { userId },
        });

        if (credentials.length === 0) {
            throw new HttpException('No biometric credentials registered', HttpStatus.BAD_REQUEST);
        }

        const allowCredentials: PublicKeyCredentialDescriptorJSON[] = credentials.map(cred => ({
            id: cred.id,
            type: 'public-key',
            transports: cred.transports as AuthenticatorTransportFuture[],
        }));

        const options = await generateAuthenticationOptions({
            rpID: RP_ID,
            allowCredentials,
            userVerification: 'required',
            timeout: 60000,
        });

        // Store challenge with transaction context
        const challengeKey = `txn:${userId}`;
        this.challenges.set(challengeKey, options.challenge);
        setTimeout(() => this.challenges.delete(challengeKey), this.CHALLENGE_TTL_MS);

        return options as BiometricAuthenticationOptions;
    }

    /**
     * Verify biometric for transaction authorization
     */
    async verifyTransactionAuthorization(
        userId: number,
        response: AuthenticationResponseJSON,
    ): Promise<boolean> {
        const credential = await this.prisma.userBiometricCredential.findUnique({
            where: { id: response.id },
        });

        if (!credential || credential.userId !== userId) {
            throw new HttpException('Invalid biometric credential', HttpStatus.UNAUTHORIZED);
        }

        const challengeKey = `txn:${userId}`;
        const expectedChallenge = this.challenges.get(challengeKey);

        if (!expectedChallenge) {
            throw new HttpException('Transaction verification challenge expired', HttpStatus.BAD_REQUEST);
        }

        this.challenges.delete(challengeKey);

        try {
            const verification = await verifyAuthenticationResponse({
                response,
                expectedChallenge,
                expectedOrigin: RP_ORIGIN,
                expectedRPID: RP_ID,
                credential: {
                    id: credential.id,
                    publicKey: new Uint8Array(Buffer.from(credential.publicKey, 'base64')),
                    counter: credential.counter,
                    transports: credential.transports as AuthenticatorTransportFuture[],
                },
                requireUserVerification: true,
            });

            if (verification.verified) {
                // Update counter
                await this.prisma.userBiometricCredential.update({
                    where: { id: credential.id },
                    data: {
                        counter: verification.authenticationInfo.newCounter,
                        lastUsedAt: new Date(),
                    },
                });

                this.logger.log(`Transaction verified via biometrics for user ${userId}`);
                return true;
            }

            return false;
        } catch (error: any) {
            this.logger.error(`Transaction biometric verification failed: ${error.message}`);
            return false;
        }
    }
}
