import { Injectable, OnModuleInit } from "@nestjs/common";
import Redis from "ioredis";
import { redisConfig } from "@/config";

@Injectable()
export class RedisCacheService implements OnModuleInit {
    private client: Redis;

    onModuleInit() {
        this.client = new Redis({
            host: redisConfig.host,
            port: redisConfig.port,
            username: redisConfig.user,
            password: redisConfig.password,
            tls: redisConfig.redisOptions.tls,
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
