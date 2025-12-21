import { Injectable, HttpStatus, Logger } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { PrismaService } from "@/modules/core/prisma/services";
import { User } from "@prisma/client";
import { ApiResponse, buildResponse } from "@/utils/api-response-util";
import { AuthGenericException } from "../errors";
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

// Configuration - should match your domain
const RP_NAME = "Resolve"; // Your app name
const RP_ID = process.env.WEBAUTHN_RP_ID || "localhost"; // Domain without protocol
const ORIGIN = process.env.WEBAUTHN_ORIGIN || "http://localhost:3000";

// Store challenges temporarily (in production, use Redis)
const challengeStore = new Map<string, string>();

@Injectable()
export class WebAuthnService {
    private readonly logger = new Logger(WebAuthnService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly jwtService: JwtService
    ) {}

    /**
     * Generate registration options for a new passkey
     */
    async generateRegistrationOptions(user: User): Promise<ApiResponse> {
        // Get existing credentials to exclude (prevent re-registration)
        const existingCredentials = await this.prisma.webAuthnCredential.findMany({
            where: { userId: user.id },
            select: { credentialId: true, transports: true },
        });

        const excludeCredentials = existingCredentials.map((cred) => ({
            id: cred.credentialId,
            transports: cred.transports 
                ? (JSON.parse(cred.transports) as AuthenticatorTransportFuture[])
                : undefined,
        }));

        const options = await generateRegistrationOptions({
            rpName: RP_NAME,
            rpID: RP_ID,
            userName: user.email,
            userDisplayName: `${user.firstName || ""} ${user.lastName || ""}`.trim() || user.email,
            userID: new TextEncoder().encode(user.id.toString()),
            attestationType: "none", // Don't require attestation for simplicity
            excludeCredentials,
            authenticatorSelection: {
                residentKey: "preferred",
                userVerification: "preferred", // Request biometric verification
                authenticatorAttachment: "platform", // Prefer built-in authenticators (Face ID, Touch ID)
            },
            timeout: 60000, // 1 minute
        });

        // Store challenge for verification
        challengeStore.set(`reg_${user.id}`, options.challenge);

        // Clear challenge after 2 minutes
        setTimeout(() => {
            challengeStore.delete(`reg_${user.id}`);
        }, 120000);

        return buildResponse({
            message: "Registration options generated",
            data: options,
        });
    }

    /**
     * Verify registration response and store credential
     */
    async verifyRegistration(
        user: User,
        response: RegistrationResponseJSON,
        deviceName?: string
    ): Promise<ApiResponse> {
        const expectedChallenge = challengeStore.get(`reg_${user.id}`);

        if (!expectedChallenge) {
            throw new AuthGenericException(
                "Registration challenge expired. Please try again.",
                HttpStatus.BAD_REQUEST
            );
        }

        let verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>;

        try {
            verification = await verifyRegistrationResponse({
                response,
                expectedChallenge,
                expectedOrigin: ORIGIN,
                expectedRPID: RP_ID,
            });
        } catch (error) {
            this.logger.error("WebAuthn registration verification failed", error);
            throw new AuthGenericException(
                "Failed to verify registration. Please try again.",
                HttpStatus.BAD_REQUEST
            );
        }

        if (!verification.verified || !verification.registrationInfo) {
            throw new AuthGenericException(
                "Registration verification failed",
                HttpStatus.BAD_REQUEST
            );
        }

        const { credential, credentialDeviceType } = verification.registrationInfo;

        // Store the credential
        await this.prisma.webAuthnCredential.create({
            data: {
                userId: user.id,
                credentialId: credential.id,
                publicKey: Buffer.from(credential.publicKey).toString("base64url"),
                counter: BigInt(credential.counter),
                deviceType: credentialDeviceType,
                deviceName: deviceName || this.getDefaultDeviceName(credentialDeviceType),
                transports: response.response.transports 
                    ? JSON.stringify(response.response.transports)
                    : null,
            },
        });

        // Update user's biometric verification status
        await this.prisma.user.update({
            where: { id: user.id },
            data: {
                isBiometricVerified: true,
                biometricVerifiedAt: new Date(),
            },
        });

        // Clear the challenge
        challengeStore.delete(`reg_${user.id}`);

        return buildResponse({
            message: "Passkey registered successfully",
            data: {
                deviceName: deviceName || this.getDefaultDeviceName(credentialDeviceType),
            },
        });
    }

    /**
     * Generate authentication options for verifying with passkey
     */
    async generateAuthenticationOptions(user: User): Promise<ApiResponse> {
        // Get user's registered credentials
        const credentials = await this.prisma.webAuthnCredential.findMany({
            where: { userId: user.id },
            select: { credentialId: true, transports: true },
        });

        if (credentials.length === 0) {
            throw new AuthGenericException(
                "No passkeys registered. Please set up a passkey first.",
                HttpStatus.BAD_REQUEST
            );
        }

        const allowCredentials = credentials.map((cred) => ({
            id: cred.credentialId,
            transports: cred.transports
                ? (JSON.parse(cred.transports) as AuthenticatorTransportFuture[])
                : undefined,
        }));

        const options = await generateAuthenticationOptions({
            rpID: RP_ID,
            userVerification: "preferred",
            allowCredentials,
            timeout: 60000,
        });

        // Store challenge for verification
        challengeStore.set(`auth_${user.id}`, options.challenge);

        // Clear challenge after 2 minutes
        setTimeout(() => {
            challengeStore.delete(`auth_${user.id}`);
        }, 120000);

        return buildResponse({
            message: "Authentication options generated",
            data: options,
        });
    }

