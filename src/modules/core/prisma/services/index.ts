import { INestApplication, Injectable, OnModuleInit, OnModuleDestroy, Logger } from "@nestjs/common";
import { PrismaClient, Prisma } from "@prisma/client";

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(PrismaService.name);
    private connectionRetries = 0;
    private readonly maxRetries = 5;
    private isConnected = false;

    constructor() {
        super({
            log: [
                { emit: "event", level: "query" },
                { emit: "event", level: "error" },
                { emit: "event", level: "warn" },
            ],
            // Connection pool settings for better reliability
            datasources: {
                db: {
                    url: process.env.DATABASE_URL,
                },
            },
        });
    }

    async onModuleInit() {
        await this.connectWithRetry();
        
        // Log slow queries in development
        if (process.env.NODE_ENV !== "production") {
            (this as any).$on("query", (e: Prisma.QueryEvent) => {
                if (e.duration > 1000) {
                    this.logger.warn(`Slow query (${e.duration}ms): ${e.query}`);
                }
            });
        }
        
        // Log all errors
        (this as any).$on("error", (e: any) => {
            this.logger.error(`Prisma error: ${e.message}`);
        });
    }

    private async connectWithRetry(): Promise<void> {
        while (this.connectionRetries < this.maxRetries) {
            try {
                this.logger.log("Connecting to the database...");
                await this.$connect();
                this.isConnected = true;
                this.connectionRetries = 0;
                this.logger.log("Connected to the database");
                return;
            } catch (error) {
                this.connectionRetries++;
                const delay = Math.min(1000 * Math.pow(2, this.connectionRetries), 30000);
                this.logger.error(
                    `Database connection attempt ${this.connectionRetries}/${this.maxRetries} failed: ${error.message}`
                );
                if (this.connectionRetries >= this.maxRetries) {
                    throw new Error(`Failed to connect to database after ${this.maxRetries} attempts`);
                }
                this.logger.warn(`Retrying in ${delay}ms...`);
                await new Promise((resolve) => setTimeout(resolve, delay));
            }
        }
    }

    async onModuleDestroy() {
        this.logger.log("Disconnecting from database...");
        await this.$disconnect();
        this.isConnected = false;
        this.logger.log("Disconnected from database");
    }

    async enableShutdownHooks(app: INestApplication) {
        this.$on("beforeExit", async () => {
            await app.close();
        });
    }

    /**
     * Health check for the database connection
     */
    async isHealthy(): Promise<boolean> {
        try {
            await this.$queryRaw`SELECT 1`;
            return true;
        } catch {
            return false;
        }
    }
}
