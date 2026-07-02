import { subHours, startOfDay, subDays } from "date-fns";
import { prisma } from "../services/prisma.service";
import { nombaTokenService, NombaApiResponse, NombaTransactionData } from "../services/nomba.service";
import { queues } from "../queues";
import { logger } from "../utils/logger";
import { env } from "../config/env";

export async function expireOverdueInvoices(): Promise<void> {
  const gracePeriodHours = 24;
  const expiryCutoff = subHours(new Date(), gracePeriodHours);

  const result = await prisma.invoice.updateMany({
    where: {
      status: { in: ["PENDING"] },
      dueDate: { lt: expiryCutoff },
    },
    data: {
      status: "EXPIRED",
      expiredAt: new Date(),
    },
  });

  if (result.count > 0) {
    logger.info({ expiredCount: result.count }, "Expired overdue invoices");
  }
}

export async function virtualAccountHealthCheck(orgId: string): Promise<void> {
  const accounts = await prisma.virtualAccount.findMany({
    where: { organizationId: orgId, status: "ACTIVE" },
  });

  const token = await nombaTokenService.getAccessToken().catch(() => "mock_token");
  if (token === "mock_token" || env.NOMBA_CLIENT_ID.includes("sandbox")) return;

  for (const va of accounts) {
    try {
      const res = await fetch(`${env.NOMBA_BASE_URL}/v1/accounts/virtual/${va.accountNumber}`, {
        headers: { Authorization: `Bearer ${token}`, accountId: env.NOMBA_MAIN_ACCOUNT_ID },
      });
      const json = (await res.json()) as NombaApiResponse<{ expired: boolean }>;
      if (json?.data?.expired) {
        await prisma.virtualAccount.update({ where: { id: va.id }, data: { status: "EXPIRED" } });
      }
    } catch (err) {
      logger.error({ err, accountNumber: va.accountNumber }, "Health check failed for VA");
    }
  }
}

interface NombaPaginatedTransactions {
  results: NombaTransactionData[];
  cursor?: string;
}

export async function nightlyGapFill(orgId: string): Promise<void> {
  const yesterday = startOfDay(subDays(new Date(), 1));
  const today = startOfDay(new Date());
  let cursor: string | undefined;
  let processed = 0,
    skipped = 0;

  const token = await nombaTokenService.getAccessToken().catch(() => "mock_token");
  if (token === "mock_token" || env.NOMBA_CLIENT_ID.includes("sandbox")) {
    logger.info({ orgId }, "Skipping Nomba Nightly Gap Fill in Sandbox/Mock Mode");
    return;
  }

  do {
    const url = new URL(`${env.NOMBA_BASE_URL}/v1/transactions/accounts`);
    url.searchParams.set("dateFrom", yesterday.toISOString());
    url.searchParams.set("dateTo", today.toISOString());
    url.searchParams.set("limit", "50");
    if (cursor) url.searchParams.set("cursor", cursor);

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}`, accountId: env.NOMBA_MAIN_ACCOUNT_ID },
    });
    const json = (await res.json()) as NombaApiResponse<NombaPaginatedTransactions>;
    const results = json?.data?.results || [];

    for (const tx of results) {
      const exists = await prisma.webhookEvent.findUnique({ where: { nombaTransactionId: tx.transactionId } });
      if (!exists) {
        await queues.reconciliation.add(
          "reconcile",
          {
            payload: { event_type: "payment_success", data: { transaction: tx } },
            orgId,
            paymentPath: tx.type === "vact_transfer" ? "BANK_TRANSFER" : "CHECKOUT",
          },
          { jobId: `gap-fill:${tx.transactionId}`, attempts: 3 },
        );
        processed++;
      } else {
        skipped++;
      }
    }
    cursor = json?.data?.cursor;
  } while (cursor);

  logger.info({ orgId, processed, skipped }, "Nightly Gap-Fill reconciliation complete");
}
