describe("SmsService", () => {
    beforeEach(() => {
        jest.resetModules();
        jest.clearAllMocks();
    });

    const loadService = (configured: boolean, sendImpl?: jest.Mock) => {
        const sendSms = sendImpl ?? jest.fn().mockResolvedValue({ success: true });
        const SendchampLib = jest.fn().mockImplementation(() => ({ sendSms }));

        jest.doMock("@/config", () => ({
            sendchampConfig: {
                accessKey: configured ? "access-key" : "",
                senderId: "FLIPXER",
            },
            sendchampOptions: { baseUrl: "https://mock.sendchamp" },
        }));

        jest.doMock("@/config/constants", () => ({
            COMPANY_NAME: "Flipxer",
        }));

        jest.doMock("@/libs/sendchamp", () => ({
            SendchampLib,
        }));

        const { SmsService } = require("../index");
        const service = new SmsService();

        return { service, sendSms, SendchampLib };
    };

    it("initializes Sendchamp when configured", async () => {
        const { service, SendchampLib } = loadService(true);

        expect(SendchampLib).toHaveBeenCalled();
        expect(service.isEnabled()).toBe(true);
    });

    it("does not initialize Sendchamp when not configured", async () => {
        const { service, SendchampLib } = loadService(false);

        expect(SendchampLib).not.toHaveBeenCalled();
        expect(service.isEnabled()).toBe(false);
    });

    it("returns early in sendSms when unconfigured", async () => {
        const { service } = loadService(false);

        await expect(service.sendSms("08012345678", "hello")).resolves.toBeUndefined();
    });

    it("formats phone and sends sms when configured", async () => {
        const sendMock = jest.fn().mockResolvedValue({ ok: true });
        const { service } = loadService(true, sendMock);

        await service.sendSms("+080 123 45678", "hello world");

        expect(sendMock).toHaveBeenCalledWith({
            to: "2348012345678",
            message: "hello world",
            sender_name: "FLIPXER",
            route: "dnd",
        });
    });

    it("rethrows send errors", async () => {
        const sendMock = jest.fn().mockRejectedValue(new Error("gateway-failed"));
        const { service } = loadService(true, sendMock);

        await expect(service.sendSms("08012345678", "hello")).rejects.toThrow("gateway-failed");
    });

    it("sends verification code with expected content", async () => {
        const sendMock = jest.fn().mockResolvedValue({ ok: true });
        const { service } = loadService(true, sendMock);

        await service.sendVerificationCode("08012345678", "123456");

        expect(sendMock).toHaveBeenCalledWith(
            expect.objectContaining({
                to: "2348012345678",
                message: expect.stringContaining("verification code is: 123456"),
            })
        );
    });

    it("sends debit/credit transaction notifications", async () => {
        const sendMock = jest.fn().mockResolvedValue({ ok: true });
        const { service } = loadService(true, sendMock);

        await service.sendTransactionNotification("08012345678", "credit", "25.00", "NGN");
        await service.sendTransactionNotification("08012345678", "debit", "12.00", "NGN");

        expect(sendMock).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({
                message: expect.stringContaining("You have received NGN 25.00"),
            })
        );

        expect(sendMock).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({
                message: expect.stringContaining("You have sent NGN 12.00"),
            })
        );
    });

    it("formats non-nigerian-looking strings by prefixing 234", () => {
        const { service } = loadService(true);
        const formatted = (service as any).formatPhoneNumber("8012345678");
        expect(formatted).toBe("2348012345678");
    });
});
