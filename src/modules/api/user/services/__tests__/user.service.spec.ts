
import { Test, TestingModule } from '@nestjs/testing';

// Break circular dependency: auth/services → @/modules/api/user → auth/index → auth/controllers → @User()
jest.mock("@/modules/api/user", () => {
    class AccountDeletedException extends Error { constructor() { super("Account deleted"); } }
    class UserNotFoundException extends Error { constructor() { super("User not found"); } }
    class DuplicateUserException extends Error { constructor() { super("Duplicate user"); } }
    class IncorrectPasswordException extends Error { constructor() { super("Incorrect password"); } }
    return {
        User: () => () => {},
        ClientData: () => () => {},
        UserModule: class { readonly __stub = true },
        AccountDeletedException,
        UserNotFoundException,
        DuplicateUserException,
        IncorrectPasswordException,
        __esModule: true,
    };
});

import { UserService } from '../index';
import { PrismaService } from '@/modules/core/prisma/services';
import { AuthService } from '@/modules/api/auth/services';
import { EmailService } from '@/modules/core/email/services';
import { UploadFactory } from '@/modules/core/upload/services';
import { QuidaxCacheService } from '@/modules/core/redisCache/services/quidax-cache.service';
import { TierService } from '@/modules/api/auth/services/tier.service';
import { RedisCacheService } from '@/modules/core/redisCache/services/redis-cache.service';
import { LedgerService } from '@/modules/api/trade/services/ledger/ledger.service';
import { RateService } from '@/modules/api/trade/services/rate.service';
import { UserType, DocumentVerificationStatus } from '@prisma/client';
import { TradingInjectionToken } from '@/modules/factory/trading/types';

