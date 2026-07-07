import { Worker } from "bullmq";
import { redis } from "../services/redis.service";
import { prisma } from "../services/prisma.service";
import { createNombaVirtualAccount } from "../services/nomba.service";
import { env } from "../config/env";
import { logger } from "../utils/logger";
import { writeAuditLog } from "../services/audit.service";

export function startVaWorker() {
  const worker = new Worker(
    "create-virtual-account",
    async (job) => {
      if (job.name !== "create-virtual-account") return;

      const { orgId, customerId, customerName, email, phone, accountRef } = job.data;

      logger.info({ customerId }, "Processing create-virtual-account job");

      try {
        const vaData = await createNombaVirtualAccount({
          accountRef,
          accountName: customerName,
          callbackUrl: `${env.BASE_URL}/webhooks/nomba/${orgId}`,
          email: email ?? undefined,
          phone: phone ?? undefined,
        });

        await prisma.$transaction(async (tx) => {
          await tx.virtualAccount.create({
            data: {
              customerId,
              organizationId: orgId,
              accountRef: vaData.accountRef,
              accountNumber: vaData.bankAccountNumber,
              accountName: vaData.bankAccountName,
              bankName: vaData.bankName,
              accountHolderId: vaData.accountHolderId,
              status: "ACTIVE",
            },
          });

          await tx.customer.update({
            where: { id: customerId },
            data: { status: "ACTIVE" },
          });
        });

        await writeAuditLog({ organizationId: orgId, action: "VA_PROVISIONED", entity: "VirtualAccount", entityId: customerId });
        logger.info({ customerId, accountNumber: vaData.bankAccountNumber }, "Provisioned Virtual Account successfully");
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        logger.error({ err, customerId }, "Failed to provision virtual account");
        await writeAuditLog({ organizationId: orgId, action: "VA_PROVISIONING_FAILED", entity: "Customer", entityId: customerId, metadata: { error: errorMessage } });
        throw err;
      }
    },
    { connection: redis as any },
  );

  worker.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, err }, "VA Worker job failed");
  });

  return worker;
}
