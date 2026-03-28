import { generateUssdCode, isUssdSupported } from "../ussd-codes";

describe("generateUssdCode", () => {
    it("generates GTBank USSD code", () => {
        expect(generateUssdCode("058", "0123456789", 5000)).toBe(
            "*737*2*5000*0123456789#",
        );
    });

    it("generates Access Bank USSD code", () => {
        expect(generateUssdCode("044", "0123456789", 10000)).toBe(
            "*901*10000*0123456789#",
        );
    });

    it("generates UBA USSD code with correct placeholder order", () => {
        expect(generateUssdCode("033", "0123456789", 2500)).toBe(
            "*919*4*0123456789*2500#",
        );
    });

    it("rounds fractional amounts to integer", () => {
        expect(generateUssdCode("058", "0123456789", 5000.75)).toBe(
            "*737*2*5001*0123456789#",
        );
    });

    it("returns null for unsupported bank code", () => {
        expect(generateUssdCode("999", "0123456789", 5000)).toBeNull();
    });

    it("generates Kuda Bank code", () => {
        expect(generateUssdCode("50211", "0123456789", 3000)).toBe(
            "*5573*3000*0123456789#",
        );
    });

    it("generates OPay code", () => {
        expect(generateUssdCode("999992", "0123456789", 1500)).toBe(
            "*955*1500*0123456789#",
        );
    });
});

describe("isUssdSupported", () => {
    it("returns true for supported banks", () => {
        expect(isUssdSupported("058")).toBe(true);  // GTBank
        expect(isUssdSupported("044")).toBe(true);  // Access
        expect(isUssdSupported("033")).toBe(true);  // UBA
        expect(isUssdSupported("50211")).toBe(true); // Kuda
    });

    it("returns false for unsupported banks", () => {
        expect(isUssdSupported("999")).toBe(false);
        expect(isUssdSupported("")).toBe(false);
        expect(isUssdSupported("000")).toBe(false);
    });
});
