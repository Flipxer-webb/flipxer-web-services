import { IoAdapter } from "@nestjs/platform-socket.io";
import { ServerOptions } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import Redis from "ioredis";
import { INestApplication, Logger } from "@nestjs/common";
import { redisConfig } from "@/config";

const logger = new Logger("RedisIoAdapter");

export class RedisIoAdapter extends IoAdapter {
    private adapterConstructor: ReturnType<typeof createAdapter>;

    constructor(app: INestApplication) {
        super(app);
    }

    async connectToRedis(): Promise<void> {
        const options = {
            host: redisConfig.host,
            port: redisConfig.port,
            username: redisConfig.user,
            password: redisConfig.password,
            tls: redisConfig.redisOptions.tls,
        };

        const pubClient = new Redis(options);
        const subClient = pubClient.duplicate();

        pubClient.on("connect", () => logger.log("Socket.IO Redis pub client connected"));
        pubClient.on("error", (err) => logger.error(`Socket.IO Redis pub error: ${err.message}`));
        subClient.on("error", (err) => logger.error(`Socket.IO Redis sub error: ${err.message}`));

        this.adapterConstructor = createAdapter(pubClient, subClient);
    }

    createIOServer(port: number, options?: ServerOptions) {
        const server = super.createIOServer(port, options);
        server.adapter(this.adapterConstructor);
        return server;
    }
}
