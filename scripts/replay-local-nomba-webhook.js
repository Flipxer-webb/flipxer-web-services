#!/usr/bin/env node

const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const DEFAULTS = {
    apiUrl: "http://127.0.0.1:3501/api/v1/webhooks/nomba",
    container: "flipxer-api",
    eventType: "payment_success",
};

function printUsage() {
    console.log(`Local Nomba webhook replay helper

Usage:
  node scripts/replay-local-nomba-webhook.js --reference <payment-reference>
  node scripts/replay-local-nomba-webhook.js --latest-pending-buy

Options:
  --reference <ref>           Replay against a specific Payment.reference
  --latest-pending-buy        Auto-pick the newest pending BUY payment in local Docker
  --amount <ngn>             Override the payment amount instead of using Payment.totalAmount
  --api-url <url>            Webhook URL to call (default: ${DEFAULTS.apiUrl})
  --container <name>         Docker container name to inspect (default: ${DEFAULTS.container})
  --allow-non-pending        Allow replay even if the payment/order is no longer pending
  --dry-run                  Print the resolved payload and exit without POSTing
  --help                     Show this help

Examples:
  node scripts/replay-local-nomba-webhook.js --reference 0hce2gcch26863fa1g68b4505ad093
  node scripts/replay-local-nomba-webhook.js --latest-pending-buy
  node scripts/replay-local-nomba-webhook.js --reference 0hce2gcch26863fa1g68b4505ad093 --dry-run
`);
}

function fail(message) {
    console.error(`ERROR: ${message}`);
    process.exit(1);
}

function parseArgs(argv) {
    const options = {
        apiUrl: DEFAULTS.apiUrl,
        container: DEFAULTS.container,
        eventType: DEFAULTS.eventType,
        allowNonPending: false,
        dryRun: false,
        latestPendingBuy: false,
        reference: null,
        amount: null,
    };

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];

        switch (arg) {
            case "--reference":
                options.reference = argv[index + 1] || null;
                index += 1;
                break;
            case "--amount":
                options.amount = Number(argv[index + 1]);
                index += 1;
                break;
            case "--api-url":
                options.apiUrl = argv[index + 1] || DEFAULTS.apiUrl;
                index += 1;
                break;
            case "--container":
                options.container = argv[index + 1] || DEFAULTS.container;
                index += 1;
                break;
            case "--allow-non-pending":
                options.allowNonPending = true;
                break;
            case "--dry-run":
                options.dryRun = true;
                break;
            case "--latest-pending-buy":
                options.latestPendingBuy = true;
                break;
            case "--help":
            case "-h":
                printUsage();
                process.exit(0);
                break;
            default:
                fail(`Unknown argument: ${arg}`);
        }
    }

    if (!options.reference && !options.latestPendingBuy) {
        fail("Pass --reference <payment-reference> or --latest-pending-buy");
    }

    if (options.reference && options.latestPendingBuy) {
        fail("Use either --reference or --latest-pending-buy, not both");
    }

    if (options.amount !== null && Number.isNaN(options.amount)) {
        fail("--amount must be a valid number");
    }

    return options;
}

function dockerExec(container, command, input) {
    const args = ["exec"];

    if (typeof input === "string") {
        args.push("-i");
    }

    args.push(container, ...command);

    const result = spawnSync("docker", args, {
        input,
        encoding: "utf8",
    });

    if (result.error) {
        throw result.error;
    }

    if (result.status !== 0) {
        throw new Error((result.stderr || result.stdout || "docker exec failed").trim());
    }

    return (result.stdout || "").trim();
}

function getWebhookSecret(container) {
    const secret = dockerExec(container, ["printenv", "NOMBA_WEBHOOK_SECRET"]);
    if (!secret) {
        fail(`NOMBA_WEBHOOK_SECRET is empty in container ${container}`);
    }
    return secret;
}

function lookupPayment(container, options) {
    const queryScript = `
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

(async () => {
  const useLatestPending = ${options.latestPendingBuy ? "true" : "false"};
  const reference = ${JSON.stringify(options.reference)};

  const payment = await prisma.payment.findFirst({
    where: useLatestPending
      ? {
          status: "PENDING",
          orderId: { not: null },
          order: { orderCategory: "BUY" },
        }
      : {
          reference,
        },
    orderBy: useLatestPending ? { createdAt: "desc" } : undefined,
    select: {
      id: true,
      reference: true,
      status: true,
      paymentStatus: true,
      totalAmount: true,
      createdAt: true,
      order: {
        select: {
          id: true,
          transactionId: true,
          orderCategory: true,
          status: true,
          paymentStatus: true,
          amount: true,
          currency: true,
          userId: true,
          createdAt: true,
          user: { select: { email: true, tier: true } },
        },
      },
    },
  });

  console.log(JSON.stringify(payment, null, 2));
})()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
`;

    const output = dockerExec(container, ["node", "-"], queryScript);
    if (!output) {
        return null;
    }
    return JSON.parse(output);
}

