import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.string().transform(Number),
  BASE_URL: z.url().default("http://localhost:3000"),
  FRONTEND_URL: z.url().default("http://localhost:5173"),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  JWT_SECRET: z.string().min(32),
  JWT_EXPIRES_IN: z.string().default("15m"),
  REFRESH_TOKEN_TTL_DAYS: z.string().transform(Number),
  WEBHOOK_SECRET_ENCRYPTION_KEY: z.string().length(64, "Must be 32-byte hex string (64 hex characters)"),
  NOMBA_WEBHOOK_SECRET: z.string().min(1),
  NOMBA_CLIENT_ID: z.string().min(1),
  NOMBA_CLIENT_SECRET: z.string().min(1),
  NOMBA_MAIN_ACCOUNT_ID: z.string().min(1),
  NOMBA_SUB_ACCOUNT_ID: z.string().min(1),
  NOMBA_BASE_URL: z.string().url().default("https://sandbox.nomba.com"),
  LOG_LEVEL: z.string().default("info"),
});

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("❌ Invalid environment variables:", JSON.stringify(parsed.error.format(), null, 2));
  process.exit(1);
}

export const env = parsed.data;
