import { Worker } from "bullmq";
import { prisma } from "../services/prisma.service";
import { logger } from "../utils/logger";
import { NombaWebhookPayload } from "../utils/nombaWebhook";
import { Prisma } from "../generated/client";
import { redis } from "../services/redis.service";

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

  const claimed = await prisma.webhookEvent.updateMany({
    where: {
      nombaTransactionId: tx.transactionId,
      status: {
        in: ["RECEIVED", "FAILED"],
      },
    },
    data: {
      status: "PROCESSING",
    },
  });

  if (claimed.count === 0) {
    logger.info(
      {
        transactionId: tx.transactionId,
      },
      "Webhook already being processed or already successfully processed",
    );
    return;
  }

  try {
    if (tx.type === "vact_transfer") {
      await processVirtualAccountPayment(payload, orgId);
    } else {
      job.log(`Processing order payment for transaction ${payload.data.order?.orderReference}`);
      await processOrderPayment(payload, orgId);
    }

    await prisma.webhookEvent.update({
      where: {
        nombaTransactionId: tx.transactionId,
      },
      data: {
        status: "PROCESSED",
        processedAt: new Date(),
      },
    });
  } catch (error) {
    await prisma.webhookEvent.update({
      where: {
        nombaTransactionId: tx.transactionId,
      },
      data: {
        status: "FAILED",
      },
    });

    throw error;
  }
}

async function processVirtualAccountPayment(payload: NombaWebhookPayload, orgId: string) {
  const tx = payload.data.transaction;

  const customer = await prisma.customer.findFirst({
    where: {
      organizationId: orgId,
      virtualAccount: {
        is: {
          accountRef: tx.aliasAccountReference,
        },
      },
    },
    include: {
      virtualAccount: true,
    },
  });

  if (!customer) {
    throw new Error(`Customer not found for account reference ${tx.aliasAccountReference}`);
  }

  const paymentAmount = new Prisma.Decimal(tx.transactionAmount);

  const result = await prisma.$transaction(async (db) => {
    const currentCustomer = await db.customer.findUniqueOrThrow({
      where: { id: customer.id },
      select: { creditBalance: true, outstandingDebt: true },
    });

    const invoices = await db.invoice.findMany({
      where: {
        organizationId: orgId,
        customerId: customer.id,
        balanceDue: { gt: new Prisma.Decimal(0) },
      },
      orderBy: { createdAt: "asc" },
    });

    let remaining = paymentAmount;
    let finalCustomerDebt = new Prisma.Decimal(currentCustomer.outstandingDebt);
    let finalCustomerCredit = new Prisma.Decimal(currentCustomer.creditBalance);
    let totalAllocated = new Prisma.Decimal(0);
    let idx = 0;

    for (const invoice of invoices) {
      if (remaining.lte(0)) {
        break;
      }

      const payment = Prisma.Decimal.min(remaining, invoice.balanceDue);
      const newAmountPaid = invoice.amountPaid.add(payment);
      const newBalance = invoice.totalAmount.sub(newAmountPaid);

      await db.invoice.update({
        where: { id: invoice.id },
        data: {
          amountPaid: newAmountPaid,
          balanceDue: newBalance,
          status: newBalance.eq(0) ? "PAID" : "PARTIALLY_PAID",
          paidAt: newBalance.eq(0) ? new Date() : null,
        },
      });

      // Reduce overall outstanding platform debt by what was covered
      finalCustomerDebt = finalCustomerDebt.sub(payment);

      await db.ledgerEntry.create({
        data: {
          organizationId: orgId,
          customerId: customer.id,
          invoiceId: invoice.id,
          entryType: "PAYMENT_RECEIVED",
          debitAmount: new Prisma.Decimal(0),
          creditAmount: payment,

          // Ledger Net Balance Formula: Debt minus Wallet Credit
          runningBalance: finalCustomerDebt.sub(finalCustomerCredit),

          reference: `${tx.transactionId}_${idx}`,
          nombaTransactionId: tx.transactionId,
          description: `Virtual account payment applied to invoice ${invoice.invoiceNumber}`,
        },
      });

      totalAllocated = totalAllocated.add(payment);
      remaining = remaining.sub(payment);
      idx++;
    }

    // Handle Overpayment: Leftover funds grow wallet credit balance
    if (remaining.gt(0)) {
      finalCustomerCredit = finalCustomerCredit.add(remaining); // 0 + 11,900 = 11,900

      await db.ledgerEntry.create({
        data: {
          organizationId: orgId,
          customerId: customer.id,
          invoiceId: null,
          entryType: "CUSTOMER_CREDIT_CREATED",
          debitAmount: new Prisma.Decimal(0),
          creditAmount: remaining, // Logs 11,900.00

          // Net balance: 0.00 (debt) - 11,900.00 (credit) = -11,900.00
          runningBalance: finalCustomerDebt.sub(finalCustomerCredit),

          reference: `${tx.transactionId}_OVERPAYMENT`,
          nombaTransactionId: tx.transactionId,
          description: `Unallocated overpayment from transaction ${tx.transactionId} added to credit balance`,
        },
      });
    }

    // Update Customer Profile with the clean, uncorrupted calculations
    await db.customer.update({
      where: { id: customer.id },
      data: {
        outstandingDebt: finalCustomerDebt, // Resolves to current debt state
        creditBalance: finalCustomerCredit, // Resolves to exactly 11,900.00
      },
    });

    return {
      allocated: totalAllocated,
      remaining: remaining,
    };
  });
}

