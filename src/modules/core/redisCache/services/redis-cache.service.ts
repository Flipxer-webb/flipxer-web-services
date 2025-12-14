import { Injectable, OnModuleInit, Logger } from "@nestjs/common";
import Redis from "ioredis";
import { redisConfig } from "@/config";

@Injectable()
export class RedisCacheService implements OnModuleInit {
    private client: Redis;
    private readonly logger = new Logger(RedisCacheService.name);

    onModuleInit() {
        this.client = new Redis({
            host: redisConfig.host,
            port: redisConfig.port,
            username: redisConfig.user,
            password: redisConfig.password,
            tls: redisConfig.redisOptions.tls,
            // Retry strategy with exponential backoff
            retryStrategy: (times: number) => {
                if (times > 10) {
                    this.logger.error(`Redis cache: Max retries (${times}) exceeded`);
                    return null;
                }
                const delay = Math.min(Math.pow(2, times) * 100, 30000);
                this.logger.warn(`Redis cache: Retry ${times}, waiting ${delay}ms`);
                return delay;
            },
            reconnectOnError: (err: Error) => {
                if (err.message.includes("Too many requests")) {
                    this.logger.warn("Redis cache: Reconnecting due to rate limit");
                    return true;
                }
                return false;
            },
        });

        this.client.on("error", (err) => {
            this.logger.error(`Redis cache error: ${err.message}`);
        });

        this.client.on("connect", () => {
            this.logger.log("Redis cache connected");
        });
    }

    async get<T = any>(key: string): Promise<T | null> {
        const value = await this.client.get(key);
        return value ? JSON.parse(value) : null;
    }

    async set(key: string, value: any, ttlSeconds: number): Promise<void> {
        await this.client.set(key, JSON.stringify(value), "EX", ttlSeconds);
    }

    async del(key: string): Promise<void> {
        await this.client.del(key);
    }

    async exists(key: string): Promise<boolean> {
        const exists = await this.client.exists(key);
        return exists === 1;
    }
}
