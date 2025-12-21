import { Injectable, Logger, BadRequestException, NotFoundException } from "@nestjs/common";
import { PrismaService } from "@/modules/core/prisma/services";
import {
    generateRegistrationOptions,
    verifyRegistrationResponse,
    generateAuthenticationOptions,
    verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import type {
    RegistrationResponseJSON,
    AuthenticationResponseJSON,
    AuthenticatorTransportFuture,
} from "@simplewebauthn/types";

// Configuration - should match frontend origin
const RP_NAME = process.env.WEBAUTHN_RP_NAME || "Flipxer";
const RP_ID = process.env.WEBAUTHN_RP_ID || "localhost";
const ORIGIN = process.env.WEBAUTHN_ORIGIN || "http://localhost:3000";

// Store challenges temporarily (in production, use Redis)
const challengeStore = new Map<string, { challenge: string; expiresAt: Date }>();

@Injectable()
export class BiometricService {
    private readonly logger = new Logger(BiometricService.name);

    constructor(private prisma: PrismaService) {}

    /**
     * Generate registration options for device biometric
     */
    async generateRegistrationOptions(userId: number, sessionId?: string) {
        const user = await this.prisma.user.findUnique({
            where: { id: userId },
            select: { id: true, email: true, firstName: true, lastName: true },
        });

        if (!user) {
            throw new NotFoundException("User not found");
        }

        // Get existing credentials to exclude
        const existingCredentials = await this.prisma.biometricCredential.findMany({
            where: { userId },
            select: { credentialId: true, transports: true },
        });

        const options = await generateRegistrationOptions({
            rpName: RP_NAME,
            rpID: RP_ID,
            userID: new TextEncoder().encode(user.id.toString()),
            userName: user.email,
            userDisplayName: `${user.firstName || ""} ${user.lastName || ""}`.trim() || user.email,
            attestationType: "none",
            excludeCredentials: existingCredentials.map((cred) => ({
                id: cred.credentialId,
                transports: cred.transports
                    ? (JSON.parse(cred.transports) as AuthenticatorTransportFuture[])
                    : undefined,
            })),
            authenticatorSelection: {
                residentKey: "discouraged", // Device-bound, not discoverable
                userVerification: "required", // Must use biometric
                authenticatorAttachment: "platform", // Built-in authenticator only
            },
            timeout: 60000,
        });

        // Store challenge for verification
        const challengeKey = `reg_${userId}_${Date.now()}`;
        challengeStore.set(challengeKey, {
            challenge: options.challenge,
            expiresAt: new Date(Date.now() + 60000),
        });

        return {
            success: true,
            message: "Registration options generated",
            data: {
                options,
                challengeKey,
            },
        };
    }

    /**
     * Verify registration response and store credential
     */
    async verifyRegistration(
        userId: number,
        challengeKey: string,
        response: RegistrationResponseJSON,
        deviceName?: string,
        sessionId?: string
    ) {
        const stored = challengeStore.get(challengeKey);
        if (!stored || stored.expiresAt < new Date()) {
            challengeStore.delete(challengeKey);
            throw new BadRequestException("Challenge expired or invalid");
        }

        try {
            const verification = await verifyRegistrationResponse({
                response,
                expectedChallenge: stored.challenge,
                expectedOrigin: ORIGIN,
                expectedRPID: RP_ID,
                requireUserVerification: true,
            });

            if (!verification.verified || !verification.registrationInfo) {
                throw new BadRequestException("Registration verification failed");
            }

            const { credential, credentialDeviceType, aaguid } = verification.registrationInfo;

            // Store credential in database
            await this.prisma.biometricCredential.create({
                data: {
                    userId,
                    sessionId,
                    credentialId: credential.id,
                    publicKey: Buffer.from(credential.publicKey).toString("base64url"),
                    counter: BigInt(credential.counter),
                    deviceType: credentialDeviceType,
                    deviceName: deviceName || this.getDefaultDeviceName(),
                    transports: response.response.transports
                        ? JSON.stringify(response.response.transports)
                        : null,
                    aaguid,
                },
            });

            // Update user's security methods to include biometric
            await this.updateUserBiometricStatus(userId);

            challengeStore.delete(challengeKey);

            return {
                success: true,
                message: "Biometric registered successfully",
                data: { verified: true },
            };
        } catch (error) {
            this.logger.error("Biometric registration failed", error);
            challengeStore.delete(challengeKey);
            throw new BadRequestException(
                error instanceof Error ? error.message : "Registration verification failed"
            );
        }
    }

    /**
     * Generate authentication options for biometric verification
     */
    async generateAuthenticationOptions(userId: number) {
        const credentials = await this.prisma.biometricCredential.findMany({
            where: { userId },
            select: { credentialId: true, transports: true },
        });

        if (credentials.length === 0) {
            throw new BadRequestException(
                "No biometric credentials registered. Please set up biometric first."
            );
        }

        const options = await generateAuthenticationOptions({
            rpID: RP_ID,
            allowCredentials: credentials.map((cred) => ({
                id: cred.credentialId,
                transports: cred.transports
                    ? (JSON.parse(cred.transports) as AuthenticatorTransportFuture[])
                    : undefined,
            })),
            userVerification: "required",
            timeout: 60000,
        });

        // Store challenge
        const challengeKey = `auth_${userId}_${Date.now()}`;
        challengeStore.set(challengeKey, {
            challenge: options.challenge,
            expiresAt: new Date(Date.now() + 60000),
        });

        return {
            success: true,
            message: "Authentication options generated",
            data: {
                options,
                challengeKey,
            },
        };
    }

    /**
     * Verify authentication response
     */
    async verifyAuthentication(
        userId: number,
        challengeKey: string,
        response: AuthenticationResponseJSON
    ) {
        const stored = challengeStore.get(challengeKey);
        if (!stored || stored.expiresAt < new Date()) {
            challengeStore.delete(challengeKey);
            throw new BadRequestException("Challenge expired or invalid");
        }

        const credential = await this.prisma.biometricCredential.findUnique({
            where: { credentialId: response.id },
        });

        if (!credential || credential.userId !== userId) {
            throw new BadRequestException("Credential not found or unauthorized");
        }

        try {
            const verification = await verifyAuthenticationResponse({
                response,
                expectedChallenge: stored.challenge,
                expectedOrigin: ORIGIN,
                expectedRPID: RP_ID,
                credential: {
                    id: credential.credentialId,
                    publicKey: Buffer.from(credential.publicKey, "base64url"),
                    counter: Number(credential.counter),
                    transports: credential.transports
                        ? (JSON.parse(credential.transports) as AuthenticatorTransportFuture[])
                        : undefined,
                },
                requireUserVerification: true,
            });

            if (!verification.verified) {
                throw new BadRequestException("Authentication verification failed");
            }

            // Update counter and last used timestamp
            await this.prisma.biometricCredential.update({
                where: { id: credential.id },
                data: {
                    counter: BigInt(verification.authenticationInfo.newCounter),
                    lastUsedAt: new Date(),
                },
            });

            challengeStore.delete(challengeKey);

            // Generate a verification token for the transaction
            const verificationToken = this.generateVerificationToken();

            return {
                success: true,
                message: "Biometric verification successful",
                data: {
                    verified: true,
                    verificationToken,
                },
            };
        } catch (error) {
            this.logger.error("Biometric authentication failed", error);
            challengeStore.delete(challengeKey);
            throw new BadRequestException(
                error instanceof Error ? error.message : "Authentication verification failed"
            );
        }
    }

    /**
     * Get user's registered biometric credentials
     */
    async getUserCredentials(userId: number) {
        const credentials = await this.prisma.biometricCredential.findMany({
            where: { userId },
            select: {
                id: true,
                deviceName: true,
                deviceType: true,
                createdAt: true,
                lastUsedAt: true,
            },
            orderBy: { createdAt: "desc" },
        });

        return {
            success: true,
            message: "Credentials retrieved",
            data: {
                credentials,
                count: credentials.length,
            },
        };
    }

    /**
     * Delete a biometric credential
     */
    async deleteCredential(userId: number, credentialId: string) {
        const credential = await this.prisma.biometricCredential.findFirst({
            where: { id: credentialId, userId },
        });

        if (!credential) {
            throw new NotFoundException("Credential not found");
        }

        await this.prisma.biometricCredential.delete({
            where: { id: credentialId },
        });

        // Update user's biometric status
        await this.updateUserBiometricStatus(userId);

        return {
            success: true,
            message: "Biometric credential removed",
        };
    }

    /**
     * Check if user has biometric available
     */
    async hasBiometricAvailable(userId: number) {
        const count = await this.prisma.biometricCredential.count({
            where: { userId },
        });

        return {
            success: true,
            data: {
                hasBiometric: count > 0,
                deviceCount: count,
            },
        };
    }

    /**
     * Rename a credential
     */
    async renameCredential(userId: number, credentialId: string, newName: string) {
        const credential = await this.prisma.biometricCredential.findFirst({
            where: { id: credentialId, userId },
        });

        if (!credential) {
            throw new NotFoundException("Credential not found");
        }

        await this.prisma.biometricCredential.update({
            where: { id: credentialId },
            data: { deviceName: newName },
        });

        return {
            success: true,
            message: "Credential renamed",
        };
    }

    /**
     * Update user's security methods to reflect biometric status
     */
    private async updateUserBiometricStatus(userId: number) {
        const count = await this.prisma.biometricCredential.count({
            where: { userId },
        });

        const user = await this.prisma.user.findUnique({
            where: { id: userId },
            select: { securityMethods: true },
        });

        const currentMethods = (user?.securityMethods as Record<string, unknown>) || {};
        const updatedMethods = {
            ...currentMethods,
            biometric: {
                enabled: count > 0,
                deviceCount: count,
            },
        };

        await this.prisma.user.update({
            where: { id: userId },
            data: {
                securityMethods: updatedMethods,
                biometricVerifiedAt: count > 0 ? new Date() : null,
            },
        });
    }

    /**
     * Generate a default device name based on common patterns
     */
    private getDefaultDeviceName(): string {
        return `Device ${new Date().toLocaleDateString()}`;
    }

    /**
     * Generate a temporary verification token
     */
    private generateVerificationToken(): string {
        const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
        let token = "";
        for (let i = 0; i < 32; i++) {
            token += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return token;
    }
}
