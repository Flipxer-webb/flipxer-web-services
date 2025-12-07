import helmet from "helmet";
import { INestApplication, VersioningType } from "@nestjs/common";
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

    app.options("*", (req: Request, res: Response) => {
        const origin = req.headers.origin;
        const isAllowedOrigin =
            typeof origin === "string" &&
            Array.isArray(whitelist) &&
            whitelist.some((item) => {
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
