import { EventEmitter } from "node:events";
import { forwardRef, Inject, Injectable } from "@nestjs/common";
import { TradingService } from "../services";
import { TradingEventMap } from "../interfaces/trade";

@Injectable()
export class TradingEvent extends EventEmitter {
    constructor(
        @Inject(forwardRef(() => TradingService))
        private tradingService: TradingService
    ) {
        super();
        // this.on("quidax-failure", this.onPaymentFailure);
    }

    emit<K extends keyof TradingEventMap>(
        eventName: K,
        payload: TradingEventMap[K]
    ): boolean {
        return super.emit(eventName, payload);
    }

    on<K extends keyof TradingEventMap>(
        eventName: K,
        listener: (payload: TradingEventMap[K]) => void
    ) {
        return super.on(eventName, listener);
    }

    // async onPaymentFailure(options: any) {
    //     // await this.billService.paymentFailureHandler(options);
    // }
}
