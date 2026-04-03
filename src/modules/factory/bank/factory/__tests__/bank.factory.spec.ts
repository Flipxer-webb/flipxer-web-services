const mockFincraLib = jest.fn().mockImplementation((options) => ({ kind: "fincra-lib", options }));
const mockFincraBank = jest.fn().mockImplementation((client, prisma) => ({ provider: "fincra", client, prisma }));
const mockNombaLib = jest.fn().mockImplementation((options) => ({ kind: "nomba-lib", options }));
const mockNombaBank = jest.fn().mockImplementation((client, prisma) => ({ provider: "nomba", client, prisma }));

jest.mock("@/config", () => ({
    fincraOptions: {
        baseUrl: "https://fincra.local",
        secretKey: "sec",
        publicKey: "pub",
        businessId: "biz",
        webhookSecret: "wh",
        proxyUrl: "https://proxy.local",
    },
    nombaOptions: {
        baseUrl: "https://nomba.local",
        clientId: "cid",
        clientSecret: "csecret",
        accountId: "acct",
        webhookSecret: "nwh",
    },
}));

jest.mock("@/libs/fincra", () => ({
    FincraLib: mockFincraLib,
}));

jest.mock("../../providers/fincra.provider", () => ({
    FincraBank: mockFincraBank,
}));

jest.mock("@/libs/nomba", () => ({
    NombaLib: mockNombaLib,
}));

jest.mock("../../providers/nomba.provider", () => ({
    NombaBank: mockNombaBank,
}));

import { BankFactory } from "../bank.factory";

describe("BankFactory", () => {
    it("builds fincra provider", () => {
        const prisma = { id: "prisma" } as any;
        const factory = new BankFactory<any>(prisma);

        const provider = factory.build({ provider: "fincra" } as any);

        expect(mockFincraLib).toHaveBeenCalledWith(expect.objectContaining({ proxyUrl: "https://proxy.local" }));
        expect(mockFincraBank).toHaveBeenCalledTimes(1);
        expect(provider).toEqual(expect.objectContaining({ provider: "fincra", prisma }));
    });

    it("builds nomba provider", () => {
        const prisma = { id: "prisma" } as any;
        const factory = new BankFactory<any>(prisma);

        const provider = factory.build({ provider: "nomba" } as any);

        expect(mockNombaLib).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: "https://nomba.local" }));
        expect(mockNombaBank).toHaveBeenCalledTimes(1);
        expect(provider).toEqual(expect.objectContaining({ provider: "nomba", prisma }));
    });

    it("returns undefined for unsupported provider", () => {
        const factory = new BankFactory<any>({} as any);

        const provider = factory.build({ provider: "unsupported" } as any);

        expect(provider).toBeUndefined();
    });
});
