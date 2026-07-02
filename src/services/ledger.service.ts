import { Prisma } from "../generated/client";
import { LedgerEntryType } from "../generated/enums";
import { prisma } from "./prisma.service";

export interface LedgerEntryParams {
  type: LedgerEntryType;
  organizationId: string;
  customerId: string;
  invoiceId?: string | null;
  debitAmount: Prisma.Decimal | number | string;
  creditAmount: Prisma.Decimal | number | string;
  description: string;
  reference?: string;
  nombaTransactionId?: string | null;
  createdBy?: string;
}

export async function postLedgerEntry(tx: Prisma.TransactionClient, params: LedgerEntryParams) {
  const debit = new Prisma.Decimal(params.debitAmount);
  const credit = new Prisma.Decimal(params.creditAmount);

  // Acquire row-level lock on last ledger entry for this customer
  const lastEntry = await tx.$queryRaw<Array<{ runningBalance: Prisma.Decimal }>>`
    SELECT "runningBalance"
    FROM "LedgerEntry"
    WHERE "customerId" = ${params.customerId}
    ORDER BY "postedAt" DESC
    LIMIT 1
    FOR UPDATE SKIP LOCKED
  `;

  const currentBalance = lastEntry && lastEntry.length > 0 ? new Prisma.Decimal(lastEntry[0].runningBalance) : new Prisma.Decimal(0);
  const runningBalance = currentBalance.add(debit).sub(credit);

  return tx.ledgerEntry.create({
    data: {
      organizationId: params.organizationId,
      customerId: params.customerId,
      invoiceId: params.invoiceId ?? null,
      entryType: params.type,
      debitAmount: debit,
      creditAmount: credit,
      runningBalance,
      description: params.description,
      reference: params.reference ?? "",
      nombaTransactionId: params.nombaTransactionId ?? null,
      createdBy: params.createdBy ?? "SYSTEM",
    },
  });
}

export async function postLedgerEntryDirect(params: LedgerEntryParams) {
  return prisma.$transaction(async (tx) => {
    return postLedgerEntry(tx, params);
  });
}
