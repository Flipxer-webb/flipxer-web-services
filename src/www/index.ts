import helmet from "helmet";
import { INestApplication, VersioningType } from "@nestjs/common";
import { HttpAdapterHost, NestFactory } from "@nestjs/core";
import { AppModule } from "@/modules";
import { CorsOptions } from "@nestjs/common/interfaces/external/cors-options.interface";
import { AllExceptionsFilter } from "@/core/exception/http";
import { classValidatorPipeInstance } from "@/core/pipe";
import { PrismaService } from "@/modules/core/prisma/services";
import morgan from "morgan";
import { frontendDevOrigin, isProdEnvironment } from "@/config";
import { NestExpressApplication } from "@nestjs/platform-express";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { Request, Response, NextFunction } from "express";

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

    let whitelist = options.whitelistedDomains ?? [];
    if (!isProdEnvironment) {
        whitelist = whitelist.concat(frontendDevOrigin as any);
    }

    const corsOptions: CorsOptions = {
        origin: "http://127.0.0.1:5500",
        allowedHeaders: ["Authorization", "X-Requested-With", "Content-Type"],
        methods: ["GET", "PUT", "POST", "PATCH", "DELETE", "OPTIONS"],
        credentials: true,
    };

    //hanlde prflight request
    app.use((req: Request, res: Response, next: NextFunction) => {
        if (req.method === 'OPTIONS') {
            res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
            res.header('Access-Control-Allow-Methods', 'GET, PUT, POST, PATCH, DELETE, OPTIONS');
            res.header('Access-Control-Allow-Headers', 'Authorization, X-Requested-With, Content-Type');
            return res.sendStatus(204);
        }
        next();
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
        .setTitle("Resolve web API Service")
        .setDescription("API service that powers resolve web app")
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
    app.listen(options.port);

    //handle prisma enableShutDownHook interference with nest app enableShutdownHooks
    const prismaService = app.get(PrismaService);
    await prismaService.enableShutdownHooks(app);

    return app;
};
