import { RedisConnection, Worker } from "bullmq";
import { prisma } from "../services/prisma.service";
import { logger } from "../utils/logger";
import { NombaWebhookPayload } from "../utils/nombaWebhook";
import { Prisma } from "../generated/client";
import { redis } from "../services/redis.service";

interface ReconJobData {
  payload: NombaWebhookPayload;
  orgId: string;
  paymentPath: "BANK_TRANSFER" | "CHECKOUT";
}

interface ReconJobData {
  orgId: string;
  payload: NombaWebhookPayload;
}

export function startReconWorker() {
  const worker = new Worker<ReconJobData>(
    "reconciliation",
    async (job) => {
      logger.info(
        {
          jobId: job.id,
          event: job.data.payload.event_type,
        },
        "Starting reconciliation job",
      );

      switch (job.data.payload.event_type) {
        case "payment_success":
          await processSuccessfulPayment(job, job.data.payload, job.data.orgId);
          break;

        case "payment_failed":
          await processFailedPayment(job.data.payload, job.data.orgId);
          break;

        default:
          logger.warn(
            {
              event: job.data.payload.event_type,
            },
            "Unknown webhook event",
          );
      }
    },
    {
      connection: redis as any,
      concurrency: 10,
    },
  );

  worker.on("completed", (job) => {
    logger.info(
      {
        jobId: job.id,
      },
      "Reconciliation completed",
    );
  });

  worker.on("failed", (job, err) => {
    logger.error(
      {
        jobId: job?.id,
        error: err,
      },
      "Reconciliation failed",
    );
  });

  worker.on("error", (err) => {
    logger.error(err, "BullMQ worker error");
  });

  process.on("SIGTERM", async () => {
    logger.info("Closing reconciliation worker...");
    await worker.close();
  });

  process.on("SIGINT", async () => {
    logger.info("Closing reconciliation worker...");
    await worker.close();
  });

  return worker;
}

export async function processSuccessfulPayment(job: any, payload: NombaWebhookPayload, orgId: string) {
  const tx = payload.data.transaction;

  let invoice;

  if (tx.type === "vact_transfer") {
    invoice = await prisma.invoice.findFirst({
      where: {
        orderReference: tx.aliasAccountReference,
        organizationId: orgId,
      },
      include: {
        customer: true,
      },
    });
  } else {
    invoice = await prisma.invoice.findUnique({
      where: {
        orderReference: tx.transactionId,
      },

      include: {
        customer: true,
      },
    });
  }

  if (!invoice) {
    throw new Error("Invoice not found");
  }

  const amount = new Prisma.Decimal(tx.transactionAmount);

  await prisma.$transaction(async (db) => {
    const paid = invoice.amountPaid.add(amount);

    const balance = invoice.totalAmount.sub(paid);

    await db.invoice.update({
      where: {
        id: invoice.id,
      },
      data: {
        amountPaid: paid,
        balanceDue: balance,
        status: balance.lt(0) ? "OVERPAID" : balance.eq(0) ? "PAID" : paid.gt(0) ? "PARTIALLY_PAID" : "PENDING",
        paidAt: balance.lte(0) ? new Date() : null,
      },
    });

    await db.ledgerEntry.create({
      data: {
        organizationId: orgId,
        invoiceId: invoice.id,
        customerId: invoice.customerId,
        entryType: "PAYMENT_RECEIVED",
        debitAmount: new Prisma.Decimal(0),
        creditAmount: amount,
        runningBalance: balance,
        reference: tx.transactionId,
        description: "Payment received",
      },
    });

    await db.webhookEvent.update({
      where: {
        nombaTransactionId: tx.transactionId,
      },
      data: {
        status: "PROCESSED",
        invoiceId: invoice.id,
        customerId: invoice.customer.id,
      },
    });
  });
}

export async function processFailedPayment(payload: NombaWebhookPayload, orgId: string) {
  const tx = payload.data.transaction;

  await prisma.webhookEvent.update({
    where: {
      nombaTransactionId: tx.transactionId,
    },
    data: {
      status: "FAILED",
    },
  });

  logger.warn({
    orgId,
    transaction: tx.transactionId,
    reason: tx.responseCodeMessage,
  });
}
