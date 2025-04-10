import { Injectable, BadRequestException, HttpException, HttpStatus } from '@nestjs/common';
import { PrismaService } from '../../../core/prisma/services';
import { EmailService } from '../../../core/email/services';
import { SendRecoveryPinDto, VerifyRecoveryPinDto } from '../dtos/recovery-email';
import { mailConfig } from '@/config';
import { SendMailOptions } from '../../../core/email/interfaces';
import { InvalidEmailProviderException } from '../../../core/email/errors';
import * as ejs from 'ejs';
import * as path from 'path';
import * as fs from 'fs';
import { Logger } from 'moment-logger';

const logger = new Logger();

@Injectable()
export class RecoveryEmailService {
  constructor(
    private prisma: PrismaService,
    private emailService: EmailService,
  ) {}

  // Send recovery PIN email (sends to primary email, no recoveryEmail argument)
  async sendRecoveryPinEmail(userId: number, email: string, name: string, pin: string) {
    try {
      // Path to the EJS email template
      const templatePath = path.join(__dirname, '../../../../../public/templates/emails/recovery_email/html.ejs');
      const templateContent = fs.readFileSync(templatePath, 'utf-8');
      const htmlbody = ejs.render(templateContent, { name, code: pin }); // Matches EJS variables 'name' and 'code'

      // Plain text version of the email
      const textbody = `Hi ${name},\n\nYour recovery PIN is: ${pin}\nThis PIN expires in 1 hour.\n\nBest regards,\nResolve Team`;

      // Send email with the provided options
      const mailOptions: SendMailOptions = {
        from: {
          address: mailConfig.senderMail,
          name: 'Resolve Team',
        },
        to: [
          {
            email_address: {
              address: email,
              name,
            },
          },
        ],
        subject: 'Recovery PIN Request',
        textbody,
        htmlbody,
        track_opens: true,
        track_clicks: true,
      };

      await this.emailService.sendMail(mailOptions);
      logger.info(`Recovery PIN email sent successfully to ${email}`);
    } catch (error) {
      logger.error(`Error sending recovery PIN email: ${error.message}`, { userId, email });
      logger.error(`Full error details: ${JSON.stringify(error)}`);
      throw new InvalidEmailProviderException('Failed to send recovery PIN email. Please try again later.');
    }
  }

  // Generate and send 6-digit PIN (uses dto.email only)
  async sendRecoveryPin(dto: SendRecoveryPinDto) {
    try {
      const user = await this.prisma.user.findUnique({
        where: { email: dto.email },
        include: { recoveryEmail: true }, // Include recoveryEmail for consistency
      });

      if (!user) {
        logger.warn(`User not found for email: ${dto.email}`);
        throw new BadRequestException('User not found');
      }

      const pin = Math.floor(100000 + Math.random() * 900000).toString(); // 6-digit PIN

      // Update or create recovery email record (no recoveryEmail stored yet)
      await this.prisma.recoveryEmail.upsert({
        where: { userId: user.id },
        update: {
          recoveryPin: pin,
          lastPinGeneratedAt: new Date(),
        },
        create: {
          userId: user.id,
          recoveryPin: pin,
          lastPinGeneratedAt: new Date(),
        },
      });

      // Send recovery PIN email to dto.email (primary email)
      await this.sendRecoveryPinEmail(
        user.id,
        dto.email,
        `${user.firstName || ''} ${user.lastName || ''}`.trim() || 'User',
        pin
      );

      logger.info(`Recovery PIN request created for user: ${user.email}`);
      return { message: 'Recovery PIN sent successfully' };
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      logger.error(`Error in sendRecoveryPin for email ${dto.email}: ${error.message}`, { stack: error.stack });
      throw new HttpException(
        error.message || 'An error occurred while sending the recovery PIN',
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  // Verify PIN and update recovery email (uses dto.recoveryEmail)
  async verifyRecoveryPin(dto: VerifyRecoveryPinDto) {
    try {
      const user = await this.prisma.user.findUnique({
        where: { email: dto.email },
        include: { recoveryEmail: true },
      });

      if (!user || !user.recoveryEmail) {
        logger.warn(`User or recovery email not found for email: ${dto.email}`);
        throw new BadRequestException('User or recovery email not found');
      }

      const recoveryEmail = user.recoveryEmail;

      if (recoveryEmail.recoveryPin !== dto.pin) {
        logger.warn(`Invalid PIN provided for user ID: ${user.id}`);
        throw new BadRequestException('Invalid PIN');
      }

      const currentTime = new Date();
      const pinGeneratedAt = recoveryEmail.lastPinGeneratedAt;
      if (!pinGeneratedAt || (currentTime.getTime() - pinGeneratedAt.getTime()) > 3600000) {
        logger.warn(`PIN has expired for user ID: ${user.id}`);
        throw new BadRequestException('PIN has expired');
      }

      // Update recovery email with dto.recoveryEmail upon verification
      await this.prisma.recoveryEmail.update({
        where: { userId: user.id },
        data: {
          recoveryEmail: dto.recoveryEmail,
          recoveryPin: null,
          lastPinGeneratedAt: new Date(),
        },
      });
      logger.info(`Recovery email updated successfully for user ID: ${user.id}`);

      return { message: 'Recovery email updated successfully' };
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      logger.error(`Error in verifyRecoveryPin for email ${dto.email}: ${error.message}`, { stack: error.stack });
      throw new HttpException(
        error.message || 'An error occurred while verifying the recovery PIN',
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }
}