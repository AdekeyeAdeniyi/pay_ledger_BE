import { z } from "zod";

export const RegisterOrgSchema = z.object({
  businessName: z.string().min(2).max(100).trim(),
  email: z.email().toLowerCase(),
  password: z.string().min(8).regex(/[A-Z]/, "Must contain uppercase").regex(/[a-z]/, "Must contain lowercase").regex(/\d/, "Must contain number"),
  phone: z.string().min(10),
});

export const LoginSchema = z.object({
  email: z.email().toLowerCase(),
  password: z.string().min(1),
});

export const ResetPasswordSchema = z.object({
  resetToken: z.uuid(),
  newPassword: z.string().min(8).regex(/[A-Z]/, "Must contain uppercase").regex(/[a-z]/, "Must contain lowercase").regex(/\d/, "Must contain number"),
});

export const ForgotPasswordSchema = z.object({
  email: z.email().toLowerCase(),
});

export const VerifyOtpSchema = z.object({
  email: z.email().toLowerCase(),
  otp: z.string().length(6),
});

export const UpdateProfileSchema = z.object({
  name: z.string().min(2).optional(),
  phone: z.string().optional(),
  logoUrl: z.url().optional(),
  whatsappNumber: z.string().optional(),
  notifyOnPayment: z.boolean().optional(),
  notifyDailySummary: z.boolean().optional(),
  notifyWeeklySummary: z.boolean().optional(),
});

export const InviteMemberSchema = z.object({
  name: z.string().min(2),
  email: z.email().toLowerCase(),
  role: z.enum(["OWNER", "FINANCE_MANAGER", "VIEWER"]),
});