describe('UserService', () => {
    let service: UserService;

    const mockPrismaService = {
        user: {
            findUnique: jest.fn(),
            findFirst: jest.fn(),
        },
        assetWallet: {
            findFirst: jest.fn(),
        }
    };

    const mockRedisCacheService = {
        get: jest.fn(),
        set: jest.fn(),
        del: jest.fn(),
    };

    const mockTierService = {
        getTierInfo: jest.fn(),
        getWithdrawalLimit: jest.fn().mockReturnValue(1000),
    };

    const mockUploadFactory = {
        build: jest.fn().mockReturnValue({}),
    };

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                UserService,
                { provide: PrismaService, useValue: mockPrismaService },
                { provide: AuthService, useValue: {} },
                { provide: EmailService, useValue: {} },
                { provide: UploadFactory, useValue: mockUploadFactory },
                { provide: QuidaxCacheService, useValue: {} },
                { provide: TierService, useValue: mockTierService },
                { provide: TradingInjectionToken.LIVECOINWATCH, useValue: {} },
                { provide: RedisCacheService, useValue: mockRedisCacheService },
                { provide: LedgerService, useValue: {} },
                { provide: RateService, useValue: {} },
            ],
        }).compile();

        service = module.get<UserService>(UserService);
    });

    it('should be defined', () => {
        expect(service).toBeDefined();
    });

    describe('getProfile - Business KYC Logic', () => {
        const baseUser = {
            id: 1,
            email: 'test@business.com',
            userType: UserType.BUSINESS,
            firstName: 'Business',
            lastName: 'User',
            // Default verification status
            isEmailVerified: true,
            isPhoneVerified: true,
            businessRecordCompleted: false,
            businessDocumentsUploaded: false,
            businessDocumentVerificationStatus: null,
            isDocumentVerified: false,
        };

        const mockTierInfo = {
            tier: 0,
            withdrawalLimit: 1000,
            canTransact: true,
            nextTierRequirements: [],
        };

        beforeEach(() => {
            // Clear mocks
            jest.clearAllMocks();
            // Default mocks
            mockRedisCacheService.get.mockResolvedValue(null); // Cache miss
            mockTierService.getTierInfo.mockResolvedValue(mockTierInfo);
            mockPrismaService.assetWallet.findFirst.mockResolvedValue({ balance: 0 });
        });

        it('should return BUSINESS_RECORD requirement if business record is not completed', async () => {
            mockPrismaService.user.findUnique.mockResolvedValue({
                ...baseUser,
                businessRecordCompleted: false,
            });

            const result = await service.getProfile(baseUser as any);

            expect(result.data.verificationRequirements).toBeDefined();
            expect(result.data.verificationRequirements.nextStep).toBe('BUSINESS_RECORD');
        });

        it('should return BUSINESS_DOCUMENT_UPLOAD if record complete but docs not uploaded', async () => {
            mockPrismaService.user.findUnique.mockResolvedValue({
                ...baseUser,
                businessRecordCompleted: true,
                businessDocumentsUploaded: false,
            });

            const result = await service.getProfile(baseUser as any);

            expect(result.data.verificationRequirements.nextStep).toBe('BUSINESS_DOCUMENT_UPLOAD');
        });

        it('should return WAIT_FOR_VERIFICATION if docs uploaded and status is PENDING', async () => {
            mockPrismaService.user.findUnique.mockResolvedValue({
                ...baseUser,
                businessRecordCompleted: true,
                businessDocumentsUploaded: true,
                businessDocumentVerificationStatus: DocumentVerificationStatus.PENDING,
            });

            const result = await service.getProfile(baseUser as any);

            expect(result.data.verificationRequirements.nextStep).toBe('WAIT_FOR_VERIFICATION');
        });

        it('should return BUSINESS_DOCUMENT_UPLOAD if docs were DECLINED', async () => {
            mockPrismaService.user.findUnique.mockResolvedValue({
                ...baseUser,
                businessRecordCompleted: true,
                businessDocumentsUploaded: true,
                businessDocumentVerificationStatus: DocumentVerificationStatus.DECLINED,
            });

            const result = await service.getProfile(baseUser as any);

            expect(result.data.verificationRequirements.nextStep).toBe('BUSINESS_DOCUMENT_UPLOAD');
            expect(result.data.verificationRequirements.details).toBe('Previous documents were declined');
        });

        it('should NOT return business requirements for INDIVIDUAL user', async () => {
            mockPrismaService.user.findUnique.mockResolvedValue({
                ...baseUser,
                userType: UserType.INDIVIDUAL,
                isBvnVerified: false,
                isNinVerified: false,
            });

            const result = await service.getProfile({ ...baseUser, userType: UserType.INDIVIDUAL } as any);

            // For individual, it should fall back to standard flow (e.g. GOVERNMENT_ID)
            expect(result.data.verificationRequirements.nextStep).not.toBe('BUSINESS_RECORD');
            expect(result.data.verificationRequirements.nextStep).toBe('GOVERNMENT_ID');
        });
    });

    describe('getIntercomHash', () => {
        const mockUser = { id: 42, email: 'test@example.com' } as any;

        afterEach(() => {
            delete process.env.INTERCOM_SECRET_KEY;
        });

        it('should return error response when INTERCOM_SECRET_KEY is not configured', async () => {
            delete process.env.INTERCOM_SECRET_KEY;

            const result = await service.getIntercomHash(mockUser);

            expect(result.success).toBe(false);
            expect(result.message).toContain('not configured');
        });

        it('should return a valid HMAC-SHA256 hash when secret is configured', async () => {
            process.env.INTERCOM_SECRET_KEY = 'test-secret-key';

            const result = await service.getIntercomHash(mockUser);

            expect(result.success).toBe(true);
            expect(result.data.userHash).toBeDefined();
            expect(result.data.userHash).toHaveLength(64); // SHA-256 hex = 64 chars
        });

        it('should produce deterministic hash for same user and secret', async () => {
            process.env.INTERCOM_SECRET_KEY = 'test-secret-key';

            const result1 = await service.getIntercomHash(mockUser);
            const result2 = await service.getIntercomHash(mockUser);

            expect(result1.data.userHash).toBe(result2.data.userHash);
        });

        it('should produce different hashes for different users', async () => {
            process.env.INTERCOM_SECRET_KEY = 'test-secret-key';

            const result1 = await service.getIntercomHash(mockUser);
            const result2 = await service.getIntercomHash({ id: 99 } as any);

            expect(result1.data.userHash).not.toBe(result2.data.userHash);
        });
    });
});
