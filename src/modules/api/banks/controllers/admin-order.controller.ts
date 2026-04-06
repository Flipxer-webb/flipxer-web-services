import {
    Controller,
    Post,
    Get,
    Param,
    UseGuards,
    HttpCode,
    HttpStatus,
    Logger,
    NotFoundException,
    BadRequestException,
    ForbiddenException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiParam } from '@nestjs/swagger';
import { AuthGuard, EnabledAccountGuard } from '../../auth/guard';
import { RoleGuard } from '../../authorize/guards/role.guard';
import { UserTypes, ADMIN_USER_TYPES } from '../../authorize/decorator';
import { SwapService } from '../../trade/services/swap.service';
import { BuyOrderService } from '../../trade/services/buy-order.service';
import { StuckOrderReconciliationService } from '../../trade/services/stuck-order-reconciliation.service';
import { PrismaService } from '@/modules/core/prisma/services';
import { buildResponse } from '@/utils';
import { User } from '@/modules/api/user';
import { User as UserModel, OrderCategory, OrderStatus, TransactionStatus } from '@prisma/client';

/**
 * Admin Controller for Order Management
 * 
 * Provides endpoints for admins to manage orders, including
 * manually completing pending buy orders.
 * 
 * Only accessible by users with 'super-admin' role.
 */
@ApiTags('Admin - Orders')
@Controller('admin/orders')
@UseGuards(AuthGuard, EnabledAccountGuard, RoleGuard)
@UserTypes(ADMIN_USER_TYPES)
@ApiBearerAuth('access-token')
export class AdminOrderController {
    private readonly logger = new Logger('AdminOrderController');

    constructor(
        private readonly prisma: PrismaService,
        private readonly swapService: SwapService,
        private readonly buyOrderService: BuyOrderService,
        private readonly stuckOrderReconciliation: StuckOrderReconciliationService,
    ) { }

    private async requireAdmin(userId: number): Promise<void> {
        const userData = await this.prisma.user.findUnique({
            where: { id: userId },
            include: { role: { select: { slug: true } } },
        });

        if (userData?.role?.slug !== 'super-admin') {
            throw new ForbiddenException('Admin access required');
        }
    }

