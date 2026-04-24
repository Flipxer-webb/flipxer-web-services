import { INestApplication, Injectable, OnModuleInit, OnModuleDestroy, Logger } from "@nestjs/common";
import { PrismaClient, Prisma } from "@prisma/client";

/**
 * Connection pool configuration
 * These values are optimized for a production environment
 */
const CONNECTION_POOL_CONFIG = {
    // Maximum number of connections in the pool
    connectionLimit: Number.parseInt(process.env.DATABASE_POOL_SIZE || '10', 10),
    // Connection timeout in milliseconds
    connectTimeout: Number.parseInt(process.env.DATABASE_CONNECT_TIMEOUT || '10000', 10),
    // Maximum time a connection can be idle before being closed
    poolTimeout: Number.parseInt(process.env.DATABASE_POOL_TIMEOUT || '10000', 10),
};

/**
 * Build database URL with connection pool parameters
 */
function buildDatabaseUrl(): string {
    const baseUrl = process.env.DATABASE_URL || '';
    
    // If URL already has parameters, append with &, otherwise use ?
    const separator = baseUrl.includes('?') ? '&' : '?';
    
    // Add connection pool parameters for PostgreSQL
    const poolParams = [
        `connection_limit=${CONNECTION_POOL_CONFIG.connectionLimit}`,
        `connect_timeout=${Math.floor(CONNECTION_POOL_CONFIG.connectTimeout / 1000)}`,
        `pool_timeout=${Math.floor(CONNECTION_POOL_CONFIG.poolTimeout / 1000)}`,
    ].join('&');
    
    return `${baseUrl}${separator}${poolParams}`;
}

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
                    url: buildDatabaseUrl(),
                },
            },
        });
        
        this.logger.log(`Database pool config: ${JSON.stringify(CONNECTION_POOL_CONFIG)}`);
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
        (this as any).$on("beforeExit", async () => {
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
    
    /**
     * Get connection pool statistics (for monitoring)
     */
    getPoolStats(): { connectionLimit: number; isConnected: boolean } {
        return {
            connectionLimit: CONNECTION_POOL_CONFIG.connectionLimit,
            isConnected: this.isConnected,
        };
    }
    
    /**
     * Execute a callback within a transaction with configurable options
     * 
     * @param fn - Transaction callback
     * @param options - Transaction options (timeout, isolation level)
     */
    async executeTransaction<T>(
        fn: (tx: Prisma.TransactionClient) => Promise<T>,
        options?: {
            maxWait?: number;
            timeout?: number;
            isolationLevel?: Prisma.TransactionIsolationLevel;
        }
    ): Promise<T> {
        return this.$transaction(fn, {
            maxWait: options?.maxWait ?? 5000,
            timeout: options?.timeout ?? 10000,
            isolationLevel: options?.isolationLevel,
        });
    }
}