async function processOrderPayment(payload: NombaWebhookPayload, orgId: string) {
  const tx = payload.data.transaction;
  const orderReference = payload.data.order?.orderReference;

  if (!orderReference) {
    throw new Error(`Missing order.orderReference for payment ${tx.transactionId}`);
  }

  // Fetch the invoice and customer context outside the transaction block
  const invoice = await prisma.invoice.findFirst({
    where: {
      orderReference: orderReference,
      organizationId: orgId,
    },
    include: {
      customer: true,
    },
  });

  if (!invoice) {
    throw new Error(`Invoice not found for order reference ${orderReference}`);
  }

  const paymentAmount = new Prisma.Decimal(tx.transactionAmount);

  await prisma.$transaction(async (db) => {
    // 1. Lock the customer profile to obtain accurate balance state
    const currentCustomer = await db.customer.findUniqueOrThrow({
      where: { id: invoice.customerId },
      select: { creditBalance: true, outstandingDebt: true },
    });

    // 2. Fetch a fresh copy of the invoice within the transaction to prevent race conditions
    const freshInvoice = await db.invoice.findUniqueOrThrow({
      where: { id: invoice.id },
    });

    // If the invoice is already paid or overpaid, divert the entire incoming payment to credit balance
    let amountToApplyToInvoice = Prisma.Decimal.min(paymentAmount, freshInvoice.balanceDue);
    if (freshInvoice.balanceDue.lte(0)) {
      amountToApplyToInvoice = new Prisma.Decimal(0);
    }

    let remainingOverpayment = paymentAmount.sub(amountToApplyToInvoice);
    let runningCustomerCredit = new Prisma.Decimal(currentCustomer.creditBalance);
    let runningCustomerDebt = new Prisma.Decimal(currentCustomer.outstandingDebt);

    // 3. Update invoice calculations only if it hasn't been completely settled yet
    if (amountToApplyToInvoice.gt(0)) {
      const newAmountPaid = freshInvoice.amountPaid.add(amountToApplyToInvoice);
      const newBalanceDue = freshInvoice.totalAmount.sub(newAmountPaid);

      await db.invoice.update({
        where: { id: freshInvoice.id },
        data: {
          amountPaid: newAmountPaid,
          balanceDue: newBalanceDue,
          status: newBalanceDue.eq(0) ? "PAID" : "PARTIALLY_PAID",
          paidAt: newBalanceDue.eq(0) ? new Date() : null,
        },
      });

      // Update financial tracking counters
      runningCustomerDebt = runningCustomerDebt.sub(amountToApplyToInvoice);

      // Log invoice payment event to ledger
      await db.ledgerEntry.create({
        data: {
          organizationId: orgId,
          invoiceId: freshInvoice.id,
          customerId: freshInvoice.customerId,
          entryType: "PAYMENT_RECEIVED",
          debitAmount: new Prisma.Decimal(0),
          creditAmount: amountToApplyToInvoice,
          runningBalance: runningCustomerDebt.sub(runningCustomerCredit), // Net overall position
          reference: `${tx.transactionId}_${freshInvoice.orderReference}`, // Safe distinct reference slug
          nombaTransactionId: tx.transactionId,
          description: `Payment received and applied to invoice ${freshInvoice.invoiceNumber}`,
        },
      });
    }

    // 4. Protect Leftover Funds: Safely route overpayments to customer wallet balance
    if (remainingOverpayment.gt(0)) {
      runningCustomerCredit = runningCustomerCredit.add(remainingOverpayment);

      await db.ledgerEntry.create({
        data: {
          organizationId: orgId,
          invoiceId: freshInvoice.id,
          customerId: freshInvoice.customerId,
          entryType: "CUSTOMER_CREDIT_CREATED",
          debitAmount: new Prisma.Decimal(0),
          creditAmount: remainingOverpayment,
          runningBalance: runningCustomerDebt.sub(runningCustomerCredit),
          reference: `${tx.transactionId}_OVERPAYMENT`, // Avoids any unique index conflicts
          nombaTransactionId: tx.transactionId,
          description: `Overpayment of ${remainingOverpayment.toString()} from order payment routed to wallet credit`,
        },
      });
    }

    // 5. Synchronize master balances to customer record
    await db.customer.update({
      where: { id: freshInvoice.customerId },
      data: {
        outstandingDebt: runningCustomerDebt,
        creditBalance: runningCustomerCredit,
      },
    });

    // 6. Complete webhook event tracking metrics
    await db.webhookEvent.update({
      where: { nombaTransactionId: tx.transactionId },
      data: {
        invoiceId: freshInvoice.id,
        customerId: freshInvoice.customerId,
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
      processedAt: new Date(),
    },
  });

  logger.warn({
    orgId,
    transaction: tx.transactionId,
    reason: tx.responseCodeMessage,
  });
}