function ensureReplayableTarget(payment, allowNonPending) {
    if (!payment) {
        fail("No matching payment found");
    }

    if (!payment.order || payment.order.orderCategory !== "BUY") {
        fail(`Payment ${payment.reference} is not attached to a BUY order`);
    }

    if (allowNonPending) {
        return;
    }

    const paymentPending = payment.status === "PENDING" && payment.paymentStatus === "PENDING";
    const orderPending = payment.order.status === "pending" && payment.order.paymentStatus === "PENDING";

    if (!paymentPending || !orderPending) {
        fail(
            `Payment ${payment.reference} is not pending. ` +
            `Payment=${payment.status}/${payment.paymentStatus}, ` +
            `Order=${payment.order.status}/${payment.order.paymentStatus}. ` +
            `Use --allow-non-pending only for idempotency tests.`,
        );
    }
}

function buildPayload(reference, amount) {
    const requestId = `replay-${Date.now()}`;
    const transactionId = `replay-txn-${Date.now()}`;
    const transactionTime = new Date().toISOString();

    return {
        requestId,
        transactionId,
        timestamp: String(Math.floor(Date.now() / 1000)),
        body: {
            event_type: "payment_success",
            requestId,
            data: {
                merchant: {
                    userId: "local-replay-merchant",
                    walletId: "local-replay-wallet",
                    walletBalance: 0,
                },
                terminal: {},
                transaction: {
                    type: "vact_transfer",
                    transactionId,
                    transactionAmount: amount,
                    narration: `Local replay for ${reference}`,
                    time: transactionTime,
                    aliasAccountReference: reference,
                },
                customer: {
                    senderName: "Local Replay",
                    bankName: "Replay Bank",
                    accountNumber: "0000000000",
                },
            },
        },
    };
}

function signPayload(webhookSecret, payloadEnvelope) {
    const transaction = payloadEnvelope.body.data.transaction;
    const merchant = payloadEnvelope.body.data.merchant;

    const hashingPayload = [
        payloadEnvelope.body.event_type,
        payloadEnvelope.body.requestId,
        merchant.userId,
        merchant.walletId,
        transaction.transactionId,
        transaction.type,
        transaction.time,
        "",
        payloadEnvelope.timestamp,
    ].join(":");

    const signature = crypto
        .createHmac("sha256", webhookSecret)
        .update(hashingPayload)
        .digest("base64");

    return {
        hashingPayload,
        signature,
    };
}

async function postWebhook(apiUrl, payloadEnvelope, signature) {
    const response = await fetch(apiUrl, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            "nomba-signature": signature,
            "nomba-timestamp": payloadEnvelope.timestamp,
        },
        body: JSON.stringify(payloadEnvelope.body),
    });

    return {
        status: response.status,
        ok: response.ok,
        body: await response.text(),
    };
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    const payment = lookupPayment(options.container, options);

    ensureReplayableTarget(payment, options.allowNonPending);

    const amount = options.amount ?? Number(payment.totalAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
        fail(`Resolved amount is invalid for payment ${payment.reference}: ${payment.totalAmount}`);
    }

    const webhookSecret = getWebhookSecret(options.container);
    const payloadEnvelope = buildPayload(payment.reference, amount);
    const { hashingPayload, signature } = signPayload(webhookSecret, payloadEnvelope);

    const summary = {
        apiUrl: options.apiUrl,
        container: options.container,
        reference: payment.reference,
        amount,
        paymentId: payment.id,
        paymentStatus: `${payment.status}/${payment.paymentStatus}`,
        orderId: payment.order.id,
        orderTransactionId: payment.order.transactionId,
        orderStatus: `${payment.order.status}/${payment.order.paymentStatus}`,
        userId: payment.order.userId,
        userEmail: payment.order.user?.email || null,
        dryRun: options.dryRun,
        requestId: payloadEnvelope.requestId,
        replayTransactionId: payloadEnvelope.transactionId,
    };

    console.log("=== Local Nomba Replay Target ===");
    console.log(JSON.stringify(summary, null, 2));

    if (options.dryRun) {
        console.log("\n=== Dry Run Payload ===");
        console.log(JSON.stringify({
            timestamp: payloadEnvelope.timestamp,
            signaturePreview: `${signature.slice(0, 16)}...`,
            hashingPayload,
            body: payloadEnvelope.body,
        }, null, 2));
        return;
    }

    const response = await postWebhook(options.apiUrl, payloadEnvelope, signature);

    console.log("\n=== Webhook Response ===");
    console.log(JSON.stringify(response, null, 2));

    if (!response.ok) {
        process.exitCode = 1;
    }
}

main().catch((error) => {
    fail(error.message);
});