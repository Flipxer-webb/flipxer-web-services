import { Logger } from "@nestjs/common";
import { Request } from "express";
import { createHmac, timingSafeEqual } from "node:crypto";

import { fincraOptions, nombaOptions } from "@/config";

type WebhookLogger = Pick<Logger, "debug" | "error" | "log" | "warn">;
type WebhookHeaders = Request["headers"] | Record<string, unknown>;

export class PaymentWebhookVerifier {
    static verifyFincraRequest(
        request: Request,
        logger: WebhookLogger,
    ): boolean {
        const signature = this.getHeaderValue(request.headers, [
            "signature",
            "x-fincra-signature",
        ]);
        const secret = process.env.FINCRA_WEBHOOK_SECRET || fincraOptions.webhookSecret;
        const webhookEvent = this.getWebhookEventName(request.body);

        if (!signature) {
            logger.error("SECURITY: Fincra webhook rejected - no signature header");
            return false;
        }

        if (!secret) {
            logger.error("SECURITY: FINCRA_WEBHOOK_SECRET not configured - rejecting webhook");
            return false;
        }

        const bodyBuffer = this.getRequestBodyBuffer(
            (request as Request & { rawBody?: Buffer | string }).rawBody,
            request.body,
        );

        const computedSignature = createHmac("sha512", secret)
            .update(bodyBuffer)
            .digest("hex");

        const isValid = this.compareSignatures(
            computedSignature,
            signature,
            logger,
            `Fincra event ${webhookEvent ?? "unknown"}`,
        );

        if (isValid) {
            logger.log(`Signature verified for event: ${webhookEvent ?? "unknown"}`);
        } else {
            logger.error("SECURITY: Fincra webhook rejected - invalid signature");
        }

        return isValid;
    }

    static verifyNombaRequest(
        body: unknown,
        headers: WebhookHeaders,
        logger: WebhookLogger,
    ): boolean {
        if (this.isVerificationProbe(body)) {
            logger.log("Received webhook verification/test request from Nomba");
            return true;
        }

        const signature = this.getHeaderValue(headers, [
            "nomba-signature",
            "nomba-sig-value",
            "x-nomba-signature",
        ]);
        const timestamp = this.getHeaderValue(headers, ["nomba-timestamp"]) || "";
        const webhookSecret = nombaOptions?.webhookSecret || process.env.NOMBA_WEBHOOK_SECRET;

        if (!signature) {
            logger.error("SECURITY: Nomba webhook rejected - missing signature header");
            return false;
        }

        if (!webhookSecret) {
            logger.error("SECURITY: Nomba webhook secret not configured - rejecting webhook");
            return false;
        }

        const payload = this.getNombaHashingPayload(body, timestamp);
        logger.debug(`[SIG] Hashing payload: ${payload}`);

        const expectedSignature = createHmac("sha256", webhookSecret)
            .update(payload)
            .digest("base64");

        logger.debug(
            `[SIG] Expected: ${expectedSignature.slice(0, 16)}... Received: ${signature.slice(0, 16)}...`,
        );

        return this.compareSignatures(
            expectedSignature,
            signature,
            logger,
            `Nomba event ${this.getWebhookEventName(body) ?? "unknown"}`,
        );
    }

    private static compareSignatures(
        expectedSignature: string,
        providedSignature: string,
        logger: WebhookLogger,
        context: string,
    ): boolean {
        try {
            const providedBuffer = Buffer.from(providedSignature, "utf8");
            const expectedBuffer = Buffer.from(expectedSignature, "utf8");

            if (providedBuffer.length !== expectedBuffer.length) {
                logger.error(`[SIG] Length mismatch for ${context}: received=${providedBuffer.length}, expected=${expectedBuffer.length}`);
                return false;
            }

            return timingSafeEqual(providedBuffer, expectedBuffer);
        } catch (error) {
            logger.error(`[SIG] Error comparing signature for ${context}: ${String(error)}`);
            return false;
        }
    }

    private static getRequestBodyBuffer(rawBody: Buffer | string | undefined, body: unknown): Buffer {
        if (rawBody) {
            return Buffer.isBuffer(rawBody)
                ? rawBody
                : Buffer.from(rawBody);
        }

        return Buffer.from(JSON.stringify(body ?? {}));
    }

    private static getHeaderValue(headers: WebhookHeaders, names: string[]): string | undefined {
        const normalizedHeaders = new Map<string, unknown>();

        for (const [key, value] of Object.entries(headers || {})) {
            normalizedHeaders.set(key.toLowerCase(), value);
        }

        for (const name of names) {
            const value = normalizedHeaders.get(name.toLowerCase());

            if (Array.isArray(value)) {
                return typeof value[0] === "string" ? value[0] : undefined;
            }

            if (typeof value === "string") {
                return value;
            }
        }

        return undefined;
    }

    private static getWebhookEventName(body: unknown): string | undefined {
        if (!body || typeof body !== "object") {
            return undefined;
        }

        const eventType = (body as { event_type?: unknown }).event_type;
        if (typeof eventType === "string") {
            return eventType;
        }

        const event = (body as { event?: unknown }).event;
        return typeof event === "string" ? event : undefined;
    }

    private static isVerificationProbe(body: unknown): boolean {
        return !this.getWebhookEventName(body);
    }

    private static getNombaHashingPayload(body: unknown, timestamp: string): string {
        const normalizedBody = typeof body === "object" && body ? body as Record<string, any> : {};
        const data = normalizedBody.data || {};
        const merchant = data.merchant || {};
        const transaction = data.transaction || {};

        let responseCode = transaction.responseCode ?? "";
        if (responseCode === "null") {
            responseCode = "";
        }

        return [
            normalizedBody.event_type || normalizedBody.event || "",
            normalizedBody.requestId || normalizedBody.request_id || "",
            merchant.userId || "",
            merchant.walletId || "",
            transaction.transactionId || "",
            transaction.type || "",
            transaction.time || "",
            responseCode,
            timestamp || "",
        ].join(":");
    }
}