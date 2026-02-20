/**
 * Nigerian bank USSD transfer code mappings.
 *
 * Format placeholders:
 *   {amount}  — transfer amount in Naira (integer)
 *   {account} — destination account number
 *
 * The codes used here are standard bank transfer USSD shortcodes.
 * Banks without a known format are omitted — callers should treat
 * a `null` return as "USSD not available for this bank".
 */

const USSD_CODE_MAP: Record<string, string> = {
    // GTBank
    "058": "*737*2*{amount}*{account}#",
    // Access Bank / Diamond
    "044": "*901*{amount}*{account}#",
    // UBA
    "033": "*919*4*{account}*{amount}#",
    // First Bank
    "011": "*894*{amount}*{account}#",
    // Zenith Bank
    "057": "*966*{amount}*{account}#",
    // Fidelity Bank
    "070": "*770*{amount}*{account}#",
    // Sterling Bank
    "232": "*822*{amount}*{account}#",
    // Unity Bank
    "215": "*7799*{amount}*{account}#",
    // Stanbic IBTC
    "221": "*909*22*{amount}*{account}#",
    // Wema Bank / ALAT
    "035": "*945*{amount}*{account}#",
    // Keystone Bank
    "082": "*7111*{amount}*{account}#",
    // FCMB
    "214": "*329*{amount}*{account}#",
    // Union Bank
    "032": "*826*{amount}*{account}#",
    // Ecobank
    "050": "*326*{amount}*{account}#",
    // Polaris Bank (formerly Skye)
    "076": "*833*{amount}*{account}#",
    // Heritage Bank
    "030": "*745*{amount}*{account}#",
    // Jaiz Bank
    "301": "*389*301*{amount}*{account}#",
    // Kuda Bank
    "50211": "*5573*{amount}*{account}#",
    // OPay (Paycom)
    "999992": "*955*{amount}*{account}#",
    // Palmpay
    "999991": "*861*{amount}*{account}#",
    // Moniepoint (TeamApt)
    "50515": "*5573*{amount}*{account}#",
};

/**
 * Generate a USSD transfer code for the given bank.
 *
 * @param bankCode  Nomba bank code (e.g. "058" for GTBank)
 * @param accountNumber  10-digit destination account number
 * @param amount  Transfer amount in Naira (will be rounded to integer)
 * @returns The formatted USSD string, or `null` if the bank is not supported
 */
export function generateUssdCode(
    bankCode: string,
    accountNumber: string,
    amount: number
): string | null {
    const template = USSD_CODE_MAP[bankCode];
    if (!template) return null;

    return template
        .replace("{amount}", Math.round(amount).toString())
        .replace("{account}", accountNumber);
}

/**
 * Check whether USSD transfer is supported for a given bank code.
 */
export function isUssdSupported(bankCode: string): boolean {
    return bankCode in USSD_CODE_MAP;
}
