import { Prisma } from "../generated/client";

export type InvoiceWithRelations = Prisma.InvoiceGetPayload<{
  include: {
    customer: true;
    lineItems: true;
    ledgerEntries: true;
  };
}>;

export type VirtualBankDetails = Prisma.VirtualAccountGetPayload<{}>;
