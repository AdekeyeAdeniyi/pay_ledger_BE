import { FastifyInstance } from "fastify";
import { prisma } from "../services/prisma.service";
import { authenticateJWT, requireRole } from "../middleware/auth.middleware";
import { writeAuditLog } from "../services/audit.service";
import { CreateCustomerSchema, UpdateCustomerSchema } from "../schemas/customer.schema";
import { AppError } from "../utils/errors";
import { queues } from "../queues";
import { CustomerStatus, CustomerType } from "../generated/enums";
import { Prisma } from "../generated/client";

export async function customerRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.addHook("preHandler", authenticateJWT);

  fastify.post(
    "/customers",
    { preHandler: [requireRole(["OWNER", "FINANCE_MANAGER"])], schema: { tags: ["Customers"], description: "Create recurring or one-time customer and provision VA", body: CreateCustomerSchema } },
    async (request) => {
      const body = CreateCustomerSchema.parse(request.body);
      const orgId = request.user!.org;

      if (body.email) {
        const existing = await prisma.customer.findUnique({ where: { organizationId_email: { organizationId: orgId, email: body.email } } });
        if (existing) throw new AppError("EMAIL_TAKEN", "Customer email already registered in this org", 409);
      }

      const org = await prisma.organization.findUnique({ where: { id: orgId } });
      const randomHex = Math.floor(1000 + Math.random() * 9000);
      const customerCode = `CUST-${org!.slug.slice(0, 12).toUpperCase()}-${randomHex}`;

      const customerType = body.customerType as CustomerType;
      const status: CustomerStatus = customerType === "RECURRING" ? "PENDING_VA" : "ACTIVE";

      const customer = await prisma.customer.create({
        data: {
          organizationId: orgId,
          name: body.name,
          email: body.email || null,
          phone: body.phone,
          customerCode,
          customerType,
          status,
          notes: body.notes,
        },
      });

      if (customerType === "RECURRING") {
        await queues.createVirtualAccount.add("create-virtual-account", {
          orgId,
          customerId: customer.id,
          customerName: customer.name,
          email: customer.email,
          phone: customer.phone,
          accountRef: customer.customerCode,
        });
      }

      await writeAuditLog({ organizationId: orgId, userId: request.user!.sub, action: "CUSTOMER_CREATED", entity: "Customer", entityId: customer.id });
      return { success: true, data: [] };
    },
  );

  fastify.get<{ Querystring: { page?: string; limit?: string; search?: string; status?: CustomerStatus } }>(
    "/customers",
    { schema: { tags: ["Customers"], description: "Paginated list of organization customers" } },
    async (request) => {
      const orgId = request.user!.org;
      const page = Number(request.query.page) || 1;
      const limit = Number(request.query.limit) || 20;
      const skip = (page - 1) * limit;

      const where: Prisma.CustomerWhereInput = {
        organizationId: orgId,
        ...(request.query.status && { status: request.query.status }),
        ...(request.query.search && {
          OR: [
            { name: { contains: request.query.search, mode: "insensitive" } },
            { email: { contains: request.query.search, mode: "insensitive" } },
            { customerCode: { contains: request.query.search, mode: "insensitive" } },
          ],
        }),
      };

      const [customers, total] = await Promise.all([
        prisma.customer.findMany({
          where,
          skip,
          take: limit,
          orderBy: { createdAt: "desc" },
          include: { virtualAccount: { select: { accountNumber: true, bankName: true, status: true } } },
        }),
        prisma.customer.count({ where }),
      ]);

      return { success: true, data: customers, meta: { page, limit, total } };
    },
  );

  fastify.get<{ Params: { id: string } }>("/customers/:id", { schema: { tags: ["Customers"], description: "Retrieve specific customer profile and virtual account" } }, async (request) => {
    const customerId = request.params.id;
    const orgId = request.user!.org;
    const customer = await prisma.customer.findFirst({
      where: { id: customerId, organizationId: orgId },
      include: { virtualAccount: true },
    });
    if (!customer) throw new AppError("CUSTOMER_NOT_FOUND", "Customer not found", 404);

    return { success: true, data: customer };
  });

  fastify.put<{ Params: { id: string } }>(
    "/customers/:id",
    { preHandler: [requireRole(["OWNER", "FINANCE_MANAGER"])], schema: { tags: ["Customers"], description: "Update customer contact info and notes", body: UpdateCustomerSchema } },
    async (request) => {
      const body = UpdateCustomerSchema.parse(request.body);
      const customer = await prisma.customer.update({
        where: { id: request.params.id },
        data: body,
      });
      await writeAuditLog({ organizationId: request.user!.org, userId: request.user!.sub, action: "CUSTOMER_UPDATED", entity: "Customer", entityId: customer.id });
      return { success: true, data: customer };
    },
  );

  fastify.post<{ Params: { id: string } }>(
    "/customers/:id/deactivate",
    { preHandler: [requireRole(["OWNER"])], schema: { tags: ["Customers"], description: "Deactivate customer and suspend virtual account" } },
    async (request) => {
      const customer = await prisma.customer.update({
        where: { id: request.params.id },
        data: { status: "INACTIVE" },
      });
      await prisma.virtualAccount.updateMany({
        where: { customerId: customer.id },
        data: { status: "SUSPENDED" },
      });
      await writeAuditLog({ organizationId: request.user!.org, userId: request.user!.sub, action: "CUSTOMER_DEACTIVATED", entity: "Customer", entityId: customer.id });
      return { success: true, data: customer };
    },
  );

  fastify.post<{ Params: { id: string } }>(
    "/customers/:id/reactivate",
    { preHandler: [requireRole(["OWNER"])], schema: { tags: ["Customers"], description: "Reactivate customer and virtual account" } },
    async (request) => {
      const customer = await prisma.customer.update({
        where: { id: request.params.id },
        data: { status: "ACTIVE" },
      });
      await prisma.virtualAccount.updateMany({
        where: { customerId: customer.id },
        data: { status: "ACTIVE" },
      });
      await writeAuditLog({ organizationId: request.user!.org, userId: request.user!.sub, action: "CUSTOMER_REACTIVATED", entity: "Customer", entityId: customer.id });
      return { success: true, data: customer };
    },
  );

  fastify.get<{ Params: { id: string } }>("/customers/:id/ledger", { schema: { tags: ["Customers"], description: "List double-entry ledger history for customer" } }, async (request) => {
    const entries = await prisma.ledgerEntry.findMany({
      where: { customerId: request.params.id, organizationId: request.user!.org },
      orderBy: { postedAt: "desc" },
    });
    return { success: true, data: entries };
  });

  fastify.get<{ Params: { id: string } }>("/customers/:id/invoices", { schema: { tags: ["Customers"], description: "List all invoices issued to customer" } }, async (request) => {
    const invoices = await prisma.invoice.findMany({
      where: { customerId: request.params.id, organizationId: request.user!.org },
      orderBy: { createdAt: "desc" },
    });
    return { success: true, data: invoices };
  });
}
