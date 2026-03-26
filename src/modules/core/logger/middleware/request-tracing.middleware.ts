import { Injectable, NestMiddleware } from "@nestjs/common";
import { Request, Response, NextFunction } from "express";
import { StructuredLoggerService } from "../services/structured-logger.service";

// Extend Request to include correlation ID
declare global {
    namespace Express {
        interface Request {
            correlationId?: string;
            logger?: StructuredLoggerService;
        }
    }
}

/**
 * Header names for correlation ID
 */
const CORRELATION_ID_HEADER = "x-correlation-id";
const REQUEST_ID_HEADER = "x-request-id";

/**
 * RequestTracingMiddleware
 * 
 * Middleware that:
 * - Extracts or generates correlation IDs for requests
 * - Attaches a configured logger to the request
 * - Logs request start/end with timing
 * - Adds correlation ID to response headers
 */
@Injectable()
export class RequestTracingMiddleware implements NestMiddleware {
    constructor(private readonly logger: StructuredLoggerService) {
        this.logger.setContext("RequestTracing");
    }

    use(req: Request, res: Response, next: NextFunction): void {
        // Extract correlation ID from headers or generate a new one
        const incomingCorrelationId = 
            req.headers[CORRELATION_ID_HEADER] as string ||
            req.headers[REQUEST_ID_HEADER] as string;

        const correlationId = incomingCorrelationId || this.logger.generateCorrelationId();

        // Attach correlation ID to request
        req.correlationId = correlationId;

        // Create a logger for this request
        const requestLogger = this.logger.child("HTTP");
        requestLogger.setCorrelationId(correlationId);
        
        // Extract user ID from JWT token if available
        const userId = this.extractUserIdFromRequest(req);

        // Set up request context
        requestLogger.setRequestContext({
            correlationId,
            method: req.method,
            path: req.originalUrl,
            userId,
            startTime: Date.now(),
        });

        // Attach logger to request for use in handlers
        req.logger = requestLogger;

        // Log request start
        requestLogger.log("Request received", {
            method: req.method,
            path: req.originalUrl,
            userAgent: req.headers["user-agent"],
            ip: req.ip || req.headers["x-forwarded-for"],
            contentType: req.headers["content-type"],
        });

        // Add correlation ID to response headers
        res.setHeader(CORRELATION_ID_HEADER, correlationId);
        res.setHeader(REQUEST_ID_HEADER, correlationId);

        // Track response
        const startTime = Date.now();
        
        // Intercept response finish to log completion
        res.on("finish", () => {
            const duration = Date.now() - startTime;
            const statusCode = res.statusCode;

            const logData = {
                method: req.method,
                path: req.originalUrl,
                statusCode,
                duration,
                contentLength: res.get("content-length"),
            };

            if (statusCode >= 500) {
                requestLogger.error("Request failed", undefined, logData);
            } else if (statusCode >= 400) {
                requestLogger.warn("Request client error", logData);
            } else {
                requestLogger.log("Request completed", logData);
            }

            requestLogger.clearRequestContext();
        });

        next();
    }

    /**
     * Extract user ID from request (if authenticated)
     */
    private extractUserIdFromRequest(req: Request): number | undefined {
        // Check for user attached by auth middleware
        const user = (req as any).user;
        if (user && typeof user.id === "number") {
            return user.id;
        }

        // Check for user ID in query params (admin routes)
        const userId = req.query.userId;
        if (userId && typeof userId === "string") {
            const parsed = Number.parseInt(userId, 10);
            if (!Number.isNaN(parsed)) {
                return parsed;
            }
        }

        return undefined;
    }
}

/**
 * Correlation ID decorator for getting the correlation ID from request
 */
export function getCorrelationId(req: Request): string {
    return req.correlationId || "unknown";
}
