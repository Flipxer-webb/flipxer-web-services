import { randomUUID } from "node:crypto";
import { Injectable, LoggerService as NestLoggerService, Scope } from "@nestjs/common";

/**
 * Log levels in order of severity
 */
export enum LogLevel {
    DEBUG = "debug",
    INFO = "info",
    WARN = "warn",
    ERROR = "error",
}

/**
 * Structured log entry
 */
export interface LogEntry {
    timestamp: string;
    level: LogLevel;
    correlationId: string;
    context: string;
    message: string;
    data?: Record<string, unknown>;
    error?: {
        name: string;
        message: string;
        stack?: string;
    };
    duration?: number;
}

/**
 * Request context for tracking
 */
export interface RequestContext {
    correlationId: string;
    userId?: number;
    method?: string;
    path?: string;
    startTime: number;
}

/**
 * StructuredLoggerService
 * 
 * Provides structured logging with:
 * - Correlation IDs for request tracing
 * - Consistent JSON log format
 * - Duration tracking
 * - Context preservation
 */
@Injectable({ scope: Scope.DEFAULT })
export class StructuredLoggerService implements NestLoggerService {
    private context = "Application";
    private correlationId = "";
    private requestContext: RequestContext | null = null;

    /**
     * Set the logger context (typically the service/module name)
     */
    setContext(context: string): this {
        this.context = context;
        return this;
    }

    /**
     * Create a child logger with a new context
     */
    child(context: string): StructuredLoggerService {
        const child = new StructuredLoggerService();
        child.context = context;
        child.correlationId = this.correlationId;
        child.requestContext = this.requestContext;
        return child;
    }

    /**
     * Set correlation ID for request tracing
     */
    setCorrelationId(correlationId: string): this {
        this.correlationId = correlationId;
        return this;
    }

    /**
     * Get the current correlation ID
     */
    getCorrelationId(): string {
        return this.correlationId || this.generateCorrelationId();
    }

    /**
     * Generate a new correlation ID
     */
    generateCorrelationId(): string {
        return randomUUID();
    }

    /**
     * Set request context for tracking
     */
    setRequestContext(context: Partial<RequestContext>): this {
        this.requestContext = {
            correlationId: context.correlationId || this.getCorrelationId(),
            userId: context.userId,
            method: context.method,
            path: context.path,
            startTime: context.startTime || Date.now(),
        };
        this.correlationId = this.requestContext.correlationId;
        return this;
    }

    /**
     * Clear request context
     */
    clearRequestContext(): this {
        this.requestContext = null;
        this.correlationId = "";
        return this;
    }

    /**
     * Log a debug message
     */
    debug(message: string, data?: Record<string, unknown>): void {
        this.writeLog(LogLevel.DEBUG, message, data);
    }

    /**
     * Log an info message
     */
    log(message: string, data?: Record<string, unknown>): void {
        this.writeLog(LogLevel.INFO, message, data);
    }

    /**
     * Log a warning message
     */
    warn(message: string, data?: Record<string, unknown>): void {
        this.writeLog(LogLevel.WARN, message, data);
    }

    /**
     * Log an error message
     */
    error(message: string, trace?: string | Error, data?: Record<string, unknown>): void {
        const errorInfo = this.extractErrorInfo(trace);
        this.writeLog(LogLevel.ERROR, message, data, errorInfo);
    }

    /**
     * Log with verbose level (same as debug)
     */
    verbose(message: string, data?: Record<string, unknown>): void {
        this.debug(message, data);
    }

    /**
     * Log request start
     */
    logRequestStart(method: string, path: string, userId?: number): string {
        const correlationId = this.generateCorrelationId();
        this.setRequestContext({
            correlationId,
            method,
            path,
            userId,
            startTime: Date.now(),
        });
        
        this.log("Request started", {
            method,
            path,
            userId,
        });

        return correlationId;
    }

    /**
     * Log request completion
     */
    logRequestEnd(statusCode: number, data?: Record<string, unknown>): void {
        const duration = this.requestContext 
            ? Date.now() - this.requestContext.startTime 
            : 0;

        this.log("Request completed", {
            statusCode,
            duration,
            ...data,
        });

        this.clearRequestContext();
    }

    /**
     * Log an operation with timing
     */
    async logOperation<T>(
        operationName: string,
        operation: () => Promise<T>,
        data?: Record<string, unknown>
    ): Promise<T> {
        const startTime = Date.now();
        this.log(`${operationName} started`, data);

        try {
            const result = await operation();
            const duration = Date.now() - startTime;
            this.log(`${operationName} completed`, { ...data, duration });
            return result;
        } catch (error) {
            const duration = Date.now() - startTime;
            this.error(`${operationName} failed`, error as Error, { ...data, duration });
            throw error;
        }
    }

    /**
     * Create a structured log entry
     */
    private createLogEntry(
        level: LogLevel,
        message: string,
        data?: Record<string, unknown>,
        error?: LogEntry["error"]
    ): LogEntry {
        const entry: LogEntry = {
            timestamp: new Date().toISOString(),
            level,
            correlationId: this.correlationId || "N/A",
            context: this.context,
            message,
        };

        if (data && Object.keys(data).length > 0) {
            entry.data = data;
        }

        if (error) {
            entry.error = error;
        }

        if (this.requestContext) {
            entry.data = {
                ...entry.data,
                requestMethod: this.requestContext.method,
                requestPath: this.requestContext.path,
                userId: this.requestContext.userId,
            };
        }

        return entry;
    }

    /**
     * Write a log entry
     */
    private writeLog(
        level: LogLevel,
        message: string,
        data?: Record<string, unknown>,
        error?: LogEntry["error"]
    ): void {
        const entry = this.createLogEntry(level, message, data, error);
        const output = JSON.stringify(entry);

        switch (level) {
            case LogLevel.DEBUG:
                console.debug(output);
                break;
            case LogLevel.INFO:
                console.log(output);
                break;
            case LogLevel.WARN:
                console.warn(output);
                break;
            case LogLevel.ERROR:
                console.error(output);
                break;
        }
    }

    /**
     * Extract error information from various error types
     */
    private extractErrorInfo(trace?: string | Error): LogEntry["error"] | undefined {
        if (!trace) return undefined;

        if (typeof trace === "string") {
            return {
                name: "Error",
                message: trace,
            };
        }

        if (trace instanceof Error) {
            return {
                name: trace.name,
                message: trace.message,
                stack: trace.stack,
            };
        }

        return undefined;
    }
}

/**
 * Create a logger instance for a specific context
 */
export function createLogger(context: string): StructuredLoggerService {
    const logger = new StructuredLoggerService();
    logger.setContext(context);
    return logger;
}
