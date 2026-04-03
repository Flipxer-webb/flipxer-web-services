import { MODULE_METADATA } from "@nestjs/common/constants";
import { LoggerModule } from "../index";
import { RequestTracingMiddleware } from "../middleware/request-tracing.middleware";
import { StructuredLoggerService } from "../services/structured-logger.service";

describe("LoggerModule", () => {
    it("registers expected providers and exports", () => {
        const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, LoggerModule) as unknown[];
        const exportsMeta = Reflect.getMetadata(MODULE_METADATA.EXPORTS, LoggerModule) as unknown[];

        expect(Array.isArray(providers)).toBe(true);
        expect(Array.isArray(exportsMeta)).toBe(true);
        expect(providers).toContain(StructuredLoggerService);
        expect(providers).toContain(RequestTracingMiddleware);
        expect(exportsMeta).toContain(StructuredLoggerService);
        expect(exportsMeta).toContain(RequestTracingMiddleware);
        expect(exportsMeta).toContain("LOGGER_FACTORY");
    });

    it("applies request tracing middleware for all routes", () => {
        const apply = jest.fn().mockReturnValue({ forRoutes: jest.fn() });
        const consumer = { apply } as any;
        const moduleRef = new LoggerModule();

        moduleRef.configure(consumer);

        expect(apply).toHaveBeenCalledWith(RequestTracingMiddleware);
        expect(apply.mock.results[0].value.forRoutes).toHaveBeenCalledWith("*");
    });
});