    /**
     * Verify authentication response
     * Returns a JWT token for transaction verification
     */
    async verifyAuthentication(
        user: User,
        response: AuthenticationResponseJSON
    ): Promise<ApiResponse> {
        const expectedChallenge = challengeStore.get(`auth_${user.id}`);

        if (!expectedChallenge) {
            throw new AuthGenericException(
                "Authentication challenge expired. Please try again.",
                HttpStatus.BAD_REQUEST
            );
        }

        // Find the credential
        const credential = await this.prisma.webAuthnCredential.findUnique({
            where: { credentialId: response.id },
        });

        if (!credential || credential.userId !== user.id) {
            throw new AuthGenericException(
                "Credential not found",
                HttpStatus.BAD_REQUEST
            );
        }

        let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;

        try {
            verification = await verifyAuthenticationResponse({
                response,
                expectedChallenge,
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
            });
        } catch (error) {
            this.logger.error("WebAuthn authentication verification failed", error);
            throw new AuthGenericException(
                "Failed to verify authentication. Please try again.",
                HttpStatus.BAD_REQUEST
            );
        }

        if (!verification.verified) {
            throw new AuthGenericException(
                "Authentication verification failed",
                HttpStatus.BAD_REQUEST
            );
        }

        // Update counter to prevent replay attacks
        await this.prisma.webAuthnCredential.update({
            where: { id: credential.id },
            data: {
                counter: BigInt(verification.authenticationInfo.newCounter),
                lastUsedAt: new Date(),
            },
        });

        // Clear the challenge
        challengeStore.delete(`auth_${user.id}`);

        // Generate a verification token (valid for 5 minutes)
        // Uses type "transaction_verification" to be compatible with TwoFactorGuard
        const jwtSecret = process.env.JWT_SECRET || "secret";
        const verificationToken = await this.jwtService.signAsync(
            {
                userId: user.id,
                type: "transaction_verification",
                method: "biometric",
                credentialId: credential.id,
            },
            { secret: jwtSecret, expiresIn: "5m" }
        );

        return buildResponse({
            message: "Biometric verification successful",
            data: {
                verificationToken,
                expiresIn: 300, // 5 minutes in seconds
            },
        });
    }

    /**
     * Get all passkeys for a user
     */
    async getPasskeys(user: User): Promise<ApiResponse> {
        const passkeys = await this.prisma.webAuthnCredential.findMany({
            where: { userId: user.id },
            select: {
                id: true,
                deviceName: true,
                deviceType: true,
                createdAt: true,
                lastUsedAt: true,
            },
            orderBy: { createdAt: "desc" },
        });

        return buildResponse({
            message: "Passkeys retrieved",
            data: passkeys,
        });
    }

    /**
     * Update passkey name
     */
    async updatePasskeyName(
        user: User,
        credentialId: string,
        deviceName: string
    ): Promise<ApiResponse> {
        const credential = await this.prisma.webAuthnCredential.findFirst({
            where: { id: credentialId, userId: user.id },
        });

        if (!credential) {
            throw new AuthGenericException(
                "Passkey not found",
                HttpStatus.NOT_FOUND
            );
        }

        await this.prisma.webAuthnCredential.update({
            where: { id: credentialId },
            data: { deviceName },
        });

        return buildResponse({
            message: "Passkey name updated",
        });
    }

    /**
     * Delete a passkey
     */
    async deletePasskey(user: User, credentialId: string): Promise<ApiResponse> {
        const credential = await this.prisma.webAuthnCredential.findFirst({
            where: { id: credentialId, userId: user.id },
        });

        if (!credential) {
            throw new AuthGenericException(
                "Passkey not found",
                HttpStatus.NOT_FOUND
            );
        }

        await this.prisma.webAuthnCredential.delete({
            where: { id: credentialId },
        });

        // Check if user has any remaining passkeys
        const remainingPasskeys = await this.prisma.webAuthnCredential.count({
            where: { userId: user.id },
        });

        // If no passkeys left, update biometric status
        if (remainingPasskeys === 0) {
            await this.prisma.user.update({
                where: { id: user.id },
                data: {
                    isBiometricVerified: false,
                    biometricVerifiedAt: null,
                },
            });
        }

        return buildResponse({
            message: "Passkey deleted",
        });
    }

    /**
     * Check if user has WebAuthn credentials
     */
    async hasPasskeys(userId: number): Promise<boolean> {
        const count = await this.prisma.webAuthnCredential.count({
            where: { userId },
        });
        return count > 0;
    }

    /**
     * Get default device name based on device type
     */
    private getDefaultDeviceName(deviceType: string): string {
        switch (deviceType) {
            case "singleDevice":
                return "Security Key";
            case "multiDevice":
                return "Passkey";
            default:
                return "Passkey";
        }
    }
}
