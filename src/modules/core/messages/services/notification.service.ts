import { Injectable } from "@nestjs/common";
import * as t from "../types/notification.type";

@Injectable()
export class NotificationMessageService {
    airtimePayment(options: t.AirtimePayment) {
        return `Cheers! Your airtime recharge of ₦${options.amount} to ${options.phone} is successful. Stay connected with PhosMonie!`;
    }

    internetPayment(options: t.DataPayment) {
        return `Your internet plan renewal for ${options.package} is successful. More streaming, more fun! Thanks for choosing PhosMonie.`;
    }

    dataPayment(options: t.InternetPayment) {
        return `You're all set! ${options.package} data plan activated successfully. Surf away and enjoy the speed with PhosMonie`;
    }

    energyPayment(options: t.EnergyPayment) {
        return `Light up your day! Your electricity bill payment of ₦${options.amount} is successful. Stay powered with PhosMonie`;
    }

    cableTVPayment(options: t.CableTVPayment) {
        return `Ready for your favorite shows! Your Cable TV subscription for ₦${options.amount} is successful. Binge-watch with joy, thanks to PhosMonie!`;
    }

    walletBankDeposit(options: t.WalletBankDeposit) {
        return `Deposit Alert: ₦${options.amount} has been added to your wallet successfully. Your balance is now ₦${options.totalAmount}. PhosMonie keeps your transactions smooth!`;
    }

    bankTransfer(options: t.BankTransfer) {
        return `You've transferred ₦${options.amount} to ₦${options.recipientAccountName}. We've got your back for secure and swift transactions at PhosMonie`;
    }

    intraWalletTransferSender(options: t.IntraWalletTransferSender) {
        return `Transfer successful! ₦${options.amount} sent to ₦${options.recipientAccountName}. PhosMonie makes moving money easy and quick!`;
    }

    intraWalletTransferRecipient(options: t.IntraWalletTransferRecipient) {
        return `Transfer successful! ₦${options.amount} received from ₦${options.senderAccountName}. PhosMonie makes moving money easy and quick!`;
    }
    giftcardPayment(options: t.GiftcardPayment) {
        return `Cheers! Your Giftcard purchase of ₦${options.amount} to ${options.recipientEmail} is successful. Stay connected with PhosMonie!`;
    }

    bettingWalletFunding(options: t.BettingWalletFunding) {
        return `Cheers! Your betting wallet funding of ₦${options.amount} to ${options.recipientPhone} is successful. Stay connected with PhosMonie!`;
    }
    flightBooking() {
        return `Cheers! You have successfully booked your flight and the itinerary attachment has been sent to the lead passenger's email. Stay connected with PhosMonie!`;
    }
}
