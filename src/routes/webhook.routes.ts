import { FastifyInstance } from "fastify";
import { prisma } from "../services/prisma.service";
import { NombaWebhookPayload, verifyNombaSignature } from "../utils/nombaWebhook";
import { queues } from "../queues";
import { Prisma } from "../generated/client";
import { env } from "../config/env";
import { logger } from "../utils/logger";

export async function webhookRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post<{ Params: { orgId: string } }>(
    "/webhooks/nomba/:orgId",
    {
      schema: {
        tags: ["Webhook"],
        description: "Receive Nomba webhook events",
        consumes: ["application/json"],
      },
    },
    async (request, reply) => {
      const { orgId } = request.params;

      const signature = request.headers["nomba-signature"] as string;
      const algorithm = request.headers["nomba-signature-algorithm"] as string;
      const timestamp = request.headers["nomba-timestamp"] as string;

      if (!signature || !algorithm || !timestamp) {
        return reply.code(400).send({
          success: false,
          message: "Missing webhook headers",
        });
      }

      if (algorithm !== "HmacSHA256") {
        return reply.code(400).send({
          success: false,
          message: "Unsupported signature algorithm",
        });
      }
      const organization = await prisma.organization.findUnique({
        where: {
          id: orgId,
        },
      });

      if (!organization) {
        return reply.code(404).send({
          success: false,
          message: "Organization not found",
        });
      }

      const rawBody = (request as any).rawBody;

      const valid = verifyNombaSignature(rawBody, signature, env.NOMBA_WEBHOOK_SECRET);

      if (!valid) {
        return reply.code(401).send({
          success: false,
          message: "Invalid webhook signature",
        });
      }

      const now = Date.now();
      const received = new Date(timestamp).getTime();

      if (Math.abs(now - received) > 5 * 60 * 1000) {
        return reply.code(401).send({
          success: false,
          message: "Webhook timestamp expired",
        });
      }

      const payload = request.body as NombaWebhookPayload;

      const transactionId = payload.data.transaction.transactionId;

      const event = await prisma.webhookEvent.findUnique({
        where: {
          nombaTransactionId: transactionId,
        },
      });

      if (event?.status === "PROCESSED") {
        logger.info("Already processed");
        return;
      }

      await prisma.webhookEvent.upsert({
        where: {
          nombaTransactionId: transactionId,
        },
        update: {
          retryCount: {
            increment: 1,
          },
        },
        create: {
          organizationId: orgId,
          eventType: payload.event_type,
          nombaTransactionId: transactionId,
          payload: payload as unknown as Prisma.InputJsonValue,
          status: "RECEIVED",
        },
      });

      try {
        await queues.reconciliation.add(
          "reconciliation",
          {
            orgId,
            payload,
          },
          {
            jobId: transactionId,
            attempts: 5,
            backoff: {
              type: "exponential",
              delay: 5000,
            },
            removeOnComplete: 1000,
            removeOnFail: 1000,

            deduplication: {
              id: transactionId,
            },
          },
        );
      } catch (error) {
        logger.error(
          {
            transactionId,
            error,
          },
          "Failed to enqueue reconciliation job",
        );

        throw error;
      }

      return reply.send({
        success: true,
      });
    },
  );
}
