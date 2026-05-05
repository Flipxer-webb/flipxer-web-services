
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
import { IndividualKycStageService } from '@/modules/api/auth/services/individual-kyc-stage.service';
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
            update: jest.fn(),
            updateMany: jest.fn(),
        },
        assetWallet: {
            findFirst: jest.fn(),
        },
        kycVerification: {
            findFirst: jest.fn(),
        },
        deviceToken: {
            upsert: jest.fn(),
            deleteMany: jest.fn(),
            findMany: jest.fn(),
        },
    };

    const mockRedisCacheService = {
        get: jest.fn(),
        set: jest.fn(),
        del: jest.fn(),
    };

    const mockIndividualKycStageService = {
        ensureCurrentIndividualStageAttempts: jest.fn(),
    };

    const mockTierService = {
        getTierInfo: jest.fn(),
        getWithdrawalLimit: jest.fn().mockReturnValue(1000),
    };

    const mockUploadFactory = {
        build: jest.fn().mockReturnValue({}),
    };

    const createStageAttempt = (stage: string, status: string, overrides: Record<string, unknown> = {}) => {
        const defaultAttemptIds: Record<string, number> = {
            GOVERNMENT_ID: 60,
            IDENTITY_DOCUMENT: 61,
            ADDRESS: 62,
            INCOME: 63,
        };

        return {
            id: defaultAttemptIds[stage] ?? 99,
            journeyType: 'INDIVIDUAL',
            stage,
            method: null,
            status,
            providerStatus: null,
            reasonCode: null,
            reasonMessage: null,
            submittedAt: new Date('2026-04-20T10:00:00.000Z'),
            reviewedAt: status === 'APPROVED' || status === 'REJECTED'
                ? new Date('2026-04-20T12:00:00.000Z')
                : null,
            isCurrent: true,
            ...overrides,
        };
    };

    beforeEach(async () => {
        jest.clearAllMocks();
        mockIndividualKycStageService.ensureCurrentIndividualStageAttempts.mockResolvedValue(false);

        mockPrismaService.deviceToken.upsert.mockResolvedValue({
            userId: 26,
            token: 'token-abc',
            deviceName: 'Test Device',
            platform: 'web',
            createdAt: new Date(),
            updatedAt: new Date(),
        });
        mockPrismaService.user.update.mockResolvedValue({});
        mockPrismaService.deviceToken.deleteMany.mockResolvedValue({ count: 1 });
        mockRedisCacheService.del.mockResolvedValue(1);
        mockIndividualKycStageService.ensureCurrentIndividualStageAttempts.mockResolvedValue(false);

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                UserService,
                { provide: PrismaService, useValue: mockPrismaService },
                { provide: AuthService, useValue: {} },
                { provide: IndividualKycStageService, useValue: mockIndividualKycStageService },
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
            isPasswordCreated: true,
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
            expect(result.data).toMatchObject({
                emailVerified: true,
                phoneVerified: true,
                passwordCreated: true,
                documentVerified: false,
                isDocumentVerified: false,
            });
            expect(result.data).not.toHaveProperty('isEmailVerified');
            expect(result.data).not.toHaveProperty('isPhoneVerified');
            expect(result.data).not.toHaveProperty('isPasswordCreated');
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

        it('should require a current business attempt before showing WAIT_FOR_VERIFICATION', async () => {
            mockPrismaService.user.findUnique.mockResolvedValue({
                ...baseUser,
                businessRecordCompleted: true,
                businessDocumentsUploaded: true,
                businessDocumentVerificationStatus: DocumentVerificationStatus.PENDING,
            });

            const result = await service.getProfile(baseUser as any);

            expect(result.data.verificationRequirements.nextStep).toBe('BUSINESS_DOCUMENT_UPLOAD');
            expect(result.data.businessVerification).toEqual(expect.objectContaining({
                status: 'NOT_STARTED',
                displayState: 'READY',
            }));
        });

        it('should return WAIT_FOR_VERIFICATION when the current business attempt is pending even if legacy status is empty', async () => {
            mockPrismaService.user.findUnique.mockResolvedValue({
                ...baseUser,
                businessRecordCompleted: true,
                businessDocumentsUploaded: true,
                businessDocumentVerificationStatus: null,
                kycStageAttempts: [
                    {
                        id: 501,
                        journeyType: 'BUSINESS',
                        stage: 'BUSINESS_DOCUMENT',
                        status: 'PENDING_REVIEW',
                        providerStatus: 'INCONCLUSIVE',
                        reasonCode: null,
                        reasonMessage: null,
                        submittedAt: new Date('2026-05-02T10:00:00.000Z'),
                        reviewedAt: null,
                        isCurrent: true,
                    },
                ],
            });

            const result = await service.getProfile(baseUser as any);

            expect(result.data.verificationRequirements.nextStep).toBe('WAIT_FOR_VERIFICATION');
            expect(result.data.businessVerification).toEqual(expect.objectContaining({
                status: 'PENDING_REVIEW',
                currentAttemptId: 501,
                providerStatus: 'INCONCLUSIVE',
            }));
        });

        it('should return BUSINESS_DOCUMENT_UPLOAD if record is complete but no business documents are currently submitted', async () => {
            mockPrismaService.user.findUnique.mockResolvedValue({
                ...baseUser,
                businessRecordCompleted: true,
                businessDocumentsUploaded: false,
                businessDocumentVerificationStatus: null,
            });

            const result = await service.getProfile(baseUser as any);

            expect(result.data.verificationRequirements.nextStep).toBe('BUSINESS_DOCUMENT_UPLOAD');
            expect(result.data.verificationRequirements.details).toBeNull();
            expect(result.data.businessVerification).toEqual(expect.objectContaining({
                status: 'NOT_STARTED',
                displayState: 'READY',
            }));
        });

        it('should return BUSINESS_DOCUMENT_UPLOAD when the current business attempt is rejected', async () => {
            mockPrismaService.user.findUnique.mockResolvedValue({
                ...baseUser,
                businessRecordCompleted: true,
                businessDocumentsUploaded: true,
                businessDocumentVerificationStatus: null,
                kycStageAttempts: [
                    {
                        id: 502,
                        journeyType: 'BUSINESS',
                        stage: 'BUSINESS_DOCUMENT',
                        status: 'REJECTED',
                        providerStatus: 'FAILED',
                        reasonCode: 'BUSINESS_DOC_DECLINED',
                        reasonMessage: 'Resubmit clearer CAC documents',
                        submittedAt: new Date('2026-05-02T10:00:00.000Z'),
                        reviewedAt: new Date('2026-05-02T12:00:00.000Z'),
                        isCurrent: true,
                    },
                ],
            });

            const result = await service.getProfile(baseUser as any);

            expect(result.data.verificationRequirements.nextStep).toBe('BUSINESS_DOCUMENT_UPLOAD');
            expect(result.data.verificationRequirements.details).toBe('Resubmit clearer CAC documents');
            expect(result.data.businessVerification).toEqual(expect.objectContaining({
                status: 'REJECTED',
                displayState: 'NEEDS_RESUBMISSION',
                currentAttemptId: 502,
            }));
        });

        it('should NOT return business requirements for INDIVIDUAL user', async () => {
            mockPrismaService.user.findUnique.mockResolvedValue({
                ...baseUser,
                userType: UserType.INDIVIDUAL,
                bvn: null,
                nin: null,
                kycStageAttempts: [],
            });

            const result = await service.getProfile({ ...baseUser, userType: UserType.INDIVIDUAL } as any);

            expect(result.data).not.toHaveProperty('verificationRequirements');
            expect(result.data.kycJourney.currentStage).toBe('GOVERNMENT_ID');
            expect(result.data.kycJourney.nextAction).toEqual(
                expect.objectContaining({
                    type: 'START',
                    stage: 'GOVERNMENT_ID',
                    route: '/verify-bvn',
                }),
            );
        });

        it('should load profile journey inputs from current stage attempts without legacy verification rows', async () => {
            mockPrismaService.user.findUnique.mockResolvedValue({
                ...baseUser,
                userType: UserType.INDIVIDUAL,
                bvn: null,
                nin: null,
                kycStageAttempts: [],
            });

            await service.getProfile({ ...baseUser, userType: UserType.INDIVIDUAL } as any);

            const profileQuery = mockPrismaService.user.findUnique.mock.calls[0][0];

            expect(profileQuery.select.kycStageAttempts).toEqual(
                expect.objectContaining({
                    where: expect.objectContaining({
                        isCurrent: true,
                    }),
                }),
            );
        });

        it('should return masked government identifiers when present', async () => {
            mockPrismaService.user.findUnique.mockResolvedValue({
                ...baseUser,
                userType: UserType.INDIVIDUAL,
                bvn: '12345678901',
                nin: '10987654321',
                kycStageAttempts: [],
            });

            const result = await service.getProfile({ ...baseUser, userType: UserType.INDIVIDUAL } as any);

            expect(result.data.bvn).toBe('****8901');
            expect(result.data.nin).toBe('****4321');
        });

        it('should return EMAIL_VERIFICATION for INDIVIDUAL user when email is not verified', async () => {
            mockPrismaService.user.findUnique.mockResolvedValue({
                ...baseUser,
                userType: UserType.INDIVIDUAL,
                isEmailVerified: false,
            });

            const result = await service.getProfile({ ...baseUser, userType: UserType.INDIVIDUAL } as any);

            expect(result.data).not.toHaveProperty('verificationRequirements');
            expect(result.data.kycJourney.nextAction).toEqual(
                expect.objectContaining({
                    type: 'START',
                    stage: null,
                    route: '/profile',
                    label: 'Verify Email',
                    message: 'Verify your email to continue KYC.',
                }),
            );
        });

        it('should return WAIT_FOR_VERIFICATION for INDIVIDUAL user when BVN/NIN review is pending', async () => {
            mockPrismaService.user.findUnique.mockResolvedValue({
                ...baseUser,
                userType: UserType.INDIVIDUAL,
                kycStageAttempts: [
                    createStageAttempt('GOVERNMENT_ID', 'PENDING_REVIEW', {
                        method: 'BVN',
                    }),
                ],
            });

            const result = await service.getProfile({ ...baseUser, userType: UserType.INDIVIDUAL } as any);

            expect(result.data).not.toHaveProperty('verificationRequirements');
            expect(result.data.kycJourney.overallStatus).toBe('IN_REVIEW');
            expect(result.data.kycJourney.currentStage).toBe('GOVERNMENT_ID');
            expect(result.data.kycJourney.nextAction).toEqual(
                expect.objectContaining({
                    type: 'WAIT',
                    stage: 'GOVERNMENT_ID',
                }),
            );
        });

        it('should return GOVERNMENT_ID with decline details for INDIVIDUAL user when BVN/NIN was rejected', async () => {
            mockPrismaService.user.findUnique.mockResolvedValue({
                ...baseUser,
                userType: UserType.INDIVIDUAL,
                kycStageAttempts: [
                    createStageAttempt('GOVERNMENT_ID', 'REJECTED', {
                        method: 'BVN',
                        reasonMessage: 'BVN verification was declined',
                    }),
                ],
            });

            const result = await service.getProfile({ ...baseUser, userType: UserType.INDIVIDUAL } as any);

            expect(result.data).not.toHaveProperty('verificationRequirements');
            expect(result.data.kycJourney.overallStatus).toBe('ACTION_REQUIRED');
            expect(result.data.kycJourney.currentStage).toBe('GOVERNMENT_ID');
            expect(result.data.kycJourney.nextAction).toEqual(
                expect.objectContaining({
                    type: 'RESUBMIT',
                    stage: 'GOVERNMENT_ID',
                    route: '/verify-bvn',
                    message: 'BVN verification was declined',
                }),
            );
        });

        it('should return WAIT_FOR_VERIFICATION for INDIVIDUAL user when address is PENDING', async () => {
            mockPrismaService.user.findUnique.mockResolvedValue({
                ...baseUser,
                userType: UserType.INDIVIDUAL,
                isDocumentVerified: false,
                kycStageAttempts: [
                    createStageAttempt('GOVERNMENT_ID', 'APPROVED', {
                        method: 'BVN',
                    }),
                    createStageAttempt('IDENTITY_DOCUMENT', 'APPROVED'),
                    createStageAttempt('ADDRESS', 'PENDING_REVIEW'),
                ],
            });

            const result = await service.getProfile({ ...baseUser, userType: UserType.INDIVIDUAL } as any);

            expect(result.data).not.toHaveProperty('verificationRequirements');
            expect(result.data.kycJourney.overallStatus).toBe('IN_REVIEW');
            expect(result.data.kycJourney.currentStage).toBe('ADDRESS');
            expect(result.data.kycJourney.nextAction.type).toBe('WAIT');
        });

        it('should prefer current KYC stage attempts when building the individual journey', async () => {
            mockPrismaService.user.findUnique.mockResolvedValue({
                ...baseUser,
                userType: UserType.INDIVIDUAL,
                isDocumentVerified: false,
                documentVerificationStatus: null,
                kycStageAttempts: [
                    createStageAttempt('GOVERNMENT_ID', 'APPROVED', {
                        method: 'BVN',
                    }),
                    {
                        id: 77,
                        stage: 'IDENTITY_DOCUMENT',
                        method: 'INTERNATIONAL_PASSPORT',
                        status: 'PENDING_REVIEW',
                        providerStatus: 'INCONCLUSIVE',
                        reasonCode: 'MANUAL_REVIEW',
                        reasonMessage: 'Manual review required',
                        submittedAt: new Date('2026-04-20T10:00:00.000Z'),
                        reviewedAt: null,
                        isCurrent: true,
                    },
                ],
            });

            const result = await service.getProfile({ ...baseUser, userType: UserType.INDIVIDUAL } as any);
            const identityStage = result.data.kycJourney.stages.find((stage: any) => stage.stage === 'IDENTITY_DOCUMENT');

            expect(result.data).not.toHaveProperty('verificationRequirements');
            expect(result.data.kycJourney.currentStage).toBe('IDENTITY_DOCUMENT');
            expect(result.data.kycJourney.nextAction.type).toBe('WAIT');
            expect(identityStage).toEqual(
                expect.objectContaining({
                    displayState: 'UNDER_REVIEW',
                    currentAttemptId: 77,
                    currentMethod: 'INTERNATIONAL_PASSPORT',
                    providerStatus: 'INCONCLUSIVE',
                    reasonCode: 'MANUAL_REVIEW',
                    reasonMessage: 'Manual review required',
                    submittedAt: '2026-04-20T10:00:00.000Z',
                }),
            );
        });

        it('should ignore conflicting legacy document, address, and income flags once current stage attempts exist', async () => {
            mockPrismaService.user.findUnique.mockResolvedValue({
                ...baseUser,
                userType: UserType.INDIVIDUAL,
                isDocumentVerified: false,
                documentVerificationStatus: DocumentVerificationStatus.DECLINED,
                addressVerificationStatus: DocumentVerificationStatus.DECLINED,
                incomeVerificationStatus: DocumentVerificationStatus.VERIFIED,
                kycStageAttempts: [
                    createStageAttempt('GOVERNMENT_ID', 'APPROVED', {
                        method: 'BVN',
                    }),
                    createStageAttempt('IDENTITY_DOCUMENT', 'APPROVED', {
                        method: 'INTERNATIONAL_PASSPORT',
                        providerStatus: 'PASSED',
                    }),
                    createStageAttempt('ADDRESS', 'APPROVED', {
                        method: 'UTILITY_BILL',
                        providerStatus: 'PASSED',
                    }),
                    createStageAttempt('INCOME', 'PENDING_REVIEW', {
                        method: 'PAYSLIP',
                        providerStatus: 'INCONCLUSIVE',
                        reasonCode: 'MANUAL_REVIEW_REQUIRED',
                        reasonMessage: 'Income review pending',
                    }),
                ],
            });

            const result = await service.getProfile({ ...baseUser, userType: UserType.INDIVIDUAL } as any);
            const identityStage = result.data.kycJourney.stages.find((stage: any) => stage.stage === 'IDENTITY_DOCUMENT');
            const addressStage = result.data.kycJourney.stages.find((stage: any) => stage.stage === 'ADDRESS');
            const incomeStage = result.data.kycJourney.stages.find((stage: any) => stage.stage === 'INCOME');

            expect(result.data).not.toHaveProperty('verificationRequirements');
            expect(result.data.kycJourney.currentStage).toBe('INCOME');
            expect(result.data.kycJourney.nextAction.type).toBe('WAIT');
            expect(identityStage).toEqual(expect.objectContaining({ displayState: 'VERIFIED', providerStatus: 'PASSED' }));
            expect(addressStage).toEqual(expect.objectContaining({ displayState: 'VERIFIED', providerStatus: 'PASSED' }));
            expect(incomeStage).toEqual(
                expect.objectContaining({
                    displayState: 'UNDER_REVIEW',
                    providerStatus: 'INCONCLUSIVE',
                    reasonCode: 'MANUAL_REVIEW_REQUIRED',
                    reasonMessage: 'Income review pending',
                }),
            );
        });

        it('should return ADDRESS_VERIFICATION with declined details for INDIVIDUAL user when address is DECLINED', async () => {
            mockPrismaService.user.findUnique.mockResolvedValue({
                ...baseUser,
                userType: UserType.INDIVIDUAL,
                isDocumentVerified: false,
                kycStageAttempts: [
                    createStageAttempt('GOVERNMENT_ID', 'APPROVED', {
                        method: 'BVN',
                    }),
                    createStageAttempt('IDENTITY_DOCUMENT', 'APPROVED'),
                    createStageAttempt('ADDRESS', 'REJECTED', {
                        reasonMessage: 'Address verification was declined',
                    }),
                ],
            });

            const result = await service.getProfile({ ...baseUser, userType: UserType.INDIVIDUAL } as any);

            expect(result.data).not.toHaveProperty('verificationRequirements');
            expect(result.data.kycJourney.overallStatus).toBe('ACTION_REQUIRED');
            expect(result.data.kycJourney.currentStage).toBe('ADDRESS');
            expect(result.data.kycJourney.nextAction).toEqual(
                expect.objectContaining({
                    type: 'RESUBMIT',
                    stage: 'ADDRESS',
                    route: '/verify-address',
                    message: 'Address verification was declined',
                }),
            );
        });

        it.each([
            {
                name: 'document pending',
                profile: {
                    userType: UserType.INDIVIDUAL,
                    isDocumentVerified: false,
                    kycStageAttempts: [
                        createStageAttempt('GOVERNMENT_ID', 'APPROVED', {
                            method: 'BVN',
                        }),
                        createStageAttempt('IDENTITY_DOCUMENT', 'PENDING_REVIEW'),
                    ],
                },
                expectedStep: 'WAIT_FOR_VERIFICATION',
                expectedStage: 'IDENTITY_DOCUMENT',
                expectedActionType: 'WAIT',
                expectedRoute: '/',
                expectedMessage: 'Identity Document is under review.',
            },
            {
                name: 'document declined',
                profile: {
                    userType: UserType.INDIVIDUAL,
                    isDocumentVerified: false,
                    kycStageAttempts: [
                        createStageAttempt('GOVERNMENT_ID', 'APPROVED', {
                            method: 'BVN',
                        }),
                        createStageAttempt('IDENTITY_DOCUMENT', 'REJECTED', {
                            reasonMessage: 'Document verification was declined',
                        }),
                    ],
                },
                expectedStep: 'IDENTITY_DOCUMENT',
                expectedStage: 'IDENTITY_DOCUMENT',
                expectedActionType: 'RESUBMIT',
                expectedRoute: '/document-type',
                expectedMessage: 'Document verification was declined',
            },
            {
                name: 'income pending',
                profile: {
                    userType: UserType.INDIVIDUAL,
                    isDocumentVerified: true,
                    kycStageAttempts: [
                        createStageAttempt('GOVERNMENT_ID', 'APPROVED', {
                            method: 'BVN',
                        }),
                        createStageAttempt('IDENTITY_DOCUMENT', 'APPROVED'),
                        createStageAttempt('ADDRESS', 'APPROVED'),
                        createStageAttempt('INCOME', 'PENDING_REVIEW'),
                    ],
                },
                expectedStep: 'WAIT_FOR_VERIFICATION',
                expectedStage: 'INCOME',
                expectedActionType: 'WAIT',
                expectedRoute: '/',
                expectedMessage: 'Income is under review.',
            },
            {
                name: 'income declined',
                profile: {
                    userType: UserType.INDIVIDUAL,
                    isDocumentVerified: true,
                    kycStageAttempts: [
                        createStageAttempt('GOVERNMENT_ID', 'APPROVED', {
                            method: 'BVN',
                        }),
                        createStageAttempt('IDENTITY_DOCUMENT', 'APPROVED'),
                        createStageAttempt('ADDRESS', 'APPROVED'),
                        createStageAttempt('INCOME', 'REJECTED', {
                            reasonMessage: 'Income verification was declined',
                        }),
                    ],
                },
                expectedStep: 'INCOME_VERIFICATION',
                expectedStage: 'INCOME',
                expectedActionType: 'RESUBMIT',
                expectedRoute: '/verify-income',
                expectedMessage: 'Income verification was declined',
            },
            {
                name: 'all KYC stages complete',
                profile: {
                    userType: UserType.INDIVIDUAL,
                    isDocumentVerified: true,
                    kycStageAttempts: [
                        createStageAttempt('GOVERNMENT_ID', 'APPROVED', {
                            method: 'BVN',
                        }),
                        createStageAttempt('IDENTITY_DOCUMENT', 'APPROVED'),
                        createStageAttempt('ADDRESS', 'APPROVED'),
                        createStageAttempt('INCOME', 'APPROVED'),
                    ],
                },
                expectedStep: 'COMPLETE',
                expectedStage: null,
                expectedActionType: 'COMPLETE',
                expectedRoute: '/',
                expectedMessage: null,
            },
        ])('should derive %s journey state for INDIVIDUAL users', async ({
            profile,
            expectedStep,
            expectedStage,
            expectedActionType,
            expectedRoute,
            expectedMessage,
        }) => {
            mockPrismaService.user.findUnique.mockResolvedValue({
                ...baseUser,
                ...profile,
            });

            const result = await service.getProfile({ ...baseUser, userType: UserType.INDIVIDUAL } as any);

            expect(result.data).not.toHaveProperty('verificationRequirements');
            expect(result.data.kycJourney.currentStage).toBe(expectedStage);
            expect(result.data.kycJourney.nextAction).toEqual(
                expect.objectContaining({
                    type: expectedActionType,
                    stage: expectedStage,
                    route: expectedRoute,
                    message: expectedMessage,
                }),
            );

            if (expectedStep === 'COMPLETE') {
                expect(result.data.kycJourney.overallStatus).toBe('VERIFIED');
                expect(result.data.kycJourney.completedStages).toEqual([
                    'GOVERNMENT_ID',
                    'IDENTITY_DOCUMENT',
                    'ADDRESS',
                    'INCOME',
                ]);
                expect(result.data.kycJourney.nextAction.type).toBe('COMPLETE');
            }
        });

        it('should return COMPLETE for BUSINESS user when documents are verified', async () => {
            mockPrismaService.user.findUnique.mockResolvedValue({
                ...baseUser,
                businessRecordCompleted: true,
                businessDocumentsUploaded: true,
                businessDocumentVerificationStatus: DocumentVerificationStatus.VERIFIED,
                isDocumentVerified: false,
            });

            const result = await service.getProfile(baseUser as any);

            expect(result.data.verificationRequirements.nextStep).toBe('COMPLETE');
            expect(result.data.verificationRequirements.details).toBeNull();
        });
    });

    describe('getProfile - Stale cache guard', () => {
        const individualUser = {
            id: 50,
            email: 'cache-test@individual.com',
            userType: UserType.INDIVIDUAL,
        } as any;

        beforeEach(() => {
            jest.clearAllMocks();
        });

        it('should refresh cached individual profile when cached payload predates stage attempts', async () => {
            const cachedResponse = {
                data: {
                    userType: UserType.INDIVIDUAL,
                    verificationRequirements: { nextStep: 'GOVERNMENT_ID', details: null },
                },
            };
            mockRedisCacheService.get.mockResolvedValue(cachedResponse);
            mockPrismaService.user.findUnique.mockResolvedValue({
                id: 50,
                email: 'cache-test@individual.com',
                userType: UserType.INDIVIDUAL,
                firstName: 'Cache',
                lastName: 'Tester',
                isEmailVerified: true,
                isPhoneVerified: true,
                isPasswordCreated: true,
                isDocumentVerified: false,
                documentVerificationStatus: null,
                tier: 0,
                businessRecordCompleted: false,
                businessDocumentsUploaded: false,
                businessDocumentVerificationStatus: null,
                businessRecord: null,
                accountLimit: null,
                flaggedRecord: null,
                kycStageAttempts: [
                    createStageAttempt('GOVERNMENT_ID', 'PENDING_REVIEW', {
                        method: 'BVN',
                    }),
                ],
            });
            mockPrismaService.assetWallet.findFirst.mockResolvedValue({ balance: 0 });

            const result = await service.getProfile(individualUser);

            expect(result.data).not.toHaveProperty('verificationRequirements');
            expect(result.data.kycJourney.currentStage).toBe('GOVERNMENT_ID');
            expect(result.data.kycJourney.nextAction.type).toBe('WAIT');
            expect(mockPrismaService.user.findUnique).toHaveBeenCalled();
        });

        it('should recompute cached profile requirements from current stage attempts', async () => {
            const cachedResponse = {
                data: {
                    userType: UserType.INDIVIDUAL,
                    isEmailVerified: true,
                    isPhoneVerified: false,
                    isPasswordCreated: true,
                    isDocumentVerified: false,
                    bvn: null,
                    nin: null,
                    kycStageAttempts: [
                        createStageAttempt('GOVERNMENT_ID', 'PENDING_REVIEW', {
                            method: 'BVN',
                        }),
                    ],
                    verificationRequirements: { nextStep: 'GOVERNMENT_ID', details: null },
                },
            };
            mockRedisCacheService.get.mockResolvedValue(cachedResponse);

            const result = await service.getProfile(individualUser);
            const cachedWrite = mockRedisCacheService.set.mock.calls.at(-1)?.[1];

            expect(result.data).not.toHaveProperty('verificationRequirements');
            expect(result.data.kycJourney.currentStage).toBe('GOVERNMENT_ID');
            expect(result.data.kycJourney.nextAction.type).toBe('WAIT');
            expect(result.data).toMatchObject({
                emailVerified: true,
                phoneVerified: false,
                passwordCreated: true,
                documentVerified: false,
                isDocumentVerified: false,
            });
            expect(result.data).not.toHaveProperty('isEmailVerified');
            expect(result.data).not.toHaveProperty('isPhoneVerified');
            expect(result.data).not.toHaveProperty('isPasswordCreated');
            expect(cachedWrite.data).toMatchObject({
                emailVerified: true,
                phoneVerified: false,
                passwordCreated: true,
                documentVerified: false,
                isDocumentVerified: false,
            });
            expect(cachedWrite.data).not.toHaveProperty('isEmailVerified');
            expect(cachedWrite.data).not.toHaveProperty('isPhoneVerified');
            expect(cachedWrite.data).not.toHaveProperty('isPasswordCreated');
            expect(cachedWrite.data).not.toHaveProperty('verificationRequirements');
            expect(mockRedisCacheService.set).toHaveBeenCalledWith(
                'user:profile:50',
                expect.objectContaining({
                    data: expect.objectContaining({
                        kycJourney: expect.objectContaining({
                            currentStage: 'GOVERNMENT_ID',
                            overallStatus: 'IN_REVIEW',
                            nextAction: expect.objectContaining({
                                type: 'WAIT',
                                stage: 'GOVERNMENT_ID',
                            }),
                        }),
                    }),
                }),
                300,
            );
        });
    });

    describe('updateNotificationToken', () => {
        const mockUser = {
            id: 26,
            firstName: 'Test',
            lastName: 'User',
            email: 'test@example.com',
            password: 'hashed-password',
            status: 'active',
            userType: UserType.INDIVIDUAL,
        } as any;

        beforeEach(() => {
            jest.clearAllMocks();
            mockPrismaService.deviceToken.upsert.mockResolvedValue({});
            mockPrismaService.user.update.mockResolvedValue({});
            mockPrismaService.deviceToken.deleteMany.mockResolvedValue({ count: 1 });
            mockRedisCacheService.del.mockResolvedValue(1);
        });

        it('should enable push notifications and persist both device token and legacy token', async () => {
            const result = await service.updateNotificationToken(
                mockUser,
                'token-abc',
                'Chrome',
                'web',
            );

            expect(mockPrismaService.deviceToken.upsert).toHaveBeenCalledWith({
                where: {
                    userId_token: { userId: mockUser.id, token: 'token-abc' },
                },
                update: {
                    deviceName: 'Chrome',
                    platform: 'web',
                },
                create: {
                    userId: mockUser.id,
                    token: 'token-abc',
                    deviceName: 'Chrome',
                    platform: 'web',
                },
            });
            expect(mockPrismaService.user.update).toHaveBeenCalledWith({
                where: { id: mockUser.id },
                data: { notificationToken: 'token-abc' },
            });
            expect(mockRedisCacheService.del).toHaveBeenCalledWith(`user:profile:${mockUser.id}`);
            expect(result.message).toContain('enabled');
        });

        it('should gracefully handle Redis invalidation failure after enabling push', async () => {
            const redisError = new Error('Redis unavailable');
            mockRedisCacheService.del.mockRejectedValueOnce(redisError);

            const warnSpy = jest.spyOn(service['logger'], 'warn');
            const result = await service.updateNotificationToken(mockUser, 'token-abc');

            expect(result.message).toContain('enabled');
            expect(warnSpy).toHaveBeenCalledWith(
                expect.stringContaining(`Failed to invalidate profile cache for user ${mockUser.id}`),
            );
            expect(mockPrismaService.deviceToken.upsert).toHaveBeenCalled();
            expect(mockPrismaService.user.update).toHaveBeenCalled();
        });

        it('should disable push notifications and remove device tokens', async () => {
            const result = await service.updateNotificationToken(mockUser, null);

            expect(mockPrismaService.deviceToken.deleteMany).toHaveBeenCalledWith({
                where: { userId: mockUser.id },
            });
            expect(mockPrismaService.user.update).toHaveBeenCalledWith({
                where: { id: mockUser.id },
                data: { notificationToken: null },
            });
            expect(mockRedisCacheService.del).toHaveBeenCalledWith(`user:profile:${mockUser.id}`);
            expect(result.message).toContain('disabled');
        });

        it('should still succeed when DeviceToken upsert fails and fallback to legacy update', async () => {
            mockPrismaService.deviceToken.upsert.mockRejectedValueOnce(new Error('upsert failed'));

            const result = await service.updateNotificationToken(mockUser, 'legacy-token');

            expect(result.message).toContain('enabled');
            expect(mockPrismaService.user.update).toHaveBeenCalledWith({
                where: { id: mockUser.id },
                data: { notificationToken: 'legacy-token' },
            });
        });

        it('should still return success when both DeviceToken upsert and Redis fail', async () => {
            mockPrismaService.deviceToken.upsert.mockRejectedValueOnce(new Error('upsert failed'));
            mockRedisCacheService.del.mockRejectedValueOnce(new Error('redis down'));

            const result = await service.updateNotificationToken(mockUser, 'token-abc');

            expect(result.message).toContain('enabled');
            expect(mockPrismaService.user.update).toHaveBeenCalled();
            expect(mockRedisCacheService.del).toHaveBeenCalled();
        });

        it('should return success (200 OK equivalent) even when Redis connection fails', async () => {
            // Simulate Redis connection failure
            const redisConnectionError = new Error('Redis connection refused');
            mockRedisCacheService.del.mockRejectedValueOnce(redisConnectionError);
            
            // Spy on logger to verify Redis error is logged but not thrown
            const warnSpy = jest.spyOn(service['logger'], 'warn');
            
            // Call the method, this should NOT throw an error
            let thrownError = null;
            let result = null;
            
            try {
                result = await service.updateNotificationToken(
                    mockUser,
                    'test-token-123',
                    'Chrome Browser',
                    'web'
                );
            } catch (error) {
                thrownError = error;
            }
                        
            // No error was thrown (method succeeded)
            expect(thrownError).toBeNull();
            
            // Method returned a success response (200 OK equivalent)
            expect(result).toBeDefined();
            expect(result.message).toBe('Push notifications enabled');
            
            // Database operations still succeeded despite Redis failure
            expect(mockPrismaService.deviceToken.upsert).toHaveBeenCalled();
            expect(mockPrismaService.user.update).toHaveBeenCalled();
            
            // Redis was attempted (proves we tried to use it)
            expect(mockRedisCacheService.del).toHaveBeenCalledWith('user:profile:26');
            
            // Redis failure was logged as a warning (not an error that breaks the flow)
            expect(warnSpy).toHaveBeenCalledWith(
                expect.stringContaining('Failed to invalidate profile cache for user 26')
            );
            expect(warnSpy).toHaveBeenCalledWith(
                expect.stringContaining('Redis connection refused')
            );
        });

        // Multiple Redis failures
        it('should handle multiple consecutive Redis failures gracefully', async () => {
            // Simulate Redis failing multiple times
            mockRedisCacheService.del.mockRejectedValue(new Error('Redis connection refused'));
            
            // Call the method multiple times
            const results = await Promise.all([
                service.updateNotificationToken(mockUser, 'token-1', 'Chrome', 'web'),
                service.updateNotificationToken(mockUser, 'token-2', 'Firefox', 'web'),
                service.updateNotificationToken(mockUser, 'token-3', 'Safari', 'web'),
            ]);
            
            // All calls should succeed
            results.forEach(result => {
                expect(result.message).toBe('Push notifications enabled');
            });
            
            // Redis was attempted each time
            expect(mockRedisCacheService.del).toHaveBeenCalledTimes(3);
            
            // Database was updated each time
            expect(mockPrismaService.user.update).toHaveBeenCalledTimes(3);
        });

        // DeviceToken fails but Redis also fails - should still succeed
        it('should succeed when both DeviceToken upsert AND Redis fail', async () => {
            // Simulate DeviceToken failure
            mockPrismaService.deviceToken.upsert.mockRejectedValueOnce(
                new Error('DeviceToken table constraint violation')
            );
            
            // Simulate Redis failure
            mockRedisCacheService.del.mockRejectedValueOnce(
                new Error('Redis connection refused')
            );
            
            const warnSpy = jest.spyOn(service['logger'], 'warn');
            
            const result = await service.updateNotificationToken(
                mockUser,
                'token-multi-fail',
                'Chrome',
                'web'
            );
            
            // Should still return success (legacy token update should work)
            expect(result.message).toBe('Push notifications enabled');
            
            // Both failures should be logged as warnings
            expect(warnSpy).toHaveBeenCalledWith(
                expect.stringContaining('DeviceToken upsert failed')
            );
            expect(warnSpy).toHaveBeenCalledWith(
                expect.stringContaining('Failed to invalidate profile cache')
            );
            
            // Legacy token update should still happen
            expect(mockPrismaService.user.update).toHaveBeenCalledWith({
                where: { id: mockUser.id },
                data: { notificationToken: 'token-multi-fail' },
            });
        });

        it('should handle non-Error objects in Redis failure', async () => {
            // Simulate Redis throwing a string (not an Error object)
            mockRedisCacheService.del.mockRejectedValueOnce('Connection refused');
            
            const warnSpy = jest.spyOn(service['logger'], 'warn');
            const result = await service.updateNotificationToken(mockUser, 'test-token');
            
            expect(result.message).toBe('Push notifications enabled');
            expect(warnSpy).toHaveBeenCalledWith(
                expect.stringContaining('Failed to invalidate profile cache')
            );
           
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
