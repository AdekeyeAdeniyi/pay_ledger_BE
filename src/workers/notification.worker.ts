import { Worker } from "bullmq";
import { redis } from "../services/redis.service";
import { prisma } from "../services/prisma.service";
import { logger } from "../utils/logger";

export function startNotificationWorker() {
  const worker = new Worker(
    "notifications",
    async (job) => {
      logger.info({ jobName: job.name, data: job.data }, "Processing notification job (Email / WhatsApp Simulation)");

      if (job.name === "payment-event") {
        const { orgId, invoiceId, amountNaira, outcome } = job.data;
        const [org, invoice] = await Promise.all([prisma.organization.findUnique({ where: { id: orgId } }), prisma.invoice.findUnique({ where: { id: invoiceId }, include: { customer: true } })]);

        if (invoice?.customer.email) {
          logger.info(`[SENDGRID EMAIL] To: ${invoice.customer.email} | Subject: Payment Received (₦${amountNaira}) [Outcome: ${outcome}]`);
        }

        if (org?.notifyOnPayment && org.whatsappNumber) {
          logger.info(`[META WHATSAPP] To: ${org.whatsappNumber} | Message: 💰 Payment Received ₦${amountNaira} for Invoice ${invoice?.invoiceNumber}`);
        }
      } else if (job.name === "welcome-email") {
        logger.info(`[SENDGRID EMAIL] Welcome to PayLedger, ${job.data.name}!`);
      }
    },
    { connection: redis as any },
  );

  worker.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, err }, "Notification Worker job failed");
  });

  return worker;
}
