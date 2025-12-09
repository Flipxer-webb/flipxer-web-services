import { Injectable, Logger } from "@nestjs/common";
import { SendchampLib } from "@/libs/sendchamp";
import { sendchampConfig, sendchampOptions } from "@/config";
import { SmsServiceInterface } from "../interfaces";
import { COMPANY_NAME } from "@/config/constants";

@Injectable()
export class SmsService implements SmsServiceInterface {
    private readonly logger = new Logger(SmsService.name);
    private readonly sendchamp: SendchampLib;
    private readonly isConfigured: boolean;

    constructor() {
        this.isConfigured = !!sendchampConfig.accessKey;
        
        if (this.isConfigured) {
            this.sendchamp = new SendchampLib(sendchampOptions);
            this.logger.log("SMS service initialized with Sendchamp");
        } else {
            this.logger.warn(
                "SMS service not configured - SENDCHAMP_ACCESS_KEY missing"
            );
        }
    }

    /**
     * Format phone number to international format (Nigeria)
     * Converts 08012345678 to 2348012345678
     */
    private formatPhoneNumber(phone: string): string {
        let formatted = phone.trim().replace(/\s+/g, "");
        
        // Remove leading + if present
        if (formatted.startsWith("+")) {
            formatted = formatted.substring(1);
        }
        
        // Convert Nigerian local format to international
        if (formatted.startsWith("0")) {
            formatted = `234${formatted.substring(1)}`;
        }
        
        // If doesn't start with country code, assume Nigeria
        if (!formatted.startsWith("234")) {
            formatted = `234${formatted}`;
        }
        
        return formatted;
    }

    /**
     * Send a generic SMS
     */
    async sendSms(to: string, message: string): Promise<void> {
        if (!this.isConfigured) {
            this.logger.warn(`SMS not sent (not configured): ${to}`);
            return;
        }

        try {
            const formattedPhone = this.formatPhoneNumber(to);
            
            await this.sendchamp.sendSms({
                to: formattedPhone,
                message: message,
                sender_name: sendchampConfig.senderId,
                route: "non_dnd",
            });
            
            this.logger.log(`SMS sent successfully to ${formattedPhone}`);
        } catch (error) {
            this.logger.error(`Failed to send SMS to ${to}:`, error);
            throw error;
        }
    }

    /**
     * Send phone verification OTP code
     */
    async sendVerificationCode(to: string, code: string): Promise<void> {
        const message = `Your ${COMPANY_NAME} verification code is: ${code}. This code expires in 30 minutes. Do not share this code with anyone.`;
        
        await this.sendSms(to, message);
    }

    /**
     * Send transaction notification via SMS
     */
    async sendTransactionNotification(
        to: string,
        type: "credit" | "debit",
        amount: string,
        currency: string
    ): Promise<void> {
        const action = type === "credit" ? "received" : "sent";
        const message = `${COMPANY_NAME}: You have ${action} ${currency} ${amount}. Login to your account for details.`;
        
        await this.sendSms(to, message);
    }

    /**
     * Check if SMS service is properly configured
     */
    isEnabled(): boolean {
        return this.isConfigured;
    }
}
