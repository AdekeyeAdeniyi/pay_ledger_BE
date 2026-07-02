import { buildApp } from "./app";
import { env } from "./config/env";
import { logger } from "./utils/logger";
import { prisma } from "./services/prisma.service";
import { startVaWorker } from "./workers/va.worker";
import { startReconWorker } from "./workers/recon.worker";
import { startNotificationWorker } from "./workers/notification.worker";
import { expireOverdueInvoices } from "./jobs/cron";

async function start() {
  try {
    logger.info("Connecting to Database...");
    await prisma.$connect();
    logger.info("Database Connected");

    // Start BullMQ Background Workers
    logger.info("Starting Background Queue Workers...");
    const vaWorker = startVaWorker();
    const reconWorker = startReconWorker();
    const notifyWorker = startNotificationWorker();

    // Start Cron Interval (Every 1 hour for overdue check)
    setInterval(() => {
      expireOverdueInvoices().catch((err) => logger.error({ err }, "Cron expireOverdueInvoices failed"));
    }, 3600_000);

    const app = await buildApp();

    await app.listen({ port: env.PORT, host: "0.0.0.0" });
    logger.info(`🚀 PayLedger Backend API listening on port ${env.PORT} [Environment: ${env.NODE_ENV}]`);

    const gracefulShutdown = async (signal: string) => {
      logger.info(`Received ${signal}. Shutting down gracefully...`);
      await app.close();
      await vaWorker.close();
      await reconWorker.close();
      await notifyWorker.close();
      await prisma.$disconnect();
      process.exit(0);
    };

    process.on("SIGINT", () => gracefulShutdown("SIGINT"));
    process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
  } catch (err) {
    logger.error({ err }, "Fatal error during server startup");
    process.exit(1);
  }
}

start();
