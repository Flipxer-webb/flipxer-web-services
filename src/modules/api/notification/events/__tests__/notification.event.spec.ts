jest.mock("@/config", () => ({
    mailConfig: { senderMail: "noreply@example.com" },
    emailTemplateConfig: {
        transaction_notification: "transaction-template",
        transaction_failed: "transaction-failed-template",
        login_notification: "login-notification-template",
    },
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
            const loggerSpy = jest
                .spyOn((event as any).logger, "warn")
                .mockImplementation();

            await event.sendTransactionNotification({
                ...basePayload,
                transactionType: "unknown_type" as any,
                status: "unknown_status",
            });

            expect(emailService.sendMailWithTemplate).not.toHaveBeenCalled();
            expect(loggerSpy).toHaveBeenCalledWith(
                expect.stringContaining("Invalid status"),
            );
            loggerSpy.mockRestore();
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

    // ─── Status Validation ──────────────────────────────────────────
    // Critical for preventing incorrect emails from being sent

    describe("status validation and normalization", () => {
        it("rejects invalid status with warning log", async () => {
            const loggerSpy = jest.spyOn((event as any).logger, "warn").mockImplementation();

            await event.sendTransactionNotification({
                ...basePayload,
                status: "invalid_status",
            });

            expect(loggerSpy).toHaveBeenCalledWith(
                expect.stringContaining("Invalid status")
            );
            expect(emailService.sendMailWithTemplate).not.toHaveBeenCalled();

            loggerSpy.mockRestore();
        });

        it("rejects invalid transaction type with warning log", async () => {
            const loggerSpy = jest.spyOn((event as any).logger, "warn").mockImplementation();

            await event.sendTransactionNotification({
                ...basePayload,
                transactionType: "invalid_type" as any,
            });

            expect(loggerSpy).toHaveBeenCalledWith(
                expect.stringContaining("Invalid type")
            );
            expect(emailService.sendMailWithTemplate).not.toHaveBeenCalled();

            loggerSpy.mockRestore();
        });

        it("normalizes mixed-case status internally", async () => {
            await event.sendTransactionNotification({
                ...basePayload,
                status: "FAILED",
            });

            expect(emailService.sendMailWithTemplate).toHaveBeenCalledWith(
                expect.objectContaining({
                    merge_info: expect.objectContaining({
                        status: "failed",  // Normalized to lowercase
                    }),
                })
            );
        });

        it("normalizes mixed-case transaction type internally", async () => {
            await event.sendTransactionNotification({
                ...basePayload,
                transactionType: " BUY " as any,
            });

            expect(emailService.sendMailWithTemplate).toHaveBeenCalledWith(
                expect.objectContaining({
                    merge_info: expect.objectContaining({
                        header: "Purchase Completed",
                        transaction_type: "buy",
                    }),
                })
            );
        });

        it("trims whitespace from status", async () => {
            await event.sendTransactionNotification({
                ...basePayload,
                status: "  completed  " as any,
            });

            expect(emailService.sendMailWithTemplate).toHaveBeenCalledWith(
                expect.objectContaining({
                    merge_info: expect.objectContaining({
                        status: "completed",
                    }),
                })
            );
        });

        it("all valid statuses pass validation", async () => {
            const validStatuses = ["completed", "failed", "cancelled", "reversed", "pending", "processing"];

            for (const validStatus of validStatuses) {
                emailService.sendMailWithTemplate.mockClear();

                await event.sendTransactionNotification({
                    ...basePayload,
                    status: validStatus as any,
                });

                expect(emailService.sendMailWithTemplate).toHaveBeenCalledWith(
                    expect.objectContaining({
                        merge_info: expect.objectContaining({
                            status: validStatus,
                        }),
                    })
                );
            }
        });
    });

    // ─── Failed Transaction Tests ──────────────────────────────────
    // CRITICAL: Verify failed transactions send correct email, not success email

    describe("failed transaction handling", () => {
        it("failed deposit sends email with status=failed", async () => {
            await event.sendTransactionNotification({
                email: "user@example.com",
                notice: "❌ Your deposit of 100 BTC failed.",
                transactionType: "deposit" as const,
                transactionId: "DEP-FAILED-001",
                amount: "100",
                currency: "BTC",
                status: "failed",
                date: "2026-04-16T10:00:00Z",
            });

            expect(emailService.sendMailWithTemplate).toHaveBeenCalledWith(
                expect.objectContaining({
                    merge_info: expect.objectContaining({
                        header: "Deposit Failed",
                        status: "failed",
                        notice: expect.stringContaining("failed"),
                    }),
                })
            );
        });

        it("failed buy order sends email with status=failed", async () => {
            await event.sendTransactionNotification({
                email: "buyer@example.com",
                notice: "❌ Your buy order could not be completed.",
                transactionType: "buy" as const,
                transactionId: "BUY-FAILED-001",
                amount: "1",
                currency: "USDT",
                status: "failed",
                date: "2026-04-16T10:00:00Z",
            });

            expect(emailService.sendMailWithTemplate).toHaveBeenCalledWith(
                expect.objectContaining({
                    merge_info: expect.objectContaining({
                        header: "Purchase Failed",
                        status: "failed",
                    }),
                })
            );
        });

        it("failed sell order sends email with status=failed", async () => {
            await event.sendTransactionNotification({
                email: "seller@example.com",
                notice: "❌ Your sell order failed.",
                transactionType: "sell" as const,
                transactionId: "SELL-FAILED-001",
                amount: "50",
                currency: "USDT",
                status: "failed",
                date: "2026-04-16T10:00:00Z",
            });

            expect(emailService.sendMailWithTemplate).toHaveBeenCalledWith(
                expect.objectContaining({
                    merge_info: expect.objectContaining({
                        header: "Sale Failed",
                        status: "failed",
                    }),
                })
            );
        });

        it("failed swap sends email with status=failed", async () => {
            await event.sendTransactionNotification({
                email: "swapper@example.com",
                notice: "❌ Your swap failed.",
                transactionType: "swap" as const,
                transactionId: "SWP-FAILED-001",
                amount: "1",
                currency: "ETH",
                status: "failed",
                date: "2026-04-16T10:00:00Z",
            });

            expect(emailService.sendMailWithTemplate).toHaveBeenCalledWith(
                expect.objectContaining({
                    merge_info: expect.objectContaining({
                        header: "Swap Failed",
                        status: "failed",
                    }),
                })
            );
        });

        it("failed withdrawal sends email with status=failed", async () => {
            await event.sendTransactionNotification({
                email: "withdrawer@example.com",
                notice: "❌ Your withdrawal failed.",
                transactionType: "withdrawal" as const,
                transactionId: "WDR-FAILED-001",
                amount: "0.5",
                currency: "BTC",
                status: "failed",
                date: "2026-04-16T10:00:00Z",
            });

            expect(emailService.sendMailWithTemplate).toHaveBeenCalledWith(
                expect.objectContaining({
                    merge_info: expect.objectContaining({
                        header: "Withdrawal Failed",
                        status: "failed",
                    }),
                })
            );
        });

        it("failed transaction does NOT send as completed", async () => {
            await event.sendTransactionNotification({
                ...basePayload,
                status: "failed",
            });

            const { merge_info } = emailService.sendMailWithTemplate.mock.calls[0][0];
            expect(merge_info.status).toBe("failed");
            expect(merge_info.status).not.toBe("completed");
            expect(merge_info.header).not.toContain("Completed");
        });
    });

    // ─── Logging Tests ──────────────────────────────────────────────

    describe("transaction email logging", () => {
        it("logs transaction email sending with details", async () => {
            const loggerSpy = jest.spyOn((event as any).logger, "log").mockImplementation();

            await event.sendTransactionNotification({
                email: "user@example.com",
                notice: "Test",
                transactionType: "buy" as const,
                transactionId: "TXN-123",
                amount: "100",
                currency: "USDT",
                status: "completed",
                date: "2026-04-16T10:00:00Z",
            });

            // Verify first log call (sending attempt)
            expect(loggerSpy).toHaveBeenCalledWith(
                expect.stringContaining("[TransactionEmail]")
            );
            expect(loggerSpy).toHaveBeenCalledWith(
                expect.stringContaining("txId=TXN-123")
            );
            expect(loggerSpy).toHaveBeenCalledWith(
                expect.stringContaining("type=buy")
            );
            expect(loggerSpy).toHaveBeenCalledWith(
                expect.stringContaining("status=completed")
            );
            expect(loggerSpy).toHaveBeenCalledWith(
                expect.stringContaining("recipient=user@example.com")
            );

            loggerSpy.mockRestore();
        });

        it("logs successful send completion", async () => {
            const loggerSpy = jest.spyOn((event as any).logger, "log").mockImplementation();

            await event.sendTransactionNotification(basePayload);

            // Verify success log contains "Sent successfully"
            const logs = loggerSpy.mock.calls.map((call) => call[0]);
            const successLog = logs.find((log: string) => log.includes("Sent successfully"));
            expect(successLog).toBeDefined();

            loggerSpy.mockRestore();
        });

        it("logs error when email service fails", async () => {
            const error = new Error("Email service down");
            emailService.sendMailWithTemplate.mockRejectedValue(error);
            const loggerSpy = jest.spyOn((event as any).logger, "error").mockImplementation();

            await event.sendTransactionNotification(basePayload);

            expect(loggerSpy).toHaveBeenCalledWith(
                expect.stringContaining("[TransactionEmail]")
            );
            expect(loggerSpy).toHaveBeenCalledWith(
                expect.stringContaining("Email service down")
            );

            loggerSpy.mockRestore();
        });

        it("logs when email service throws (non-Error)", async () => {
            emailService.sendMailWithTemplate.mockRejectedValue("mail service error");
            const loggerSpy = jest.spyOn((event as any).logger, "error").mockImplementation();

            await event.sendTransactionNotification(basePayload);

            expect(loggerSpy).toHaveBeenCalled();

            loggerSpy.mockRestore();
        });
    });

    // ─── Required Field Validation ──────────────────────────────────

    describe("required field validation", () => {
        it("skips send if email is missing", async () => {
            const loggerSpy = jest.spyOn((event as any).logger, "warn").mockImplementation();

            await event.sendTransactionNotification({
                ...basePayload,
                email: "",
            });

            expect(loggerSpy).toHaveBeenCalledWith(
                expect.stringContaining("Missing email")
            );
            expect(emailService.sendMailWithTemplate).not.toHaveBeenCalled();

            loggerSpy.mockRestore();
        });

        it("skips send if email is whitespace only", async () => {
            const loggerSpy = jest.spyOn((event as any).logger, "warn").mockImplementation();

            await event.sendTransactionNotification({
                ...basePayload,
                email: "   " as any,
            });

            expect(loggerSpy).toHaveBeenCalledWith(
                expect.stringContaining("Missing email")
            );
            expect(emailService.sendMailWithTemplate).not.toHaveBeenCalled();

            loggerSpy.mockRestore();
        });

        it("skips send if transactionId is missing", async () => {
            const loggerSpy = jest.spyOn((event as any).logger, "warn").mockImplementation();

            await event.sendTransactionNotification({
                ...basePayload,
                transactionId: "",
            });

            expect(loggerSpy).toHaveBeenCalledWith(
                expect.stringContaining("Missing transactionId")
            );
            expect(emailService.sendMailWithTemplate).not.toHaveBeenCalled();

            loggerSpy.mockRestore();
        });

        it("skips send if status is missing", async () => {
            const loggerSpy = jest.spyOn((event as any).logger, "warn").mockImplementation();

            await event.sendTransactionNotification({
                ...basePayload,
                status: "" as any,
            });

            expect(loggerSpy).toHaveBeenCalledWith(
                expect.stringContaining("Invalid status")
            );
            expect(emailService.sendMailWithTemplate).not.toHaveBeenCalled();

            loggerSpy.mockRestore();
        });

        // Test that template_key is never undefined
        it("never sends email with undefined template_key", async () => {
            await event.sendTransactionNotification({
                ...basePayload,
                status: "failed",
            });
            
            const call = emailService.sendMailWithTemplate.mock.calls[0][0];
            expect(call.template_key).toBeDefined();
            expect(call.template_key).not.toBe("");
        });

        // Test that unknown status doesn't send email at all
        it("does not send email for completely unknown status", async () => {
            const loggerSpy = jest.spyOn((event as any).logger, "warn").mockImplementation();
            
            await event.sendTransactionNotification({
                ...basePayload,
                status: "gibberish_123" as any,
            });
            
            expect(emailService.sendMailWithTemplate).not.toHaveBeenCalled();
            loggerSpy.mockRestore();
        });

        // Test field type validation (amount is string, not number)
        it("handles numeric amount as string", async () => {
            await event.sendTransactionNotification({
                ...basePayload,
                amount: "123.45" as any,
            });
            
            expect(emailService.sendMailWithTemplate).toHaveBeenCalled();
        });
    });

    describe("template selection based on status", () => {
        it("always uses transaction_notification template regardless of status", async () => {
            await event.sendTransactionNotification({
                ...basePayload,
                status: "completed",
            });
            expect(emailService.sendMailWithTemplate).toHaveBeenCalledWith(
                expect.objectContaining({
                    template_key: "transaction-template",
                })
            );
        });

        it("still uses transaction_notification template for failed status", async () => {
            await event.sendTransactionNotification({
                ...basePayload,
                status: "failed",
            });
            expect(emailService.sendMailWithTemplate).toHaveBeenCalledWith(
                expect.objectContaining({
                    template_key: "transaction-template",
                })
            );
        });

        it("still uses transaction_notification template for reversed status", async () => {
            await event.sendTransactionNotification({
                ...basePayload,
                status: "reversed",
            });
            expect(emailService.sendMailWithTemplate).toHaveBeenCalledWith(
                expect.objectContaining({
                    template_key: "transaction-template",
                })
            );
        });

        it("still uses transaction_notification template for cancelled status", async () => {
            await event.sendTransactionNotification({
                ...basePayload,
                status: "cancelled",
            });
            expect(emailService.sendMailWithTemplate).toHaveBeenCalledWith(
                expect.objectContaining({
                    template_key: "transaction-template",
                })
            );
        });

        it("still uses transaction_notification template for pending status", async () => {
            await event.sendTransactionNotification({
                ...basePayload,
                status: "pending",
            });
            expect(emailService.sendMailWithTemplate).toHaveBeenCalledWith(
                expect.objectContaining({
                    template_key: "transaction-template",
                })
            );
        });

        it("still uses transaction_notification template for processing status", async () => {
            await event.sendTransactionNotification({
                ...basePayload,
                status: "processing",
            });
            expect(emailService.sendMailWithTemplate).toHaveBeenCalledWith(
                expect.objectContaining({
                    template_key: "transaction-template",
                })
            );
        });
    });

    // ─── Login Notification Tests ─────────────────────────────────────

    describe("login notification", () => {
        const baseLoginPayload = {
            email: "user@example.com",
            userId: 123,
            name: "John Doe",
            ipAddress: "192.168.1.100",
            userAgent: "Chrome on Windows",
            loginTime: "2026-04-28T10:30:00Z",
            location: "Lagos, Nigeria",
        };

        it("sends login notification email successfully", async () => {
            await event.sendLoginNotification(baseLoginPayload);

            expect(emailService.sendMailWithTemplate).toHaveBeenCalledTimes(1);
            expect(emailService.sendMailWithTemplate).toHaveBeenCalledWith(
                expect.objectContaining({
                    from: { address: "noreply@example.com" },
                    to: [{ email_address: { address: "user@example.com" } }],
                    template_key: "login-notification-template",
                    merge_info: expect.objectContaining({
                        name: "John Doe",
                        ip_address: "192.168.1.100",
                        user_agent: "Chrome on Windows",
                        account_security_url: "https://app.flipxer.com/security",
                        current_year: new Date().getFullYear().toString(),
                    }),
                })
            );
        });

        it("uses default userAgent when not provided", async () => {
    const payload = { ...baseLoginPayload, userAgent: undefined };
    await event.sendLoginNotification(payload);

    const call = emailService.sendMailWithTemplate.mock.calls[0][0];
    expect(call.merge_info.user_agent).toBe("Unknown");  // ← Changed
        });

        it("uses default userAgent when empty string", async () => {
            const payload = { ...baseLoginPayload, userAgent: "" };
            await event.sendLoginNotification(payload);

            const call = emailService.sendMailWithTemplate.mock.calls[0][0];
            expect(call.merge_info.user_agent).toBe("Unknown");  // ← Changed
        });

        it("formats login_time as locale string", async () => {
            await event.sendLoginNotification(baseLoginPayload);

            const call = emailService.sendMailWithTemplate.mock.calls[0][0];
            // Should NOT be the raw ISO string
            expect(call.merge_info.login_time).not.toBe(baseLoginPayload.loginTime);
            // Should be a string (the formatted date)
            expect(typeof call.merge_info.login_time).toBe("string");
            // Should contain date components (year, month, day, time)
            expect(call.merge_info.login_time).toMatch(/\d{1,2}\/\d{1,2}\/\d{4}/); // matches DD/MM/YYYY or MM/DD/YYYY
        });

        it("includes current year in footer", async () => {
            await event.sendLoginNotification(baseLoginPayload);

            const call = emailService.sendMailWithTemplate.mock.calls[0][0];
            expect(call.merge_info.current_year).toBe(
                new Date().getFullYear().toString()
            );
        });

        it("logs warning when login_notification template is not configured", async () => {
            const originalTemplate = require("@/config").emailTemplateConfig.login_notification;
            require("@/config").emailTemplateConfig.login_notification = undefined;

            const loggerSpy = jest.spyOn((event as any).logger, "warn").mockImplementation();

            await event.sendLoginNotification(baseLoginPayload);

            expect(loggerSpy).toHaveBeenCalledWith(
                expect.stringContaining("Login notification template not configured")
            );
            expect(emailService.sendMailWithTemplate).not.toHaveBeenCalled();

            loggerSpy.mockRestore();
            require("@/config").emailTemplateConfig.login_notification = originalTemplate;
        });

        it("handles email service failure gracefully", async () => {
            emailService.sendMailWithTemplate.mockRejectedValue(new Error("Email service down"));
            const loggerSpy = jest.spyOn((event as any).logger, "error").mockImplementation();

            await event.sendLoginNotification(baseLoginPayload);

            expect(loggerSpy).toHaveBeenCalledWith(
                expect.stringContaining("Failed to send")
            );
            expect(loggerSpy).toHaveBeenCalledWith(
                expect.stringContaining("user@example.com")
            );

            loggerSpy.mockRestore();
        });

        it("handles non-Error exceptions", async () => {
            emailService.sendMailWithTemplate.mockRejectedValue("String error");
            const loggerSpy = jest.spyOn((event as any).logger, "error").mockImplementation();

            await event.sendLoginNotification(baseLoginPayload);

            expect(loggerSpy).toHaveBeenCalledWith(
                expect.stringContaining("String error")
            );

            loggerSpy.mockRestore();
        });

        it("handles null exceptions without throwing inside catch", async () => {
            emailService.sendMailWithTemplate.mockRejectedValue(null);
            const loggerSpy = jest.spyOn((event as any).logger, "error").mockImplementation();

            await expect(event.sendLoginNotification(baseLoginPayload)).resolves.toBeUndefined();
            expect(loggerSpy).toHaveBeenCalledWith(
                expect.stringContaining("null")
            );

            loggerSpy.mockRestore();
        });

        it("serializes object exceptions without logging [object Object]", async () => {
            emailService.sendMailWithTemplate.mockRejectedValue({ detail: "SMTP failed", retryable: false });
            const loggerSpy = jest.spyOn((event as any).logger, "error").mockImplementation();

            await expect(event.sendLoginNotification(baseLoginPayload)).resolves.toBeUndefined();
            expect(loggerSpy).toHaveBeenCalledWith(
                expect.stringContaining('{"detail":"SMTP failed","retryable":false}')
            );

            loggerSpy.mockRestore();
        });

        it("emits login_notification event and triggers email", async () => {
            event.emit("login_notification", baseLoginPayload);
            await new Promise((resolve) => setTimeout(resolve, 100));

            expect(emailService.sendMailWithTemplate).toHaveBeenCalled();
        });

        it("has login_notification listener registered", () => {
            const listeners = event.listeners("login_notification");
            expect(listeners.length).toBeGreaterThan(0);
        });

        it("handles missing location gracefully", async () => {
            const payload = { ...baseLoginPayload, location: undefined };
            await event.sendLoginNotification(payload);

            expect(emailService.sendMailWithTemplate).toHaveBeenCalled();
            const call = emailService.sendMailWithTemplate.mock.calls[0][0];
            expect(call.merge_info).toBeDefined();
        });

        it("handles IPv6 address", async () => {
            const payload = {
                ...baseLoginPayload,
                ipAddress: "2001:0db8:85a3:0000:0000:8a2e:0370:7334",
            };
            await event.sendLoginNotification(payload);

            const call = emailService.sendMailWithTemplate.mock.calls[0][0];
            expect(call.merge_info.ip_address).toBe("2001:0db8:85a3:0000:0000:8a2e:0370:7334");
        });

       it("logs successful send", async () => {
            const loggerSpy = jest.spyOn((event as any).logger, "log").mockImplementation();

            await event.sendLoginNotification(baseLoginPayload);

            expect(loggerSpy).toHaveBeenCalledWith(
                expect.stringContaining("[LoginNotification] Sending login notification to")
            );
            expect(loggerSpy).toHaveBeenCalledWith(
                expect.stringContaining("[LoginNotification] Sent successfully")
            );

            loggerSpy.mockRestore();
        });
    });
});
