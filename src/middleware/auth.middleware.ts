import { FastifyRequest, FastifyReply } from "fastify";
import jwt from "jsonwebtoken";
import { env } from "../config/env";
import { redis } from "../services/redis.service";
import { AppError } from "../utils/errors";
import { UserRole } from "../generated/enums";

export interface JWTPayload {
  sub: string; // userId
  org: string; // organizationId
  role: UserRole;
  jti: string;
  iat: number;
  exp: number;
}

declare module "fastify" {
  interface FastifyRequest {
    user?: JWTPayload;
  }
}

export async function authenticateJWT(request: FastifyRequest, reply: FastifyReply) {
  const authHeader = request.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    throw new AppError("INVALID_CREDENTIALS", "Missing or invalid Authorization header", 401);
  }

  const token = authHeader.split(" ")[1];

  try {
    const decoded = jwt.verify(token, env.JWT_SECRET) as JWTPayload;

    // Check JTI blacklist
    const isBlacklisted = await redis.get(`blacklist:${decoded.jti}`);
    if (isBlacklisted) {
      throw new AppError("TOKEN_BLACKLISTED", "Token has been invalidated", 401);
    }

    request.user = decoded;
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError("TOKEN_EXPIRED", "Invalid or expired token", 401);
  }
}

export function requireRole(allowedRoles: UserRole[]) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    await authenticateJWT(request, reply);
    if (!request.user || !allowedRoles.includes(request.user.role)) {
      throw new AppError("INSUFFICIENT_PERMISSIONS", "You do not have permission to access this resource", 403);
    }
  };
}
