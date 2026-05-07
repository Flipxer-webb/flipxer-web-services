import { handleBuyOrderWebhookPayment } from "../buy-order-webhook-payment.util";

describe("handleBuyOrderWebhookPayment", () => {
    it("delegates BUY webhook decisions to BuyOrderService", async () => {
        const buyOrderService = {
            handleWebhookBuyOrderPayment: jest.fn().mockResolvedValue(undefined),
        };

        await handleBuyOrderWebhookPayment({
            payment: {
                id: 1,
                orderId: 10,
                userId: 20,
                totalAmount: "100000",
                reference: "buy-ref-1",
                createdAt: new Date(),
                status: "PENDING" as any,
                paymentStatus: "PENDING" as any,
            },
            event: {
                amount: 100000,
                providerReference: "provider-ref-1",
            } as any,
            reference: "buy-ref-1",
            provider: "nomba",
            buyOrderService: buyOrderService as any,
        });

        expect(
            buyOrderService.handleWebhookBuyOrderPayment,
        ).toHaveBeenCalledWith(
            expect.objectContaining({
                reference: "buy-ref-1",
                provider: "nomba",
                event: expect.objectContaining({
                    amount: 100000,
                    providerReference: "provider-ref-1",
                }),
            }),
        );
    });
});