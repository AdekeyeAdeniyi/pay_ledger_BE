import { FastifyInstance } from "fastify";
import { prisma } from "../services/prisma.service";
import { authenticateJWT, requireRole } from "../middleware/auth.middleware";
import { writeAuditLog } from "../services/audit.service";
import { UpdateProfileSchema } from "../schemas/auth.schema";

export async function orgRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.addHook("preHandler", authenticateJWT);

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
