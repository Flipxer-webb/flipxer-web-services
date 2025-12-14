import { Injectable } from "@nestjs/common";
import { EventEmitter } from "events";
import logger from "moment-logger";
import { EventBody, WebhookEventMap } from "../interfaces";
import { QuidaxWebhookService } from "../services";

@Injectable()
export class QuidaxWebhookEvent extends EventEmitter {
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
        try {
            logger.log(`Processing webhook event: ${eventBody.event}`);
            await this.quidaxWebhookService.processWebhookEvent(eventBody);
            logger.log(`Webhook event processed successfully: ${eventBody.event}`);
        } catch (error) {
            logger.error(`Error processing webhook event: ${eventBody.event}`, error);
        }
    }
}
