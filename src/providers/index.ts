import { Context, Hono } from "hono"
import { contentJson, fromHono, OpenAPIRoute } from 'chanfana';
import { z } from "zod";

import db from "../db"
import { resolveRouteId } from "./shared/route-policy"
import { resolveChannel } from "./shared/channel-resolver"
import { executeWithFallbackChannels } from "./shared/upstream-retry"
import { ModelsEndpoint } from "./models"

const API_RATE_LIMIT_WINDOW_MS = 60 * 1000;
const API_RATE_LIMIT_MAX_REQUESTS = 60;
const API_RATE_LIMIT_BLOCK_MS = 60 * 1000;

const apiRateLimitStore = new Map<string, { count: number; windowStart: number; blockedUntil: number | null }>();

const cleanupRateLimitStore = (now: number) => {
    for (const [key, entry] of apiRateLimitStore) {
        if (entry.blockedUntil && entry.blockedUntil < now) {
            apiRateLimitStore.delete(key);
        } else if (!entry.blockedUntil && now - entry.windowStart > API_RATE_LIMIT_WINDOW_MS * 2) {
            apiRateLimitStore.delete(key);
        }
    }
};

const checkApiRateLimit = (clientIp: string): { ok: boolean; retryAfterSeconds?: number } => {
    const now = Date.now();

    if (apiRateLimitStore.size > 10000) {
        cleanupRateLimitStore(now);
    }

    const entry = apiRateLimitStore.get(clientIp);

    if (entry?.blockedUntil && entry.blockedUntil > now) {
        return { ok: false, retryAfterSeconds: Math.ceil((entry.blockedUntil - now) / 1000) };
    }

    if (!entry || now - entry.windowStart > API_RATE_LIMIT_WINDOW_MS) {
        apiRateLimitStore.set(clientIp, { count: 1, windowStart: now, blockedUntil: null });
        return { ok: true };
    }

    entry.count += 1;

    if (entry.count > API_RATE_LIMIT_MAX_REQUESTS) {
        entry.blockedUntil = now + API_RATE_LIMIT_BLOCK_MS;
        return { ok: false, retryAfterSeconds: Math.ceil(API_RATE_LIMIT_BLOCK_MS / 1000) };
    }

    return { ok: true };
};

export const api = fromHono(new Hono<HonoCustomType>())

api.use("/v1/*", async (c, next) => {
    await db.ensureReady(c);

    const clientIp = c.req.header('cf-connecting-ip')
        || c.req.header('x-real-ip')
        || c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
        || 'unknown';

    const rateLimitResult = checkApiRateLimit(clientIp);
    if (!rateLimitResult.ok) {
        c.header('Retry-After', String(rateLimitResult.retryAfterSeconds || 60));
        return c.text('Too many requests, please try again later', 429);
    }

    await next();
});

class UnifiedProxyEndpoint extends OpenAPIRoute {
    schema = {
        tags: ['OpenAI Proxy'],
        request: {
            headers: z.object({
                'Authorization': z.string().optional().describe("Token for authentication (OpenAI format)"),
                'x-api-key': z.string().optional().describe("API key for authentication (Claude format)"),
            }),
            body: contentJson(z.any()),
        },
        responses: {
            200: {
                description: 'Successful response',
            },
        },
    };

    async handle(c: Context<HonoCustomType>) {
        const routeId = resolveRouteId(c.req.path)
        if (!routeId) {
            return c.text("Unknown route", 404)
        }

        const result = await resolveChannel(c, routeId)
        if (result instanceof Response) return result

        const { channels, initialChannel, requestBody, saveUsage, logFailure, trackingState, setActiveChannel } = result

        return executeWithFallbackChannels(
            c,
            channels,
            initialChannel,
            requestBody,
            saveUsage,
            logFailure,
            trackingState,
            setActiveChannel,
        )
    }
}

api.post("/v1/chat/completions", UnifiedProxyEndpoint)
api.post("/v1/messages", UnifiedProxyEndpoint)
api.post("/v1/responses", UnifiedProxyEndpoint)
api.post("/v1/audio/speech", UnifiedProxyEndpoint)
api.get("/v1/models", ModelsEndpoint)
