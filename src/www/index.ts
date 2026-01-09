import helmet from "helmet";
import compression from "compression";
import { INestApplication, Logger, VersioningType } from "@nestjs/common";
import { HttpAdapterHost, NestFactory } from "@nestjs/core";
import { AppModule } from "@/modules";
import { CorsOptions } from "@nestjs/common/interfaces/external/cors-options.interface";
import { AllExceptionsFilter } from "@/core/exception/http";
import { classValidatorPipeInstance } from "@/core/pipe";
import { PrismaService } from "@/modules/core/prisma/services";
import morgan from "morgan";
import { frontendDevOrigin, isProdEnvironment, redisConfig } from "@/config";
import { NestExpressApplication } from "@nestjs/platform-express";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { Request, Response } from "express";
import { waitForRedis } from "@/utils";

export interface CreateServerOptions {
    port: number;
    production?: boolean;
    whitelistedDomains?: string[];
}

const logger = new Logger('ServerBootstrap');

export default async (
    options: CreateServerOptions
): Promise<INestApplication> => {
    const app = await NestFactory.create<NestExpressApplication>(AppModule, {
        //logger: false,
    });

    app.set("trust proxy", true); // Enables Express to respect X-Forwarded-For headers and allows request-ip to get real IP

    let whitelist = options.whitelistedDomains ?? [];
    if (!isProdEnvironment) {
        whitelist = whitelist.concat(frontendDevOrigin as any);
    }

    const corsOptions: CorsOptions = {
        origin: whitelist,
        allowedHeaders: ["Authorization", "X-Requested-With", "Content-Type"],
        methods: ["GET", "PUT", "POST", "PATCH", "DELETE", "OPTIONS"],
        credentials: true,
    };

    const allowedMethodsHeader = Array.isArray(corsOptions.methods)
        ? corsOptions.methods.join(", ")
        : corsOptions.methods;
    const allowedHeadersHeader = Array.isArray(corsOptions.allowedHeaders)
        ? corsOptions.allowedHeaders.join(", ")
        : corsOptions.allowedHeaders;

    const expressApp = app.getHttpAdapter().getInstance();
    expressApp.options("*", (req: Request, res: Response) => {
        const origin = req.headers.origin;
        const isAllowedOrigin =
            typeof origin === "string" &&
            Array.isArray(whitelist) &&
            whitelist.some((item: string | RegExp) => {
                if (typeof item === "string") return item === origin;
                if (item instanceof RegExp) return item.test(origin);
                return false;
            });

        if (isAllowedOrigin) {
            res.header("Access-Control-Allow-Origin", origin);
            res.header("Vary", "Origin");
            res.header("Access-Control-Allow-Credentials", "true");
        }

        res.header("Access-Control-Allow-Methods", allowedMethodsHeader);
        res.header("Access-Control-Allow-Headers", allowedHeadersHeader);

        if (isAllowedOrigin || !origin) {
            return res.sendStatus(204);
        }

        return res.sendStatus(403);
    });

    // SECURITY: Configure helmet with comprehensive security headers
    app.use(helmet({
        contentSecurityPolicy: {
            directives: {
                defaultSrc: ["'self'"],
                scriptSrc: [
                    "'self'",
                    "'unsafe-inline'", // Required for some inline scripts
                    "https://widget.intercom.io",
                    "https://js.intercomcdn.com",
                ],
                styleSrc: [
                    "'self'",
                    "'unsafe-inline'",
                    "https://fonts.googleapis.com",
                ],
                imgSrc: [
                    "'self'",
                    "data:",
                    "blob:",
                    "https://ik.imagekit.io",
                    "https://res.cloudinary.com",
                    "https://downloads.intercomcdn.com",
                ],
                connectSrc: [
                    "'self'",
                    "https://api.fincra.com",
                    "https://checkout.fincra.com",
                    "https://app.quidax.io",
                    "https://ramp-be.quidax.io",
                    "https://api.dojah.io",
                    "https://api.livecoinwatch.com",
                    "https://api.coingecko.com",
                    "wss://*.intercom.io",
                ],
                fontSrc: [
                    "'self'",
                    "https://fonts.gstatic.com",
                ],
                objectSrc: ["'none'"],
                mediaSrc: ["'self'"],
                frameSrc: [
                    "'self'",
                    "https://checkout.fincra.com",
                    "https://fincra.com",
                ],
                frameAncestors: ["'none'"],
                formAction: ["'self'"],
                baseUri: ["'self'"],
            },
        },
        crossOriginEmbedderPolicy: false, // Required for third-party integrations
        hsts: {
            maxAge: 31536000, // 1 year
            includeSubDomains: true,
            preload: true,
        },
        referrerPolicy: {
            policy: "strict-origin-when-cross-origin",
        },
        noSniff: true,
        xssFilter: true,
        hidePoweredBy: true,
    }));
    app.use(compression()); // Gzip compression for 60-80% smaller responses
    app.enableCors(corsOptions);
    app.use(morgan(options.production ? "combined" : "dev"));
    // SECURITY: Reduced from 100mb to 10mb to prevent DoS attacks
    app.useBodyParser("json", { limit: "10mb" });

    // SECURITY: Preserve raw body for webhook signature verification
    // This middleware captures the original bytes before JSON parsing
    expressApp.use("/webhook", (req: Request, res: Response, next: Function) => {
        let rawBody = '';
        req.setEncoding('utf8');
        req.on('data', (chunk: string) => {
            rawBody += chunk;
        });
        req.on('end', () => {
            (req as any).rawBody = rawBody;
            next();
        });
    });

    // Also capture raw body for legacy webhook paths that get forwarded
    expressApp.use(["/quidax", "/api/webhook/quidax", "/api/webhook/fincra"], (req: Request, res: Response, next: Function) => {
        let rawBody = '';
        req.setEncoding('utf8');
        req.on('data', (chunk: string) => {
            rawBody += chunk;
        });
        req.on('end', () => {
            (req as any).rawBody = rawBody;
            // Parse JSON body manually since we consumed the stream
            if (rawBody) {
                try {
                    req.body = JSON.parse(rawBody);
                } catch (e) {
                    logger.error(`Failed to parse webhook body: ${e}`);
                }
            }
            next();
        });
    });

    // Legacy webhook routes - forward to correct internal paths
    // Fincra sends webhooks to root URL, forward to /webhook/fincra
    expressApp.post("/", (req: Request, res: Response, next: Function) => {
        // Check if this looks like a Fincra webhook (has x-fincra-signature header)
        if (req.headers["x-fincra-signature"]) {
            logger.debug("Forwarding Fincra webhook from / to /webhook/fincra");
            req.url = "/webhook/fincra";
            return next();
        }
        // Not a Fincra webhook, continue to next handler
        next();
    });

    // Fincra may also send webhooks to /api/webhook/fincra - forward to /webhook/fincra
    expressApp.post("/api/webhook/fincra", (req: Request, res: Response, next: Function) => {
        logger.debug("Forwarding Fincra webhook from /api/webhook/fincra to /webhook/fincra");
        req.url = "/webhook/fincra";
        next();
    });

    // Quidax sends webhooks to /quidax, forward to /webhook/quidax
    expressApp.post("/quidax", (req: Request, res: Response, next: Function) => {
        logger.debug("Forwarding Quidax webhook from /quidax to /webhook/quidax");
        req.url = "/webhook/quidax";
        next();
    });

    // Quidax may also send webhooks to /api/webhook/quidax - forward to /webhook/quidax
    expressApp.post("/api/webhook/quidax", (req: Request, res: Response, next: Function) => {
        logger.debug("Forwarding Quidax webhook from /api/webhook/quidax to /webhook/quidax");
        req.url = "/webhook/quidax";
        next();
    });


    app.enableVersioning({
        type: VersioningType.URI,
        defaultVersion: "1",
        prefix: "api/v",
    });

    const config = new DocumentBuilder()
        .setTitle("Flipxer Web API Service")
        .setDescription("API service that powers the Flipxer web app")
        .setVersion("1.0")
        .addBearerAuth(
            { type: "http", scheme: "bearer", bearerFormat: "JWT" }, // Bearer config
            "access-token" // Name of the security schema
        )
        .build();
    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup("api", app, document);

    app.useGlobalPipes(classValidatorPipeInstance());
    const httpAdapterHost = app.get(HttpAdapterHost);
    app.useGlobalFilters(new AllExceptionsFilter(httpAdapterHost));

    waitForRedis(redisConfig);
    app.listen(options.port);

    //handle prisma enableShutDownHook interference with nest app enableShutdownHooks
    const prismaService = app.get(PrismaService);
    await prismaService.enableShutdownHooks(app);

    return app;
};
