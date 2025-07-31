export interface AirtimePayment {
    phone: string;
    amount: string;
}

export interface DataPayment {
    package: string;
}

export interface InternetPayment {
    package: string;
}

export interface EnergyPayment {
    amount: string;
}

export interface CableTVPayment {
    amount: string;
}

export interface WalletBankDeposit {
    amount: string;
    totalAmount: string;
}

export interface BankTransfer {
    amount: string;
    recipientAccountName: string;
}

export interface IntraWalletTransferSender {
    amount: string;
    recipientAccountName: string;
}

export interface IntraWalletTransferRecipient {
    amount: string;
    senderAccountName: string;
}
export interface GiftcardPayment {
    recipientEmail: string;
    amount: string;
}

export interface BettingWalletFunding {
    recipientPhone: string;
    amount: string;
}
