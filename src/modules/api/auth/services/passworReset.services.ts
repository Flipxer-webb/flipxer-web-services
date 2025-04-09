import { Injectable, HttpException, HttpStatus } from "@nestjs/common";
import { PrismaService } from "@/modules/core/prisma/services";
import { EmailService } from "@/modules/core/email/services";
import * as crypto from "crypto";
import * as ejs from "ejs";
import * as path from "path";
import * as fs from "fs";
import * as bcrypt from "bcryptjs"; // Import bcrypt for password hashing
import { mailConfig } from "@/config";
import { SendMailOptions } from "@/modules/core/email/interfaces";
import { SendForgotPasswordDto, ResetPasswordDto } from "../dtos";
import { InvalidEmailProviderException } from "@/modules/core/email/errors"; // Custom exception
import { Logger } from "moment-logger";

const logger = new Logger();
const SALT_ROUNDS = 10; // Define the number of salt rounds for bcrypt

@Injectable()
export class PasswordService {
    constructor(
        private prisma: PrismaService,
        private emailService: EmailService
    ) {}

    async sendForgotPasswordEmail(
        userId: number,
        email: string,
        name: string,
        code: string
    ) {
        try {
            // Path to the EJS email template
            const templatePath = path.join(
                __dirname,
                "../../../../../public/templates/emails/password_reset_email/html.ejs"
            );
            // Read and compile the EJS template for HTML email body
            const templateContent = fs.readFileSync(templatePath, "utf-8");
            const htmlbody = ejs.render(templateContent, { name, code });

            // Plain text version of the email (optional)
            const textbody = `Hi ${name},\n\nYou requested a password reset. Use the following code to reset your password: ${code}\nThis code will expire in 30 minutes.\n\nBest regards,\nResolve Team`;

            // Send email with the provided options
            const mailOptions: SendMailOptions = {
                from: {
                    address: mailConfig.senderMail,
                    name: "Resolve Team",
                },
                to: [
                    {
                        email_address: {
                            address: email,
                            name,
                        },
                    },
                ],
                subject: "Password Reset Request",
                textbody, // Plain text body for non-HTML clients
                htmlbody, // HTML body generated from EJS
                track_opens: true,
                track_clicks: true,
            };

            // Use email service to send email
            await this.emailService.sendMail(mailOptions);

            logger.info(`Password reset email sent successfully to ${email}`);
        } catch (error) {
            logger.error(
                `Error sending password reset email: ${error.message}`,
                { userId, email }
            );
            logger.error(`Full error details: ${JSON.stringify(error)}`);

            // Throw custom exception if email provider fails
            throw new InvalidEmailProviderException(
                "Failed to send password reset email. Please try again later."
            );
        }
    }

    async requestPasswordReset(dto: SendForgotPasswordDto) {
        try {
            const user = await this.prisma.user.findUnique({
                where: { email: dto.email },
            });

            if (!user) {
                logger.warn(
                    `Password reset requested for non-existent user: ${dto.email}`
                );
                throw new HttpException("User not found", HttpStatus.NOT_FOUND); // Specific exception for user not found
            }

            const code = crypto.randomBytes(3).toString("hex").toUpperCase();

            // Delete existing password reset requests for the user
            await this.prisma.passwordResetRequest.deleteMany({
                where: { userId: user.id },
            });

            // Create new password reset request
            await this.prisma.passwordResetRequest.create({
                data: {
                    userId: user.id,
                    code: code,
                    createdAt: new Date(),
                    updatedAt: new Date(),
                },
            });

            // Send reset email to user
            await this.sendForgotPasswordEmail(
                user.id,
                dto.email,
                `${user.firstName || ""} ${user.lastName || ""}`.trim() ||
                    "User",
                code
            );

            logger.info(
                `Password reset request created for user: ${user.email}`
            );
            return { message: "Password reset email sent successfully" };
        } catch (error) {
            logger.error(`Error requesting password reset: ${error.message}`, {
                email: dto.email,
            });
            throw new HttpException(
                error.message || "Failed to request password reset",
                HttpStatus.BAD_REQUEST
            );
        }
    }

    async resetPassword(dto: ResetPasswordDto) {
        try {
            const user = await this.prisma.user.findUnique({
                where: { email: dto.email },
                include: { passwordResetRequest: true },
            });

            if (!user || !user.passwordResetRequest) {
                logger.warn(
                    `Invalid password reset request for user: ${dto.email}`
                );
                throw new HttpException(
                    "Invalid reset request",
                    HttpStatus.BAD_REQUEST
                ); // Invalid reset request
            }

            if (user.passwordResetRequest.code !== dto.resetCode) {
                logger.warn(`Invalid reset code for user: ${dto.email}`);
                throw new HttpException(
                    "Invalid reset code",
                    HttpStatus.BAD_REQUEST
                ); // Invalid reset code
            }

            const createdAt = user.passwordResetRequest.createdAt;
            if (Date.now() - createdAt.getTime() > 30 * 60 * 1000) {
                // 30-minute expiration
                await this.prisma.passwordResetRequest.delete({
                    where: { userId: user.id },
                });
                logger.warn(`Expired reset code for user: ${dto.email}`);
                throw new HttpException(
                    "Reset code has expired",
                    HttpStatus.BAD_REQUEST
                ); // Expired reset code
            }

            // Encrypt the password using bcrypt before updating
            const hashedPassword = await bcrypt.hash(dto.password, SALT_ROUNDS);

            // Update user's password with the hashed password
            await this.prisma.user.update({
                where: { id: user.id },
                data: { password: hashedPassword, updatedAt: new Date() },
            });

            // Delete the reset request after successful password reset
            await this.prisma.passwordResetRequest.delete({
                where: { userId: user.id },
            });
            logger.info(`Password reset successfully for user: ${dto.email}`);

            return { message: "Password reset successfully" };
        } catch (error) {
            logger.error(`Error resetting password: ${error.message}`, {
                email: dto.email,
            });
            throw new HttpException(
                error.message || "Failed to reset password",
                HttpStatus.INTERNAL_SERVER_ERROR
            );
        }
    }
}
