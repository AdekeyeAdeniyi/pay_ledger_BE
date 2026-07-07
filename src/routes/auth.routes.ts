import { FastifyInstance } from "fastify";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { randomBytes, randomUUID } from "crypto";
import { prisma } from "../services/prisma.service";
import { redis } from "../services/redis.service";
import { env } from "../config/env";
import { AppError } from "../utils/errors";
import { writeAuditLog } from "../services/audit.service";
import { RegisterOrgSchema, LoginSchema } from "../schemas/auth.schema";
import { authenticateJWT } from "../middleware/auth.middleware";
import { queues } from "../queues";

export async function authRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post("/auth/register", { schema: { tags: ["Auth"], description: "Register new organization and owner user account", body: RegisterOrgSchema } }, async (request, reply) => {
    const body = RegisterOrgSchema.parse(request.body);

    const existingUser = await prisma.user.findUnique({ where: { email: body.email } });
    if (existingUser) {
      throw new AppError("EMAIL_TAKEN", "Email is already registered", 409);
    }

    const passwordHash = await bcrypt.hash(body.password, 12);

    const slug =
      body.businessName
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "-")
        .replace(/-+/g, "-") +
      "-" +
      randomBytes(3).toString("hex");

    const result = await prisma.$transaction(async (tx) => {
      const org = await tx.organization.create({
        data: {
          name: body.businessName,
          slug,
          email: body.email,
          phone: body.phone,
        },
      });

      const user = await tx.user.create({
        data: {
          organizationId: org.id,
          name: body.businessName,
          email: body.email,
          passwordHash,
          role: "OWNER",
        },
      });

      return { org, user };
    });

    const jti = randomUUID();
    const accessToken = jwt.sign({ sub: result.user.id, org: result.org.id, role: result.user.role, jti }, env.JWT_SECRET, { expiresIn: env.JWT_EXPIRES_IN as any });

    const refreshToken = randomUUID();
    await redis.setex(`refresh:${refreshToken}`, 86400 * env.REFRESH_TOKEN_TTL_DAYS, JSON.stringify({ userId: result.user.id, orgId: result.org.id }));

    reply.setCookie("refresh_token", refreshToken, {
      httpOnly: true,
      secure: env.NODE_ENV === "production",
      sameSite: env.NODE_ENV === "production" ? "none" : "lax",
      path: "/",
      maxAge: 86400 * env.REFRESH_TOKEN_TTL_DAYS,
    });

    await queues.notifications.add("welcome-email", { email: result.user.email, name: result.user.name });
    await writeAuditLog({ organizationId: result.org.id, userId: result.user.id, action: "ORG_CREATED", entity: "Organization", entityId: result.org.id });

    return {
      success: true,
      data: {
        org: { id: result.org.id, name: result.org.name, slug: result.org.slug },
        user: { id: result.user.id, name: result.user.name, email: result.user.email, role: result.user.role },
        access_token: accessToken,
        refresh_token: refreshToken,
      },
    };
  });

  fastify.post("/auth/login", { schema: { tags: ["Auth"], description: "Authenticate user credentials and obtain JWT session", body: LoginSchema } }, async (request, reply) => {
    const { email, password } = LoginSchema.parse(request.body);

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      throw new AppError("INVALID_CREDENTIALS", "Invalid email or password", 401);
    }

    if (!user.isActive) {
      throw new AppError("INSUFFICIENT_PERMISSIONS", "User account is inactive", 403);
    }

    await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

    const jti = randomUUID();
    const accessToken = jwt.sign({ sub: user.id, org: user.organizationId, role: user.role, jti }, env.JWT_SECRET, { expiresIn: env.JWT_EXPIRES_IN as any });

    const refreshToken = randomUUID();
    await redis.setex(`refresh:${refreshToken}`, 86400 * env.REFRESH_TOKEN_TTL_DAYS, JSON.stringify({ userId: user.id, orgId: user.organizationId }));

    reply.setCookie("refresh_token", refreshToken, {
      httpOnly: true,
      secure: env.NODE_ENV === "production",
      sameSite: env.NODE_ENV === "production" ? "none" : "lax",
      path: "/",
      maxAge: 86400 * env.REFRESH_TOKEN_TTL_DAYS,
    });

    await writeAuditLog({ organizationId: user.organizationId, userId: user.id, action: "USER_LOGIN", entity: "User", entityId: user.id });

    return { success: true, data: { access_token: accessToken, refresh_token: refreshToken, user: { id: user.id, name: user.name, email: user.email, role: user.role, orgId: user.organizationId } } };
  });

  fastify.post<{ Body: { refresh_token?: string } }>("/auth/refresh", { schema: { tags: ["Auth"], description: "Rotate access and refresh tokens" } }, async (request, reply) => {
    const refreshToken = request.cookies.refresh_token || request.body?.refresh_token;
    if (!refreshToken) {
      throw new AppError("TOKEN_EXPIRED", "Missing refresh token", 401);
    }

    const sessionStr = await redis.get(`refresh:${refreshToken}`);
    if (!sessionStr) {
      throw new AppError("TOKEN_EXPIRED", "Invalid or expired refresh token", 401);
    }

    const { userId, orgId } = JSON.parse(sessionStr) as { userId: string; orgId: string };
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.isActive) {
      throw new AppError("TOKEN_EXPIRED", "User account inactive or deleted", 401);
    }

    await redis.del(`refresh:${refreshToken}`);
    const newRefresh = randomUUID();
    await redis.setex(`refresh:${newRefresh}`, 86400 * env.REFRESH_TOKEN_TTL_DAYS, JSON.stringify({ userId: user.id, orgId }));

    reply.setCookie("refresh_token", newRefresh, {
      httpOnly: true,
      secure: env.NODE_ENV === "production",
      sameSite: env.NODE_ENV === "production" ? "none" : "lax",
      path: "/",
      maxAge: 86400 * env.REFRESH_TOKEN_TTL_DAYS,
    });

    const jti = randomUUID();
    const accessToken = jwt.sign({ sub: user.id, org: orgId, role: user.role, jti }, env.JWT_SECRET, { expiresIn: env.JWT_EXPIRES_IN as any });

    return { success: true, data: { access_token: accessToken } };
  });

  fastify.post("/auth/logout", { preHandler: [authenticateJWT], schema: { tags: ["Auth"], description: "Terminate session and blacklist active JWT" } }, async (request, reply) => {
    const refreshToken = request.cookies.refresh_token;
    if (refreshToken) await redis.del(`refresh:${refreshToken}`);

    reply.clearCookie("refresh_token", { path: "/" });

    if (request.user) {
      await redis.setex(`blacklist:${request.user.jti}`, 900, "1");
      await writeAuditLog({ organizationId: request.user.org, userId: request.user.sub, action: "USER_LOGOUT", entity: "User", entityId: request.user.sub });
    }

    return { success: true, data: { loggedOut: true } };
  });
}