    /**
     * Complete a pending buy order by manually triggering Quidax withdrawal.
     */
    @Post(':orderId/complete')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Complete a pending buy order',
        description: 'Manually triggers Quidax withdrawal for a pending buy order',
    })
    @ApiParam({
        name: 'orderId',
        description: 'ID of the order to complete',
        type: Number,
        example: 12,
    })
    async completePendingOrder(
        @User() user: UserModel,
        @Param('orderId') orderId: string
    ) {
        await this.requireAdmin(user.id);

        const id = Number.parseInt(orderId);
        this.logger.log(`Admin ${user.id} request to complete order ${id}`);

        const order = await this.prisma.order.findUnique({
            where: { id },
            include: { user: { select: { id: true, email: true } } },
        });

        if (!order) {
            throw new NotFoundException(`Order ${id} not found`);
        }

        if (order.orderCategory !== 'BUY') {
            throw new BadRequestException(`Order ${id} is not a BUY order`);
        }

        if (order.status === 'confirmed' && order.streamlinedStatus === 'completed') {
            return buildResponse({
                message: 'Order is already completed',
                data: {
                    orderId: order.id,
                    transactionId: order.transactionId,
                    status: order.status,
                },
            });
        }

        const payment = await this.prisma.payment.findFirst({
            where: { orderId: id },
        });

        if (!payment) {
            throw new NotFoundException(`Payment not found for order ${id}`);
        }

        this.logger.log(`Processing payment ${payment.reference} for order ${id}`);

        try {
            // Reset payment to PENDING if needed so fulfillBuyOrder's atomic claim works
            if (payment.status !== TransactionStatus.PENDING) {
                await this.prisma.payment.update({
                    where: { id: payment.id },
                    data: {
                        status: TransactionStatus.PENDING,
                        paymentStatus: TransactionStatus.PENDING,
                    },
                });
                this.logger.log(`Reset payment ${payment.id} from ${payment.status} to PENDING for fulfillment`);
            }

            await this.buyOrderService.fulfillBuyOrder(payment.reference);
            this.logger.log(`Successfully completed order ${id} via omnibus ledger`);

            const updatedOrder = await this.prisma.order.findUnique({
                where: { id },
            });

            return buildResponse({
                message: 'Order completed successfully via ledger credit.',
                data: {
                    orderId: updatedOrder?.id,
                    transactionId: updatedOrder?.transactionId,
                    status: updatedOrder?.status,
                    streamlinedStatus: updatedOrder?.streamlinedStatus,
                    fulfilled: updatedOrder?.fulfilled,
                    amount: updatedOrder?.amount,
                    currency: updatedOrder?.currency,
                    ledgerEntryId: updatedOrder?.ledgerEntryId,
                },
            });
        } catch (error) {
            this.logger.error(`Failed to complete order ${id}: ${error.message}`);
            throw new BadRequestException(`Failed to complete order: ${error.message}`);
        }
    }

    /**
     * Get list of pending buy orders that need attention
     */
    @Post('pending')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Get pending buy orders',
        description: 'Lists all BUY orders in pending state',
    })
    async getPendingBuyOrders(@User() user: UserModel) {
        await this.requireAdmin(user.id);

        const pendingOrders = await this.prisma.order.findMany({
            where: {
                orderCategory: 'BUY',
                OR: [
                    { status: 'pending' },
                    { paymentStatus: 'PENDING' },
                ],
            },
            include: {
                user: { select: { id: true, email: true, firstName: true, lastName: true } },
            },
            orderBy: { createdAt: 'desc' },
            take: 50,
        });

        return buildResponse({
            message: `Found ${pendingOrders.length} pending buy orders`,
            data: pendingOrders.map(order => ({
                id: order.id,
                transactionId: order.transactionId,
                user: order.user.email,
                amount: order.amount,
                currency: order.currency,
                status: order.status,
                paymentStatus: order.paymentStatus,
                recipient: order.recipient,
                createdAt: order.createdAt,
            })),
        });
    }

    /**
     * Get list of stuck buy orders (Payment SUCCESS but Order PENDING)
     * These are users who paid via Nomba but crypto transfer failed
     */
    @Get('stuck')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Get stuck buy orders',
        description: 'Lists BUY orders where payment succeeded but order is still pending (crypto never transferred)',
    })
    async getStuckBuyOrders(@User() user: UserModel) {
        await this.requireAdmin(user.id);

        // Look for payments that are SUCCESS or APPROVED (stuck during processing)
        // with orders that are still pending and not fulfilled
        const stuckPayments = await this.prisma.payment.findMany({
            where: {
                status: { in: [TransactionStatus.SUCCESS, TransactionStatus.APPROVED] },
                orderId: { not: null },
                order: {
                    orderCategory: OrderCategory.BUY,
                    status: OrderStatus.pending,
                    fulfilled: false,
                },
            },
            include: {
                order: true,
                user: {
                    select: {
                        id: true,
                        email: true,
                        firstName: true,
                        lastName: true,
                        cryptoSubAccountId: true,
                    },
                },
            },
            orderBy: { createdAt: 'desc' },
        });

        return buildResponse({
            message: `Found ${stuckPayments.length} stuck buy orders`,
            data: stuckPayments.map(payment => ({
                paymentId: payment.id,
                paymentReference: payment.reference,
                orderId: payment.order?.id,
                transactionId: payment.order?.transactionId,
                user: {
                    id: payment.user?.id,
                    email: payment.user?.email,
                    name: `${payment.user?.firstName || ''} ${payment.user?.lastName || ''}`.trim(),
                    hasSubAccount: !!payment.user?.cryptoSubAccountId,
                },
                amount: payment.order?.amount,
                currency: payment.order?.currency,
                paidAmount: payment.totalAmount,
                paymentStatus: payment.status,
                orderStatus: payment.order?.status,
                createdAt: payment.createdAt,
            })),
        });
    }

    /**
     * Retry fulfillment for a stuck Nomba buy order
     * Uses the internal transfer method (to user's sub-account)
     */
    @Post(':orderId/retry-fulfillment')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Retry fulfillment for stuck buy order',
        description: 'Retries the crypto transfer for a Nomba buy order where payment succeeded but crypto was never delivered',
    })
    @ApiParam({
        name: 'orderId',
        description: 'ID of the order to retry',
        type: Number,
        example: 12,
    })
    async retryBuyOrderFulfillment(
        @User() user: UserModel,
        @Param('orderId') orderId: string
    ) {
        await this.requireAdmin(user.id);

        const id = Number.parseInt(orderId);
        this.logger.log(`Admin ${user.id} request to retry fulfillment for order ${id}`);

        const order = await this.prisma.order.findUnique({
            where: { id },
            include: { user: { select: { id: true, email: true, cryptoSubAccountId: true } } },
        });

        if (!order) {
            throw new NotFoundException(`Order ${id} not found`);
        }

        if (order.orderCategory !== OrderCategory.BUY) {
            throw new BadRequestException(`Order ${id} is not a BUY order`);
        }

        if (order.fulfilled) {
            return buildResponse({
                message: 'Order is already fulfilled',
                data: {
                    orderId: order.id,
                    transactionId: order.transactionId,
                    status: order.status,
                },
            });
        }

        const payment = await this.prisma.payment.findFirst({
            where: { orderId: id },
        });

        if (!payment) {
            throw new NotFoundException(`Payment not found for order ${id}`);
        }

        // Allow retry for PENDING (webhook never arrived), SUCCESS (stuck after payment),
        // or APPROVED (stuck during processing)
        if (
            payment.status !== TransactionStatus.PENDING &&
            payment.status !== TransactionStatus.SUCCESS &&
            payment.status !== TransactionStatus.APPROVED
        ) {
            throw new BadRequestException(`Payment for order ${id} is not in a retryable state (status: ${payment.status})`);
        }

        // Only reset to PENDING if not already PENDING
        if (payment.status !== TransactionStatus.PENDING) {
            await this.prisma.payment.update({
                where: { id: payment.id },
                data: {
                    status: TransactionStatus.PENDING,
                    paymentStatus: TransactionStatus.PENDING,
                },
            });
            this.logger.log(`Reset payment ${payment.id} from ${payment.status} to PENDING`);
        }

        this.logger.log(`Retrying fulfillment for order ${id}, payment reference: ${payment.reference}`);

        try {
            await this.buyOrderService.fulfillBuyOrder(payment.reference);
            this.logger.log(`Successfully retried fulfillment for order ${id}`);

            const updatedOrder = await this.prisma.order.findUnique({
                where: { id },
            });

            return buildResponse({
                message: 'Fulfillment retry successful. Crypto transfer initiated.',
                data: {
                    orderId: updatedOrder?.id,
                    transactionId: updatedOrder?.transactionId,
                    status: updatedOrder?.status,
                    streamlinedStatus: updatedOrder?.streamlinedStatus,
                    fulfilled: updatedOrder?.fulfilled,
                    amount: updatedOrder?.amount,
                    currency: updatedOrder?.currency,
                },
            });
        } catch (error) {
            this.logger.error(`Failed to retry fulfillment for order ${id}: ${error.message}`);
            throw new BadRequestException(`Failed to retry fulfillment: ${error.message}`);
        }
    }

    @Post(':orderId/retry-swap')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Retry a pending swap order',
        description: 'Retries the buy leg of a swap order that is stuck in pending state due to insufficient liquidity.',
    })
    @ApiParam({
        name: 'orderId',
        description: 'ID of the order to retry',
        type: Number,
        example: 12,
    })
    async retrySwapOrder(
        @User() user: UserModel,
        @Param('orderId') orderId: string
    ) {
        await this.requireAdmin(user.id);

        const id = Number.parseInt(orderId);
        this.logger.log(`Admin ${user.id} request to retry swap order ${id}`);

        return await this.swapService.retryPendingSwap(id);
    }

    /**
     * Manually trigger stuck-order reconciliation.
     * Detects and auto-fixes stuck BUY orders, broken ledger links, and pre-ledger gaps.
     */
    @Post('reconcile')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Run stuck-order reconciliation',
        description: 'Detects stuck orders (payment received but not fulfilled) and auto-retries fulfillment. Also detects broken ledger links and backfills pre-ledger orders.',
    })
    async runReconciliation(@User() user: UserModel) {
        await this.requireAdmin(user.id);

        this.logger.log(`Admin ${user.id} triggered manual stuck-order reconciliation`);

        const result = await this.stuckOrderReconciliation.reconcile();

        return buildResponse({
            message: 'Reconciliation complete',
            data: {
                timestamp: result.timestamp,
                stuckBuyOrders: {
                    detected: result.stuckBuyOrders.detected,
                    autoRetried: result.stuckBuyOrders.autoRetried,
                    retryFailed: result.stuckBuyOrders.retryFailed,
                    skippedNoWebhook: result.stuckBuyOrders.skippedNoWebhook,
                    details: result.stuckBuyOrders.details,
                },
                brokenLedgerOrders: {
                    detected: result.brokenLedgerOrders.detected,
                    details: result.brokenLedgerOrders.details,
                },
                preLedgerBackfill: {
                    detected: result.preLedgerBackfill.detected,
                    fixed: result.preLedgerBackfill.fixed,
                },
                errors: result.errors,
            },
        });
    }
}
