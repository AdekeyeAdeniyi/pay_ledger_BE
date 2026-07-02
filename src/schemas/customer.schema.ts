import { z } from 'zod';

export const CreateCustomerSchema = z.object({
  name: z.string().min(2).max(100).trim(),
  email: z.string().email().toLowerCase().optional().or(z.literal('')),
  phone: z.string().optional(),
  customerType: z.enum(['RECURRING', 'ONE_TIME']).default('RECURRING'),
  notes: z.string().optional(),
});

export const UpdateCustomerSchema = z.object({
  name: z.string().min(2).max(100).trim().optional(),
  email: z.string().email().toLowerCase().optional(),
  phone: z.string().optional(),
  notes: z.string().optional(),
});

export const ApplyCreditSchema = z.object({
  invoiceId: z.string().uuid(),
});
