import { z } from "zod";

export const LineItemInputSchema = z.object({
  description: z.string().trim().min(1, "Description is required"),
  quantity: z.number().positive("Quantity must be greater than zero"),
  unitPrice: z.number().nonnegative("Unit price cannot be negative"),
});

export const CreateInvoiceSchema = z.object({
  customerId: z.uuid(),
  dueDate: z.iso.datetime().or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
  notes: z.string().optional(),
  lineItems: z.array(LineItemInputSchema).min(1, "At least one line item is required"),
});

export const GeneratePaymentOptionsSchema = z.object({
  allowedPaymentMethods: z.array(z.enum(["Card", "Transfer", "Nomba QR", "USSD", "Buy Now Pay Later", "MOMO", "Intl Card", "Apple Pay"])).min(1),
});

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}
