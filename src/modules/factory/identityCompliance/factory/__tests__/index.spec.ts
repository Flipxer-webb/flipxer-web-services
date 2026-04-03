const dojahServiceCtor = jest.fn().mockImplementation(function ctor(client: unknown) {
    (this as any).client = client;
});
const dojahLibCtor = jest.fn().mockImplementation(function ctor(config: unknown) {
    (this as any).config = config;
});

jest.mock("../../providers/dojah/services", () => ({
    DojahService: dojahServiceCtor,
    __esModule: true,
}));

jest.mock("@/libs/dojah", () => ({
    DojahLib: dojahLibCtor,
    __esModule: true,
}));

import { IdentityComplianceFactory } from "../index";

describe("IdentityComplianceFactory", () => {
    const config = {
        dojah: {
            secret_key: "sec-key",
            app_id: "app-id",
            baseUrl: "https://dojah.example",
        },
    } as any;

    beforeEach(() => {
        jest.clearAllMocks();
    });

    it("builds a DojahService when provider is dojah", () => {
        const factory = new IdentityComplianceFactory(config);

        const instance = factory.build({ provider: "dojah" } as never);

        expect(dojahLibCtor).toHaveBeenCalledWith({
            apiKey: "sec-key",
            appId: "app-id",
            baseURL: "https://dojah.example",
        });
        expect(dojahServiceCtor).toHaveBeenCalledTimes(1);
        expect((dojahServiceCtor.mock.calls[0] || [])[0]).toBe(dojahLibCtor.mock.instances[0]);
        expect(instance).toBe(dojahServiceCtor.mock.instances[0]);
    });

    it("throws on unknown provider", () => {
        const factory = new IdentityComplianceFactory(config);

        expect(() => factory.build({ provider: "unknown" } as never)).toThrow(
            "Unknown provider: unknown",
        );
        expect(dojahLibCtor).not.toHaveBeenCalled();
        expect(dojahServiceCtor).not.toHaveBeenCalled();
    });
});
