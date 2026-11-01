import 'dotenv/config'
import './sentry-bootstrap.js'
import process from 'node:process'
// import vine from '@vinejs/vine';
import logger from '#vendor/utils/logger.js'
import { initServer, stopServer } from '#vendor/start/server.js'
import configApp from '#config/app.js'
// import redis from '#database/redis.js';
// import validators from '#vendor/start/validators.js';
import { createWsRoutesByUrl, routesHandler } from '#vendor/start/router.js'
import httpRoutes from '#app/routes/http-routes.js'
import wsRoutes from '#app/routes/ws-routes.js'
import { promptService } from '#app/services/ai/prompt-service.js'
import '#app/start/index.js'
import { validateRuntimeConfig } from '#app/start/validate-runtime-config.js'
import { sentryService } from '#app/services/observability/sentry-service.js'
import { pool } from '#database/db.js'
import { sessionCheckPool } from '#database/session-check-db.js'
import redis, { redisHealth } from '#database/redis.js'
import rateLimitRedis, { connectRateLimitRedis } from '#database/redis-rate-limit.js'

// logger.info(configApp);

// const testRedis = async (): Promise<void> => {
//     try {
//         await redis.set('test', Date.now().toString());
//     } catch (err) {
//         logger.error({ err }, 'Redis connection failed');
//         throw err;
//     }
// };

// const compileValidateSchema = (): void => {
//     const schemaKeys = Object.keys(schemas);
//     schemaKeys.forEach((key: string) => {
//         validators.set(key, vine.compile(schemas[key].validator));
//     });
// };

const start = async (): Promise<void> => {
    try {
        validateRuntimeConfig()

        process.title = configApp.appName
        logger.info(`Starting application on port ${String(configApp.port)}`)
        logger.info(
            'use module: uws_' +
                process.platform +
                '_' +
                process.arch +
                '_' +
                process.versions.modules +
                '.node',
        )

        connectRateLimitRedis()
        await promptService.load()
        const processedHttpRoutes = routesHandler(httpRoutes)
        const processedWsRoutes = routesHandler(wsRoutes)

        await initServer({
            httpRoutes: processedHttpRoutes,
            wsRoutesByUrl: createWsRoutesByUrl(processedWsRoutes),
            sourceHttpRoutes: httpRoutes,
            sourceWsRoutes: wsRoutes,
        })

        process.on('SIGINT', stopSIGINT)
        process.on('SIGHUP', stopSIGHUP)
        process.on('SIGTERM', stopSIGTERM)
        process.on('uncaughtException', stopUncaughtException)
    } catch (err: unknown) {
        logger.error({ err }, 'Failed to start application')
        console.error('Failed to start application:', err)
        process.exit(1)
    }
}

let isStopping = false

const removeListeners = (): void => {
    process.removeListener('SIGINT', stopSIGINT)
    process.removeListener('SIGHUP', stopSIGHUP)
    process.removeListener('SIGTERM', stopSIGTERM)
    process.removeListener('uncaughtException', stopUncaughtException)
}

const stopHandler = async (type: string): Promise<void> => {
    await stopServer(type)
}

const stopGracefully = async (type: string): Promise<void> => {
    if (isStopping) {
        logger.warn({ type }, 'Shutdown already in progress')
        return
    }

    isStopping = true
    try {
        await stopHandler(type)
        await sentryService.flush(2000)
        // Before quit: the closing connection is not an incident.
        redisHealth.stop()
        await Promise.allSettled([
            pool.end(),
            sessionCheckPool.end(),
            redis.quit(),
            rateLimitRedis.quit(),
        ])
    } catch (error: unknown) {
        console.error(error)
    } finally {
        removeListeners()
        process.exit(0)
    }
}

const stopSIGINT = (): void => {
    logger.info('stop SIGINT')
    void stopGracefully('SIGINT')
}
const stopSIGHUP = (): void => {
    logger.info('stop SIGHUP')
    void stopGracefully('SIGHUP')
}
const stopSIGTERM = (): void => {
    logger.info('stop SIGTERM')
    void stopGracefully('SIGTERM')
}
const handleUncaughtException = async (err: unknown, origin: unknown): Promise<void> => {
    logger.error({ err, origin, sentrySkip: true }, 'event uncaughtException')
    sentryService.captureException(err, {
        extra: { origin: String(origin) },
    })

    try {
        await stopHandler('uncaughtException')
        await sentryService.flush(2000)
    } catch (stopError: unknown) {
        console.error(stopError)
    } finally {
        removeListeners()
        process.exit(1)
    }
}
// process.on() ignores the returned promise; handleUncaughtException catches its own errors.
const stopUncaughtException = (err: unknown, origin: unknown): void => {
    void handleUncaughtException(err, origin)
}

start()
    .then(() => {
        logger.info('start success')
    })
    .catch((err: unknown) => {
        logger.error({ err: err as Error }, 'Unhandled error during startup')
        console.error('Unhandled error during startup:', err)
        process.exit(1)
    })
