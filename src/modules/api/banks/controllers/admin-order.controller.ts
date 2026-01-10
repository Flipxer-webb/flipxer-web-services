import {
    Controller,
    Post,
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
import { AuthGuard } from '../../auth/guard';
import { BankService } from '../services';
import { SwapService } from '../../trade/services/swap.service';
import { PrismaService } from '@/modules/core/prisma/services';
import { buildResponse } from '@/utils';
import { User } from '@/modules/api/user';
import { User as UserModel } from '@prisma/client';

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
@UseGuards(AuthGuard)
@ApiBearerAuth('access-token')
export class AdminOrderController {
    private readonly logger = new Logger('AdminOrderController');

    constructor(
        private readonly bankService: BankService,
        private readonly prisma: PrismaService,
        private readonly swapService: SwapService
    ) { }

    private async requireAdmin(userId: number): Promise<void> {
        const userData = await this.prisma.user.findUnique({
            where: { id: userId },
            include: { role: { select: { slug: true } } },
        });

        if (!userData?.role || userData.role.slug !== 'super-admin') {
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

        const id = parseInt(orderId);
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
            await this.bankService.paymentSuccessHandler(payment.reference);
            this.logger.log(`Successfully completed order ${id}`);

            const updatedOrder = await this.prisma.order.findUnique({
                where: { id },
            });

            return buildResponse({
                message: 'Order completed successfully. Crypto withdrawal initiated.',
                data: {
                    orderId: updatedOrder?.id,
                    transactionId: updatedOrder?.transactionId,
                    status: updatedOrder?.status,
                    streamlinedStatus: updatedOrder?.streamlinedStatus,
                    amount: updatedOrder?.amount,
                    currency: updatedOrder?.currency,
                    recipient: updatedOrder?.recipient,
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

        const id = parseInt(orderId);
        this.logger.log(`Admin ${user.id} request to retry swap order ${id}`);

        return await this.swapService.retryPendingSwap(id);
    }
}
