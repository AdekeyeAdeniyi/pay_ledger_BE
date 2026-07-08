import { FastifyInstance } from "fastify";
import { prisma } from "../services/prisma.service";
import { authenticateJWT, requireRole } from "../middleware/auth.middleware";
import { writeAuditLog } from "../services/audit.service";
import { UpdateProfileSchema } from "../schemas/auth.schema";
import { Prisma } from "../generated/client";

export async function orgRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.addHook("preHandler", authenticateJWT);

  fastify.get(
    "/dashboard/stats",
    {
      schema: {
        tags: ["Dashboard"],
        description: "Get organization dashboard statistics",
      },
    },
    async (request) => {
      const orgId = request.user!.org;

      const [totalCollected, totalInvoiceValue, outstandingDebt, customerCredit, activeCustomers, totalInvoices, latestInvoices] = await Promise.all([
        // Total money received
        prisma.ledgerEntry.aggregate({
          where: {
            organizationId: orgId,
            entryType: {
              in: ["PAYMENT_RECEIVED", "CUSTOMER_CREDIT_APPLIED"],
            },
          },
          _sum: {
            creditAmount: true,
          },
        }),

        // Total value of all invoices created
        prisma.invoice.aggregate({
          where: {
            organizationId: orgId,
          },
          _sum: {
            totalAmount: true,
          },
        }),

        // Total outstanding debt
        prisma.customer.aggregate({
          where: {
            organizationId: orgId,
          },
          _sum: {
            outstandingDebt: true,
          },
        }),

        // Total customer credit
        prisma.customer.aggregate({
          where: {
            organizationId: orgId,
          },
          _sum: {
            creditBalance: true,
          },
        }),

        // Active customers
        prisma.customer.count({
          where: {
            organizationId: orgId,
            status: "ACTIVE",
          },
        }),

        // Total invoices
        prisma.invoice.count({
          where: {
            organizationId: orgId,
          },
        }),

        // Five latest invoices
        prisma.invoice.findMany({
          where: {
            organizationId: orgId,
          },
          take: 5,
          orderBy: {
            createdAt: "desc",
          },
          select: {
            id: true,
            invoiceNumber: true,
            totalAmount: true,
            amountPaid: true,
            balanceDue: true,
            status: true,
            dueDate: true,
            createdAt: true,

            customer: {
              select: {
                id: true,
                name: true,
                customerCode: true,
                email: true,
                phone: true,
                outstandingDebt: true,
                creditBalance: true,

                virtualAccount: {
                  select: {
                    accountName: true,
                    accountNumber: true,
                    accountRef: true,
                    bankName: true,
                  },
                },
              },
            },
          },
        }),
      ]);

      return {
        success: true,
        data: {
          overview: {
            totalAmountCollected: totalCollected._sum.creditAmount ?? new Prisma.Decimal(0),

            totalInvoiceValue: totalInvoiceValue._sum.totalAmount ?? new Prisma.Decimal(0),

            outstandingBalance: outstandingDebt._sum.outstandingDebt ?? new Prisma.Decimal(0),

            excessCreditReceived: customerCredit._sum.creditBalance ?? new Prisma.Decimal(0),

            activeCustomers,
            totalInvoices,
          },

          latestInvoices,
        },
      };
    },
  );

  fastify.get("/org/profile", { schema: { tags: ["Organization"], description: "Get organization profile details" } }, async (request) => {
    const org = await prisma.organization.findUnique({
      where: { id: request.user!.org },
      select: {
        id: true,
        name: true,
        slug: true,
        email: true,
        phone: true,
        logoUrl: true,
        whatsappNumber: true,
        notifyOnPayment: true,
        notifyDailySummary: true,
        notifyWeeklySummary: true,
        createdAt: true,
      },
    });
    return { success: true, data: org };
  });

  fastify.put(
    "/org/profile",
    { preHandler: [requireRole(["OWNER"])], schema: { tags: ["Organization"], description: "Update organization profile and notification preferences" } },
    async (request) => {
      const body = UpdateProfileSchema.parse(request.body);
      const org = await prisma.organization.update({
        where: { id: request.user!.org },
        data: body,
        select: { id: true, name: true, slug: true, email: true, phone: true, logoUrl: true, whatsappNumber: true, notifyOnPayment: true, notifyDailySummary: true, notifyWeeklySummary: true },
      });

      await writeAuditLog({ organizationId: org.id, userId: request.user!.sub, action: "ORG_UPDATED", entity: "Organization", entityId: org.id, metadata: body });
      return { success: true, data: org };
    },
  );
}
