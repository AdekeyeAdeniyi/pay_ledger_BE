import { FastifyInstance } from "fastify";
import { Prisma } from "../generated/client";
import { prisma } from "../services/prisma.service";
import { authenticateJWT } from "../middleware/auth.middleware";

export async function transactionRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", authenticateJWT);
  fastify.get(
    "/transactions",
    {
      schema: {
        tags: ["Transactions"],
        description: "Get all organization transactions",
      },
    },
    async (request) => {
      const orgId = request.user!.org;

      const {
        page = "1",
        limit = "20",
        customerId,
        invoiceId,
        entryType,
        from,
        to,
      } = request.query as {
        page?: string;
        limit?: string;
        customerId?: string;
        invoiceId?: string;
        entryType?: string;
        from?: string;
        to?: string;
      };

      const pageNumber = Math.max(Number(page), 1);
      const pageSize = Math.min(Number(limit), 100);

      const where: Prisma.LedgerEntryWhereInput = {
        organizationId: orgId,

        entryType: {
          not: "INVOICE_CREATED",
        },

        ...(customerId && {
          customerId,
        }),

        ...(invoiceId && {
          invoiceId,
        }),

        ...(entryType && {
          entryType: entryType as any,
        }),

        ...(from || to
          ? {
              createdAt: {
                ...(from && {
                  gte: new Date(from),
                }),
                ...(to && {
                  lte: new Date(to),
                }),
              },
            }
          : {}),
      };

      const [transactions, total] = await Promise.all([
        prisma.ledgerEntry.findMany({
          where,

          skip: (pageNumber - 1) * pageSize,
          take: pageSize,
          orderBy: {
            postedAt: "desc",
          },
          include: {
            customer: {
              select: {
                id: true,
                name: true,
                customerCode: true,
                email: true,
                phone: true,
              },
            },

            invoice: {
              select: {
                id: true,
                invoiceNumber: true,
                totalAmount: true,
                amountPaid: true,
                balanceDue: true,
                status: true,
                dueDate: true,
              },
            },
          },
        }),

        prisma.ledgerEntry.count({
          where,
        }),
      ]);

      return {
        success: true,
        data: {
          transactions,

          pagination: {
            page: pageNumber,
            limit: pageSize,
            total,
            totalPages: Math.ceil(total / pageSize),
            hasNext: pageNumber * pageSize < total,
            hasPrevious: pageNumber > 1,
          },
        },
      };
    },
  );
}
