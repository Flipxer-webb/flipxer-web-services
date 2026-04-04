#!/bin/bash
#
# Script to trigger payment processing via Fincra webhook simulation
# 
# This script simulates a Fincra webhook call to trigger the paymentSuccessHandler
# which will complete the buy order and initiate Quidax withdrawal.
#
# IMPORTANT: This script must be run on the Render server where FINCRA_WEBHOOK_SECRET is available
#
# Usage: Run in Render Shell:
#   bash trigger-payment.sh 234b973aaca7h9bfege693
#

# Payment reference (passed as argument or hardcoded here)
PAYMENT_REFERENCE=${1:-"234b973aaca7h9bfege693"}

# The API endpoint
API_URL="https://flipxer-api.onrender.com/api/webhook/fincra"

# Get the webhook secret from environment (only available on Render)
WEBHOOK_SECRET="${FINCRA_WEBHOOK_SECRET}"

if [ -z "$WEBHOOK_SECRET" ]; then
    echo "ERROR: FINCRA_WEBHOOK_SECRET environment variable is not set"
    echo "This script must be run on the Render server"
    exit 1
fi

# Create the webhook payload (simulating Fincra collection.successful event)
PAYLOAD=$(cat <<EOF
{
    "event": "collection.successful",
    "data": {
        "merchantReference": "${PAYMENT_REFERENCE}",
        "reference": "fincra-ref-manual-${PAYMENT_REFERENCE}",
        "status": "success",
        "amount": 14500,
        "amountReceived": 14500,
        "fee": 0,
        "currency": "NGN"
    }
}
EOF
)

echo "=== Fincra Webhook Simulation ==="
echo "Payment Reference: ${PAYMENT_REFERENCE}"
echo "Payload: ${PAYLOAD}"
echo ""

# Compute the signature (SHA512 HMAC)
SIGNATURE=$(echo -n "${PAYLOAD}" | openssl dgst -sha512 -hmac "${WEBHOOK_SECRET}" | awk '{print $2}')

echo "Computed Signature: ${SIGNATURE:0:40}..."
echo ""
echo "Making POST request to: ${API_URL}"
echo ""

# Make the webhook call
RESPONSE=$(curl -s -X POST "${API_URL}" \
    -H "Content-Type: application/json" \
    -H "x-fincra-signature: ${SIGNATURE}" \
    -d "${PAYLOAD}")

echo "=== Response ==="
echo "${RESPONSE}"
echo ""

# Check if successful
if echo "${RESPONSE}" | grep -q "success"; then
    echo "✅ Webhook processed successfully!"
    echo "The Quidax withdrawal should now be initiated."
else
    echo "❌ Webhook processing may have failed. Check the response above."
fi
