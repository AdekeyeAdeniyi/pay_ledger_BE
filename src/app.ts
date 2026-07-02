import Fastify, { FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import cookie from "@fastify/cookie";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { ZodError } from "zod";
import { env } from "./config/env";
import { AppError } from "./utils/errors";
import { authRoutes } from "./routes/auth.routes";
import { orgRoutes } from "./routes/org.routes";
import { customerRoutes } from "./routes/customer.routes";
import { invoiceRoutes } from "./routes/invoice.routes";
import { webhookRoutes } from "./routes/webhook.routes";
import { reportRoutes } from "./routes/report.routes";
import { jsonSchemaTransform, serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { registerBullBoard } from "./bull-board";

export async function buildApp(): Promise<FastifyInstance> {
  const fastify = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      redact: ["password", "client_secret", "webhookSecretEncrypted", "passwordHash", "req.headers.authorization"],
      ...(env.NODE_ENV === "development"
        ? {
            transport: {
              target: "pino-pretty",
              options: { colorize: true, translateTime: "SYS:standard", ignore: "pid,hostname" },
            },
          }
        : {}),
    },
    disableRequestLogging: env.NODE_ENV === "production",
  });

  await registerBullBoard(fastify);

  fastify.setValidatorCompiler(validatorCompiler);
  fastify.setSerializerCompiler(serializerCompiler);

  // Preserve raw body for HMAC verification
  fastify.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    (req as any).rawBody = body;
    try {
      done(null, JSON.parse(body as string));
    } catch (e: unknown) {
      done(e as Error);
    }
  });

  // Register Security Plugins
  await fastify.register(cors, {
    origin: env.NODE_ENV === "production" ? ["https://payledger.io", "https://app.payledger.io"] : true,
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Authorization", "Content-Type"],
  });

  await fastify.register(helmet, {
    contentSecurityPolicy: false, // Disabled CSP so Swagger UI assets load cleanly
  });

  await fastify.register(rateLimit, {
    max: 100,
    timeWindow: "1 minute",
  });

  await fastify.register(cookie, {
    secret: env.JWT_SECRET,
  });

  // Register Swagger / OpenAPI
  await fastify.register(swagger, {
    // 1. Keep OpenAPI metadata here
    openapi: {
      openapi: "3.0.3",
      info: {
        title: "PayLedger Backend API v2.0",
        description: "Nigerian SMEs Invoice & Dedicated Virtual Account Reconciliation Engine API Documentation",
        version: "2.0.0",
      },
      servers: [
        {
          url: env.BASE_URL,
          description: env.NODE_ENV === "production" ? "Production Server" : "Development Server",
        },
      ],

      components: {
        securitySchemes: {
          bearerAuth: {
            type: "http",
            scheme: "bearer",
            bearerFormat: "JWT",
            description: "Enter JWT token as: Bearer <your_token>",
          },
          NombaSignatureAuth: {
            type: "apiKey",
            in: "header",
            name: "nomba-signature",
            description: "Enter your Nomba webhook or request verification signature",
          },
          NombaSigValueAuth: {
            type: "apiKey",
            in: "header",
            name: "nomba-sig-value",
            description: "Enter the Nomba signature value",
          },
          NombaSignatureAlgorithm: {
            type: "apiKey",
            in: "header",
            name: "nomba-signature-algorithm",
            description: "The algorithm used, e.g., HmacSHA256",
          },
          NombaSignatureVersion: {
            type: "apiKey",
            in: "header",
            name: "nomba-signature-version",
            description: "The version of the signature, e.g., 1.0.0",
          },
          NombaTimestamp: {
            type: "apiKey",
            in: "header",
            name: "nomba-timestamp",
            description: "The timestamp of the request",
          },
        },
      },
      security: [
        { bearerAuth: [] },
        {
          NombaSignatureAuth: [],
          NombaSigValueAuth: [],
          NombaSignatureAlgorithm: [],
          NombaSignatureVersion: [],
          NombaTimestamp: [],
        },
      ],
    },

    // 2. MOVE THIS HERE (Root level of the options object)
    // This tells Fastify Swagger to use the fastify-type-provider-zod transformer
    transform: jsonSchemaTransform,
  });

  // Register Swagger UI (Keep this exactly as you have it)
  await fastify.register(swaggerUi, {
    routePrefix: "/docs",
    uiConfig: {
      docExpansion: "list",
      deepLinking: true,
    },
    staticCSP: true,
    transformStaticCSP: (header) => header,
  });

  // Health Check
  fastify.get("/health", { schema: { tags: ["System"], description: "Service health check status" } }, async () => ({
    status: "ok",
    timestamp: new Date().toISOString(),
    version: "2.0.0",
  }));

  // Register Route Modules
  await fastify.register(authRoutes);
  await fastify.register(orgRoutes);
  await fastify.register(customerRoutes);
  await fastify.register(invoiceRoutes);
  await fastify.register(webhookRoutes);
  await fastify.register(reportRoutes);

  // Global Error Handler
  fastify.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      reply.status(error.statusCode).send({
        success: false,
        error: {
          code: error.code,
          message: error.message,
          ...(error.details ? { details: error.details } : {}),
        },
      });
      return;
    }

    if (error instanceof ZodError) {
      reply.status(422).send({
        success: false,
        error: {
          code: "VALIDATION_ERROR",
          message: "Input validation failed",
          details: error.issues.map((issue) => ({
            path: issue.path,
            message: issue.message,
          })),
        },
      });
      return;
    }

    request.log.error({ err: error }, "Unhandled Internal Server Error");
    reply.status(500).send({
      success: false,
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "An unexpected internal error occurred",
      },
    });
  });

  return fastify as any;
}
