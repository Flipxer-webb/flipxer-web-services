import { Test, TestingModule } from "@nestjs/testing";
import { TradeHelpersService } from "../trade-helpers.service";
import { NetworkTypes } from "@prisma/client";

describe("TradeHelpersService", () => {
    let service: TradeHelpersService;

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            providers: [TradeHelpersService],
        }).compile();

        service = module.get<TradeHelpersService>(TradeHelpersService);
    });

    it("should be defined", () => {
        expect(service).toBeDefined();
    });

    describe("normalizeNetworkInput", () => {
        it("should return null for null/undefined input", () => {
            expect(service.normalizeNetworkInput(null)).toBeNull();
            expect(service.normalizeNetworkInput()).toBeNull();
            expect(service.normalizeNetworkInput("")).toBeNull();
            expect(service.normalizeNetworkInput("   ")).toBeNull();
        });

        it("should normalize direct network matches", () => {
            expect(service.normalizeNetworkInput("trc20")).toBe(NetworkTypes.trc20);
            expect(service.normalizeNetworkInput("erc20")).toBe(NetworkTypes.erc20);
            expect(service.normalizeNetworkInput("bep20")).toBe(NetworkTypes.bep20);
        });

        it("should be case-insensitive", () => {
            expect(service.normalizeNetworkInput("TRC20")).toBe(NetworkTypes.trc20);
            expect(service.normalizeNetworkInput("ERC20")).toBe(NetworkTypes.erc20);
            expect(service.normalizeNetworkInput("Bep20")).toBe(NetworkTypes.bep20);
        });

        it("should handle common aliases", () => {
            expect(service.normalizeNetworkInput("tron")).toBe(NetworkTypes.trc20);
            expect(service.normalizeNetworkInput("ethereum")).toBe(NetworkTypes.erc20);
            expect(service.normalizeNetworkInput("bsc")).toBe(NetworkTypes.bep20);
        });

        it("should handle compound formats", () => {
            expect(service.normalizeNetworkInput("tron_trc20")).toBe(NetworkTypes.trc20);
            expect(service.normalizeNetworkInput("ethereum/erc20")).toBe(NetworkTypes.erc20);
        });

        it("should return null for unknown networks", () => {
            expect(service.normalizeNetworkInput("unknown_network")).toBeNull();
            expect(service.normalizeNetworkInput("fake")).toBeNull();
        });
    });

    describe("isNetworkSupported", () => {
        it("should return true for supported networks", () => {
            expect(service.isNetworkSupported("trc20")).toBe(true);
            expect(service.isNetworkSupported("erc20")).toBe(true);
            expect(service.isNetworkSupported("tron")).toBe(true);
        });

        it("should return false for unsupported networks", () => {
            expect(service.isNetworkSupported("unknown")).toBe(false);
            expect(service.isNetworkSupported("fake_network")).toBe(false);
        });
    });

    describe("getNetworkDisplayName", () => {
        it("should return human-readable network names", () => {
            expect(service.getNetworkDisplayName(NetworkTypes.trc20)).toBe("Tron (TRC-20)");
            expect(service.getNetworkDisplayName(NetworkTypes.erc20)).toBe("Ethereum (ERC-20)");
            expect(service.getNetworkDisplayName(NetworkTypes.btc)).toBe("Bitcoin");
            expect(service.getNetworkDisplayName(NetworkTypes.solana)).toBe("Solana");
        });
    });

    describe("parseAmount", () => {
        it("should parse valid string amounts", () => {
            expect(service.parseAmount("100.50")).toBe(100.5);
            expect(service.parseAmount("0.00001")).toBe(0.00001);
            expect(service.parseAmount("0")).toBe(0);
        });

        it("should handle number inputs", () => {
            expect(service.parseAmount(100.5)).toBe(100.5);
            expect(service.parseAmount(0)).toBe(0);
        });

        it("should return null for invalid amounts", () => {
            expect(service.parseAmount("abc")).toBeNull();
            expect(service.parseAmount(Number.NaN)).toBeNull();
            expect(service.parseAmount(Infinity)).toBeNull();
            expect(service.parseAmount(-1)).toBeNull();
        });

        it("should respect minAmount constraint", () => {
            expect(service.parseAmount("10", 5)).toBe(10);
            expect(service.parseAmount("3", 5)).toBeNull();
            expect(service.parseAmount("5", 5)).toBe(5);
        });
    });

    describe("formatAmount", () => {
        it("should format amounts with default 8 decimals", () => {
            expect(service.formatAmount(1.00000001)).toBe("1.00000001");
            expect(service.formatAmount(100)).toBe("100");
        });

        it("should remove trailing zeros", () => {
            expect(service.formatAmount(1.5)).toBe("1.5");
            expect(service.formatAmount(10)).toBe("10");
        });

        it("should respect custom decimal places", () => {
            expect(service.formatAmount(1.123456789, 4)).toBe("1.1235");
        });
    });

    describe("formatFiatAmount", () => {
        it("should format NGN amounts correctly", () => {
            const result = service.formatFiatAmount(1000.5);
            expect(result).toContain("1,000.50");
        });

        it("should format with specified currency", () => {
            const result = service.formatFiatAmount(1000, "USD");
            expect(result).toContain("1,000.00");
        });
    });

    describe("safeJsonStringify", () => {
        it("should stringify a simple object", () => {
            const obj = { name: "test", value: 123 };
            const result = service.safeJsonStringify(obj);
            expect(result).toBe('{"name":"test","value":123}');
        });

        it("should handle BigInt by converting to string", () => {
            const obj = { bigNumber: BigInt(9007199254740991) };
            const result = service.safeJsonStringify(obj);
            expect(result).toContain("9007199254740991");
        });

        it("should handle nested objects", () => {
            const obj = { 
                level1: { 
                    level2: { 
                        value: "deep" 
                    } 
                } 
            };
            const result = service.safeJsonStringify(obj);
            expect(result).toContain("deep");
        });
    });
});
