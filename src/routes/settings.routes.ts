import { FastifyInstance } from "fastify";
import bcrypt from "bcrypt";
import { prisma } from "../services/prisma.service";
import { authenticateJWT, requireRole } from "../middleware/auth.middleware";
import { writeAuditLog } from "../services/audit.service";
import { AppError } from "../utils/errors";
import { z } from "zod";

export async function settingsRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.addHook("preHandler", authenticateJWT);

  fastify.get("/settings/profile", { schema: { tags: ["Settings"], description: "Retrieve current user profile settings" } }, async (request) => {
    const user = await prisma.user.findUnique({
      where: { id: request.user!.sub },
      select: { id: true, name: true, email: true, role: true, isActive: true, lastLoginAt: true, createdAt: true },
    });
    return { success: true, data: user };
  });

  fastify.put("/settings/profile", { schema: { tags: ["Settings"], description: "Update current user display name" } }, async (request) => {
    const schema = z.object({ name: z.string().min(2) });
    const { name } = schema.parse(request.body);
    const user = await prisma.user.update({
      where: { id: request.user!.sub },
      data: { name },
      select: { id: true, name: true, email: true, role: true },
    });
    return { success: true, data: user };
  });

  fastify.put("/settings/password", { schema: { tags: ["Settings"], description: "Change current user password" } }, async (request) => {
    const schema = z.object({ oldPassword: z.string().min(1), newPassword: z.string().min(8) });
    const { oldPassword, newPassword } = schema.parse(request.body);
    const user = await prisma.user.findUnique({ where: { id: request.user!.sub } });
    if (!user || !(await bcrypt.compare(oldPassword, user.passwordHash))) {
      throw new AppError("INVALID_CREDENTIALS", "Old password is incorrect", 400);
    }
    const passwordHash = await bcrypt.hash(newPassword, 12);
    await prisma.user.update({ where: { id: user.id }, data: { passwordHash } });
    return { success: true, message: "Password updated successfully" };
  });

  fastify.get("/settings/org", { schema: { tags: ["Settings"], description: "Get organization business settings and Nomba parent ID" } }, async (request) => {
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
        nombaAccountId: true,
      },
    });
    return { success: true, data: org };
  });

  fastify.put("/settings/org", { preHandler: [requireRole(["OWNER"])], schema: { tags: ["Settings"], description: "Update organization Nomba account ID and WhatsApp numbers" } }, async (request) => {
    const schema = z.object({ name: z.string().optional(), phone: z.string().optional(), whatsappNumber: z.string().optional(), nombaAccountId: z.string().optional() });
    const body = schema.parse(request.body);
    const org = await prisma.organization.update({
      where: { id: request.user!.org },
      data: body,
      select: { id: true, name: true, slug: true, email: true, phone: true, whatsappNumber: true, nombaAccountId: true },
    });
    await writeAuditLog({ organizationId: org.id, userId: request.user!.sub, action: "SETTINGS_UPDATED", entity: "Organization", entityId: org.id });
    return { success: true, data: org };
  });
}
