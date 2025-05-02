import { Injectable } from "@nestjs/common";
import { EventEmitter } from "events";
import { EventBody, WebhookEventMap } from "../interfaces";
import { QuidaxWebhookService } from "../services";

@Injectable()
export class QuidaxWebhookEvent extends EventEmitter {
    constructor(private quidaxWebhookService: QuidaxWebhookService) {
        super();
        this.on("process-webhook-event", this.processor);
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
        await this.quidaxWebhookService.processWebhookEvent(eventBody);
    }
}
