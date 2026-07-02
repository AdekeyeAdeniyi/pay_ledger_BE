import { FastifyInstance } from "fastify";
import { authenticateJWT, requireRole } from "../middleware/auth.middleware";
import { prisma } from "../services/prisma.service";

export async function reportRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.addHook("preHandler", authenticateJWT);

  fastify.get(
    "/reports/receivables",
    { preHandler: [requireRole(["OWNER", "FINANCE_MANAGER"])], schema: { tags: ["Reports"], description: "Get aged customer receivables and debt breakdown" } },
    async (request) => {
      const orgId = request.user!.org;
      const customers = await prisma.customer.findMany({
        where: { organizationId: orgId, outstandingDebt: { gt: 0 } },
        select: { id: true, name: true, customerCode: true, outstandingDebt: true, creditBalance: true },
        orderBy: { outstandingDebt: "desc" },
      });
      return { success: true, data: customers };
    },
  );

  fastify.get("/reports/collection", { schema: { tags: ["Reports"], description: "Daily/weekly/monthly payment collections report" } }, async (request) => {
    const orgId = request.user!.org;
    const entries = await prisma.ledgerEntry.findMany({
      where: { organizationId: orgId, entryType: { in: ["PAYMENT_RECEIVED", "PARTIAL_PAYMENT", "OVERPAYMENT"] } },
      orderBy: { postedAt: "desc" },
      take: 100,
    });
    return { success: true, data: entries };
  });

  fastify.get("/reports/payment-history", { schema: { tags: ["Reports"], description: "Retrieve all ledger posting transactions" } }, async (request) => {
    const entries = await prisma.ledgerEntry.findMany({
      where: { organizationId: request.user!.org },
      orderBy: { postedAt: "desc" },
      take: 50,
    });
    return { success: true, data: entries };
  });

  fastify.get(
    "/reports/reconciliation-status",
    { preHandler: [requireRole(["OWNER", "FINANCE_MANAGER"])], schema: { tags: ["Reports"], description: "Audit status of processed vs suspense webhooks" } },
    async (request) => {
      const events = await prisma.webhookEvent.findMany({
        where: { organizationId: request.user!.org },
        orderBy: { createdAt: "desc" },
        take: 50,
      });
      return { success: true, data: events };
    },
  );

  fastify.get<{ Params: { id: string } }>(
    "/reports/customer/:id/statement",
    { schema: { tags: ["Reports"], description: "Generate full double-entry statement of account for customer" } },
    async (request) => {
      const [customer, entries] = await Promise.all([
        prisma.customer.findFirst({ where: { id: request.params.id, organizationId: request.user!.org } }),
        prisma.ledgerEntry.findMany({ where: { customerId: request.params.id, organizationId: request.user!.org }, orderBy: { postedAt: "asc" } }),
      ]);
      return { success: true, data: { customer, entries } };
    },
  );
}
