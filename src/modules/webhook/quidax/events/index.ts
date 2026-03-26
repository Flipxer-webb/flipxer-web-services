import { Injectable, Logger } from "@nestjs/common";
import { EventEmitter } from "node:events";
import { EventBody, WebhookEventMap } from "../interfaces";
import { QuidaxWebhookService } from "../services";

@Injectable()
export class QuidaxWebhookEvent extends EventEmitter {
    private readonly logger = new Logger("QuidaxWebhookEvent");
    
    constructor(private quidaxWebhookService: QuidaxWebhookService) {
        super();
        // Use arrow function or bind to preserve 'this' context
        this.on("process-webhook-event", this.processor.bind(this));
    }
    emit<K extends keyof WebhookEventMap>(
        eventName: K,
        payload: WebhookEventMap[K]
    ): boolean {
        return super.emit(eventName, payload);
    }

    on<K extends keyof WebhookEventMap>(
        eventName: K,
        listener: (payload: WebhookEventMap[K]) => void
    ) {
        return super.on(eventName, listener);
    }

    async processor(eventBody: EventBody) {
        const startTime = Date.now();
        try {
            this.logger.log(`[PROCESSING] Event: ${eventBody.event}`);
            await this.quidaxWebhookService.processWebhookEvent(eventBody);
            const duration = Date.now() - startTime;
            this.logger.log(`[COMPLETED] Event: ${eventBody.event} - Duration: ${duration}ms`);
        } catch (error) {
            const duration = Date.now() - startTime;
            this.logger.error(
                `[FAILED] Event: ${eventBody.event} - Duration: ${duration}ms - Error: ${error.message}`,
                error.stack
            );
        }
    }
}
