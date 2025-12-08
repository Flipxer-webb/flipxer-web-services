// Global error handler to catch module import errors
process.on("uncaughtException", (error) => {
    console.error("\n=== UNCAUGHT EXCEPTION ===");
    console.error("Error:", error.message);
    console.error("Stack:", error.stack);
    console.error("===========================\n");
    process.exit(1);
});

process.on("unhandledRejection", (reason, promise) => {
    console.error("\n=== UNHANDLED REJECTION ===");
    console.error("Reason:", reason);
    console.error("============================\n");
    process.exit(1);
});

console.log("=== Flipxer Backend Starting ===");
console.log("Node version:", process.version);
console.log("Environment:", process.env.NODE_ENV);
console.log("================================\n");

import createServer, { CreateServerOptions } from "@/www";
import { allowedDomains, isProduction, port } from "@/config";
import logger from "moment-logger";

async function bootstrap() {
    try {
        // Start Server
        logger.log("Starting Server");
        logger.info(
            `Running in ${isProduction ? "production" : "development"} mode`
        );

        const options: CreateServerOptions = {
            port,
            production: isProduction,
            whitelistedDomains: allowedDomains,
        };

        await createServer(options);

        logger.info(`Server started on port ${port}`);
    } catch (error) {
        logger.error(error);
    }
}
bootstrap();
