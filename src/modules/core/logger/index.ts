import { Global, MiddlewareConsumer, Module, NestModule, RequestMethod } from "@nestjs/common";
import { StructuredLoggerService, createLogger } from "./services/structured-logger.service";
import { RequestTracingMiddleware } from "./middleware/request-tracing.middleware";

/**
 * LoggerModule
 * 
 * Provides structured logging with correlation ID tracking.
 * This is a global module - import once in AppModule and it's available everywhere.
 */
@Global()
@Module({
    providers: [
        StructuredLoggerService,
        RequestTracingMiddleware,
        {
            provide: "LOGGER_FACTORY",
            useValue: createLogger,
        },
    ],
    exports: [
        StructuredLoggerService,
        RequestTracingMiddleware,
        "LOGGER_FACTORY",
    ],
})
export class LoggerModule implements NestModule {
    configure(consumer: MiddlewareConsumer) {
        // Apply request tracing to all routes
        consumer
            .apply(RequestTracingMiddleware)
            .forRoutes({ path: "{*path}", method: RequestMethod.ALL });
    }
}
