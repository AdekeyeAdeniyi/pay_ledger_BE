import { Queue, JobsOptions } from "bullmq";
import { redis } from "../services/redis.service";

export const defaultJobOptions: JobsOptions = {
  attempts: 3,
  backoff: { type: "exponential", delay: 2000 },
  removeOnComplete: { age: 60 * 60 * 24 * 7 }, // keep 7 days
  removeOnFail: false,
};

export const queues = {
  reconciliation: new Queue("reconciliation", { connection: redis as any, defaultJobOptions }),
  notifications: new Queue("notifications", { connection: redis as any, defaultJobOptions }),
  reports: new Queue("reports", { connection: redis as any, defaultJobOptions }),
  nombaApi: new Queue("nomba-api", { connection: redis as any, defaultJobOptions }),
};
