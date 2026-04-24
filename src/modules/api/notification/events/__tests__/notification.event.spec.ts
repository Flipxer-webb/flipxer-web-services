jest.mock("@/config", () => ({
    mailConfig: { senderMail: "noreply@example.com" },
    emailTemplateConfig: { transaction_notification: "transaction-template" },
    COMPANY_NAME: "Flipxer",
}));

import { NotificationEvent } from "../notification.event";

describe("NotificationEvent", () => {
    let emailService: { sendMailWithTemplate: jest.Mock };
    let event: NotificationEvent;

    const basePayload = {
        email: "user@example.com",
        notice: "Your order completed",
        transactionType: "deposit" as const,
        transactionId: "TX-1",
        amount: "100",
        currency: "BTC",
        status: "completed",
        date: "2026-03-29",
    };

    beforeEach(() => {
        emailService = {
            sendMailWithTemplate: jest.fn().mockResolvedValue(undefined),
        };
        event = new NotificationEvent(emailService as any);
    });

    // ─── Basic plumbing ────────────────────────────────────────────

    it("sends templated transaction notification", async () => {
        await event.sendTransactionNotification(basePayload);

        expect(emailService.sendMailWithTemplate).toHaveBeenCalledWith(
            expect.objectContaining({
                template_key: "transaction-template",
                merge_info: expect.objectContaining({
                    header: "Deposit Completed",
                    transaction_id: "TX-1",
                }),
            })
        );
    });

    it("handles send failures without throwing", async () => {
        emailService.sendMailWithTemplate.mockRejectedValue(new Error("mail down"));
        const loggerSpy = jest.spyOn((event as any).logger, "log").mockImplementation();

        await expect(event.sendTransactionNotification(basePayload)).resolves.toBeUndefined();
        expect(loggerSpy).toHaveBeenCalled();

        loggerSpy.mockRestore();
    });

    it("emits and listens to typed event names", async () => {
        const listener = jest.fn();
        event.on("transaction_notification", listener as any);
        event.emit("transaction_notification", basePayload);

        await new Promise((resolve) => setImmediate(resolve));
        expect(listener).toHaveBeenCalledWith(basePayload);
    });

    // ─── Dynamic headers: every type × every status ────────────────

    describe("dynamic header labels", () => {
        const transactionTypes = [
            { type: "deposit", label: "Deposit" },
            { type: "withdrawal", label: "Withdrawal" },
            { type: "swap", label: "Swap" },
            { type: "buy", label: "Purchase" },
            { type: "sell", label: "Sale" },
        ] as const;

        const statuses = [
            { status: "completed", suffix: "Completed" },
            { status: "failed", suffix: "Failed" },
            { status: "cancelled", suffix: "Cancelled" },
            { status: "reversed", suffix: "Reversed" },
            { status: "pending", suffix: "Pending" },
            { status: "processing", suffix: "Processing" },
        ] as const;

        for (const { type, label } of transactionTypes) {
            for (const { status, suffix } of statuses) {
                it(`header = "${label} ${suffix}" for type="${type}" status="${status}"`, async () => {
                    await event.sendTransactionNotification({
                        ...basePayload,
                        transactionType: type,
                        status,
                    });

                    expect(emailService.sendMailWithTemplate).toHaveBeenCalledWith(
                        expect.objectContaining({
                            merge_info: expect.objectContaining({
                                header: `${label} ${suffix}`,
                                status,
                            }),
                        })
                    );
                });
            }
        }

        it('falls back to "Transaction Notification" for unknown type and status', async () => {
            await event.sendTransactionNotification({
                ...basePayload,
                transactionType: "unknown_type" as any,
                status: "unknown_status",
            });

            expect(emailService.sendMailWithTemplate).toHaveBeenCalledWith(
                expect.objectContaining({
                    merge_info: expect.objectContaining({
                        header: "Transaction Notification",
                    }),
                })
            );
        });

        it("handles mixed-case status (e.g. COMPLETED → Completed)", async () => {
            await event.sendTransactionNotification({
                ...basePayload,
                transactionType: "buy",
                status: "COMPLETED",
            });

            expect(emailService.sendMailWithTemplate).toHaveBeenCalledWith(
                expect.objectContaining({
                    merge_info: expect.objectContaining({
                        header: "Purchase Completed",
                    }),
                })
            );
        });
    });

    // ─── Notice field passthrough ──────────────────────────────────

    describe("notice field", () => {
        it("passes through the notice message to merge_info", async () => {
            const notice = "🚫 Your buy order of 1 USDT was cancelled.";
            await event.sendTransactionNotification({
                ...basePayload,
                notice,
            });

            expect(emailService.sendMailWithTemplate).toHaveBeenCalledWith(
                expect.objectContaining({
                    merge_info: expect.objectContaining({ notice }),
                })
            );
        });
    });

    // ─── Optional fields default to empty string ───────────────────

    describe("optional fields default to empty string", () => {
        it("fills blockchain, swap, fiat, and receipt fields with empty strings when omitted", async () => {
            await event.sendTransactionNotification(basePayload);

            const { merge_info } = emailService.sendMailWithTemplate.mock.calls[0][0];
            expect(merge_info.tx_hash).toBe("");
            expect(merge_info.network).toBe("");
            expect(merge_info.wallet_address).toBe("");
            expect(merge_info.explorer_url).toBe("");
            expect(merge_info.recipient).toBe("");
            expect(merge_info.to_amount).toBe("");
            expect(merge_info.to_currency).toBe("");
            expect(merge_info.from_amount).toBe("");
            expect(merge_info.from_currency).toBe("");
            expect(merge_info.fiat_amount).toBe("");
            expect(merge_info.bank_name).toBe("");
            expect(merge_info.account_number).toBe("");
            expect(merge_info.order_reference).toBe("");
            expect(merge_info.network_fee).toBe("");
            expect(merge_info.exchange_rate).toBe("");
        });

        it("passes through optional fields when provided", async () => {
            await event.sendTransactionNotification({
                ...basePayload,
                transactionType: "withdrawal",
                txHash: "0xabc",
                network: "Ethereum",
                walletAddress: "0x123",
                explorerUrl: "https://etherscan.io/tx/0xabc",
                recipient: "0x456",
                networkFee: "0.001 ETH",
            });

            const { merge_info } = emailService.sendMailWithTemplate.mock.calls[0][0];
            expect(merge_info.tx_hash).toBe("0xabc");
            expect(merge_info.network).toBe("Ethereum");
            expect(merge_info.wallet_address).toBe("0x123");
            expect(merge_info.explorer_url).toBe("https://etherscan.io/tx/0xabc");
            expect(merge_info.recipient).toBe("0x456");
            expect(merge_info.network_fee).toBe("0.001 ETH");
        });
    });

    // ─── Realistic transaction flow scenarios ──────────────────────

    describe("realistic transaction flows", () => {
        it("buy order completed (with fiat details)", async () => {
            await event.sendTransactionNotification({
                email: "buyer@example.com",
                notice: "✅ Your buy order of 0.5 BTC was completed successfully.",
                transactionType: "buy",
                transactionId: "BUY-001",
                amount: "0.5",
                currency: "BTC",
                status: "completed",
                date: "2026-04-16T10:00:00Z",
                fiatAmount: "25000",
                bankName: "GTBank",
                accountNumber: "0123456789",
                orderReference: "ORD-ABC123",
                exchangeRate: "50000 NGN/BTC",
            });

            const { merge_info } = emailService.sendMailWithTemplate.mock.calls[0][0];
            expect(merge_info.header).toBe("Purchase Completed");
            expect(merge_info.fiat_amount).toBe("25000");
            expect(merge_info.bank_name).toBe("GTBank");
            expect(merge_info.exchange_rate).toBe("50000 NGN/BTC");
        });

        it("buy order cancelled by user", async () => {
            await event.sendTransactionNotification({
                email: "buyer@example.com",
                notice: "🚫 Your buy order of 1 USDT was cancelled. Transaction ID: BUY-002.",
                transactionType: "buy",
                transactionId: "BUY-002",
                amount: "1",
                currency: "USDT",
                status: "cancelled",
                date: "2026-04-16T02:31:00Z",
            });

            const { merge_info } = emailService.sendMailWithTemplate.mock.calls[0][0];
            expect(merge_info.header).toBe("Purchase Cancelled");
            expect(merge_info.notice).toContain("cancelled");
        });

        it("sell order completed", async () => {
            await event.sendTransactionNotification({
                email: "seller@example.com",
                notice: "✅ Your sell order of 100 USDT was completed.",
                transactionType: "sell",
                transactionId: "SELL-001",
                amount: "100",
                currency: "USDT",
                status: "completed",
                date: "2026-04-16T11:00:00Z",
                fiatAmount: "150000",
                bankName: "Access Bank",
                accountNumber: "9876543210",
            });

            const { merge_info } = emailService.sendMailWithTemplate.mock.calls[0][0];
            expect(merge_info.header).toBe("Sale Completed");
            expect(merge_info.fiat_amount).toBe("150000");
        });

        it("sell order failed", async () => {
            await event.sendTransactionNotification({
                email: "seller@example.com",
                notice: "❌ Your sell order failed. Funds have been returned.",
                transactionType: "sell",
                transactionId: "SELL-002",
                amount: "50",
                currency: "USDT",
                status: "failed",
                date: "2026-04-16T12:00:00Z",
            });

            const { merge_info } = emailService.sendMailWithTemplate.mock.calls[0][0];
            expect(merge_info.header).toBe("Sale Failed");
        });

        it("deposit completed (with blockchain details)", async () => {
            await event.sendTransactionNotification({
                email: "depositor@example.com",
                notice: "✅ Your deposit of 0.1 ETH has been confirmed.",
                transactionType: "deposit",
                transactionId: "DEP-001",
                amount: "0.1",
                currency: "ETH",
                status: "completed",
                date: "2026-04-16T09:00:00Z",
                txHash: "0xdeadbeef",
                network: "Ethereum",
                walletAddress: "0xwallet123",
                explorerUrl: "https://etherscan.io/tx/0xdeadbeef",
            });

            const { merge_info } = emailService.sendMailWithTemplate.mock.calls[0][0];
            expect(merge_info.header).toBe("Deposit Completed");
            expect(merge_info.tx_hash).toBe("0xdeadbeef");
            expect(merge_info.network).toBe("Ethereum");
        });

        it("deposit pending", async () => {
            await event.sendTransactionNotification({
                email: "depositor@example.com",
                notice: "⏳ Your deposit of 500 USDT is being processed.",
                transactionType: "deposit",
                transactionId: "DEP-002",
                amount: "500",
                currency: "USDT",
                status: "pending",
                date: "2026-04-16T09:30:00Z",
                network: "Tron",
            });

            const { merge_info } = emailService.sendMailWithTemplate.mock.calls[0][0];
            expect(merge_info.header).toBe("Deposit Pending");
        });

        it("withdrawal completed", async () => {
            await event.sendTransactionNotification({
                email: "withdrawer@example.com",
                notice: "✅ Your withdrawal of 0.5 BTC has been sent.",
                transactionType: "withdrawal",
                transactionId: "WDR-001",
                amount: "0.5",
                currency: "BTC",
                status: "completed",
                date: "2026-04-16T14:00:00Z",
                txHash: "0xwithdraw123",
                network: "Bitcoin",
                recipient: "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh",
                networkFee: "0.0001 BTC",
            });

            const { merge_info } = emailService.sendMailWithTemplate.mock.calls[0][0];
            expect(merge_info.header).toBe("Withdrawal Completed");
            expect(merge_info.recipient).toBe("bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh");
            expect(merge_info.network_fee).toBe("0.0001 BTC");
        });

        it("withdrawal failed", async () => {
            await event.sendTransactionNotification({
                email: "withdrawer@example.com",
                notice: "❌ Your withdrawal of 1 ETH failed. Please try again.",
                transactionType: "withdrawal",
                transactionId: "WDR-002",
                amount: "1",
                currency: "ETH",
                status: "failed",
                date: "2026-04-16T15:00:00Z",
            });

            const { merge_info } = emailService.sendMailWithTemplate.mock.calls[0][0];
            expect(merge_info.header).toBe("Withdrawal Failed");
        });

        it("withdrawal reversed", async () => {
            await event.sendTransactionNotification({
                email: "withdrawer@example.com",
                notice: "↩️ Your withdrawal of 2 BTC has been reversed.",
                transactionType: "withdrawal",
                transactionId: "WDR-003",
                amount: "2",
                currency: "BTC",
                status: "reversed",
                date: "2026-04-16T16:00:00Z",
            });

            const { merge_info } = emailService.sendMailWithTemplate.mock.calls[0][0];
            expect(merge_info.header).toBe("Withdrawal Reversed");
        });

        it("swap completed (with swap details)", async () => {
            await event.sendTransactionNotification({
                email: "swapper@example.com",
                notice: "✅ Your swap from BTC to USDT was successful.",
                transactionType: "swap",
                transactionId: "SWP-001",
                amount: "0.01",
                currency: "BTC",
                status: "completed",
                date: "2026-04-16T13:00:00Z",
                fromAmount: "0.01",
                fromCurrency: "BTC",
                toAmount: "500",
                toCurrency: "USDT",
                exchangeRate: "1 BTC = 50000 USDT",
            });

            const { merge_info } = emailService.sendMailWithTemplate.mock.calls[0][0];
            expect(merge_info.header).toBe("Swap Completed");
            expect(merge_info.from_amount).toBe("0.01");
            expect(merge_info.from_currency).toBe("BTC");
            expect(merge_info.to_amount).toBe("500");
            expect(merge_info.to_currency).toBe("USDT");
        });

        it("swap failed", async () => {
            await event.sendTransactionNotification({
                email: "swapper@example.com",
                notice: "❌ Your swap from ETH to USDC failed.",
                transactionType: "swap",
                transactionId: "SWP-002",
                amount: "1",
                currency: "ETH",
                status: "failed",
                date: "2026-04-16T13:30:00Z",
            });

            const { merge_info } = emailService.sendMailWithTemplate.mock.calls[0][0];
            expect(merge_info.header).toBe("Swap Failed");
        });

        it("swap processing", async () => {
            await event.sendTransactionNotification({
                email: "swapper@example.com",
                notice: "⏳ Your swap is being processed.",
                transactionType: "swap",
                transactionId: "SWP-003",
                amount: "100",
                currency: "USDT",
                status: "processing",
                date: "2026-04-16T13:45:00Z",
            });

            const { merge_info } = emailService.sendMailWithTemplate.mock.calls[0][0];
            expect(merge_info.header).toBe("Swap Processing");
        });

        it("buy order expired (cancelled by system)", async () => {
            await event.sendTransactionNotification({
                email: "buyer@example.com",
                notice: "⏰ Your buy order of 50 USDT has expired.",
                transactionType: "buy",
                transactionId: "BUY-003",
                amount: "50",
                currency: "USDT",
                status: "cancelled",
                date: "2026-04-16T03:00:00Z",
                orderReference: "ORD-EXP456",
            });

            const { merge_info } = emailService.sendMailWithTemplate.mock.calls[0][0];
            expect(merge_info.header).toBe("Purchase Cancelled");
            expect(merge_info.order_reference).toBe("ORD-EXP456");
        });
    });

    // ─── Constant merge_info fields ────────────────────────────────

    describe("constant merge_info fields", () => {
        it("always includes team, from address, and template key", async () => {
            await event.sendTransactionNotification(basePayload);

            expect(emailService.sendMailWithTemplate).toHaveBeenCalledWith(
                expect.objectContaining({
                    from: { address: "noreply@example.com" },
                    to: [{ email_address: { address: "user@example.com" } }],
                    template_key: "transaction-template",
                    merge_info: expect.objectContaining({
                        team: "Flipxer",
                    }),
                })
            );
        });
    });
});
