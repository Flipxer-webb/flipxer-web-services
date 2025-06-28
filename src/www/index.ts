import helmet from "helmet";
import { INestApplication, VersioningType } from "@nestjs/common";
import { HttpAdapterHost, NestFactory } from "@nestjs/core";
import { AppModule } from "@/modules";
import { CorsOptions } from "@nestjs/common/interfaces/external/cors-options.interface";
import { AllExceptionsFilter } from "@/core/exception/http";
import { classValidatorPipeInstance } from "@/core/pipe";
import { PrismaService } from "@/modules/core/prisma/services";
import morgan from "morgan";
import { allowedDomains, frontendDevUrl, frontendDevOrigin, isProdEnvironment, redisConfig } from "@/config";
import { NestExpressApplication } from "@nestjs/platform-express";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { waitForRedis } from "@/utils";

export interface CreateServerOptions {
    port: number;
    production?: boolean;
    whitelistedDomains?: string[];
}

export default async (
    options: CreateServerOptions
): Promise<INestApplication> => {
    const app = await NestFactory.create<NestExpressApplication>(AppModule, {
        //logger: false,
    });

    // Define whitelist with explicit type to include strings and RegExp
    let whitelist: (string | RegExp)[] = options.whitelistedDomains ?? [];
    if (allowedDomains) {
        whitelist = whitelist.concat(allowedDomains);
    }
    if (frontendDevUrl) {
        whitelist = whitelist.concat(frontendDevUrl);
    }
    whitelist = whitelist.concat(frontendDevOrigin); // RegExp for localhost
    // Add RegExp for https://resolve-web-app-dev.vercel.app
    whitelist = whitelist.concat([/^https:\/\/resolve-web-app-dev\.vercel\.app$/]);
    // Remove duplicates (for strings only, RegExp objects are unique)
    whitelist = [...new Set(whitelist)];

    const corsOptions: CorsOptions = {
        origin: (origin, callback) => {
            console.log(`CORS: Checking origin: ${origin}`); // Debug log
            // Allow requests with no origin (e.g., server-to-server requests)
            if (!origin) {
                console.log("CORS: No origin, allowing request");
                return callback(null, true);
            }
            // Check if the origin is in the whitelist or matches the regex
            const isWhitelisted = whitelist.some((allowedOrigin) => {
                if (typeof allowedOrigin === "string") {
                    return allowedOrigin === origin;
                } else if (allowedOrigin instanceof RegExp) {
                    return allowedOrigin.test(origin);
                }
                return false;
            });
            if (isWhitelisted) {
                console.log(`CORS: Origin ${origin} allowed`);
                callback(null, origin);
            } else {
                console.error(`CORS: Origin ${origin} not allowed. Whitelist: ${JSON.stringify(whitelist)}`);
                callback(new Error(`CORS policy: Origin ${origin} not allowed`));
            }
        },
        allowedHeaders: ["Authorization", "X-Requested-With", "Content-Type"],
        methods: ["GET", "PUT", "POST", "PATCH", "DELETE", "OPTIONS"],
        credentials: true,
    };

    app.use(helmet());
    app.enableCors(corsOptions);
    app.use(morgan(options.production ? "combined" : "dev"));
    app.useBodyParser("json", { limit: "100mb" });

    app.enableVersioning({
        type: VersioningType.URI,
        defaultVersion: "1",
        prefix: "api/v",
    });

    const config = new DocumentBuilder()
        .setTitle("Resolve web API Service")
        .setDescription("API service that powers resolve web app")
        .setVersion("1.0")
        .addBearerAuth(
            { type: "http", scheme: "bearer", bearerFormat: "JWT" },
            "access-token"
        )
        .build();
    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup("api", app, document);

    app.useGlobalPipes(classValidatorPipeInstance());
    const httpAdapterHost = app.get(HttpAdapterHost);
    app.useGlobalFilters(new AllExceptionsFilter(httpAdapterHost));

    waitForRedis(redisConfig);
    await app.listen(options.port);

    const prismaService = app.get(PrismaService);
    await prismaService.enableShutdownHooks(app);

    return app;
};