import { FastifyInstance } from "fastify";
import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { FastifyAdapter } from "@bull-board/fastify";

import { queues } from "./queues";

export async function registerBullBoard(fastify: FastifyInstance) {
  const serverAdapter = new FastifyAdapter();

  serverAdapter.setBasePath("/admin/queues");

  createBullBoard({
    queues: [new BullMQAdapter(queues.reconciliation), new BullMQAdapter(queues.notifications), new BullMQAdapter(queues.reports), new BullMQAdapter(queues.nombaApi)],
    serverAdapter,
  });

  await fastify.register(serverAdapter.registerPlugin(), {
    prefix: "/admin/queues",
  });
}
