export class AppError extends Error {
  constructor(
    public code: string,
    public message: string,
    public statusCode: number = 400,
    public details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const ERRORS = {
  // Auth (401/403)
  INVALID_CREDENTIALS: { status: 401, code: "INVALID_CREDENTIALS", message: "Invalid email or password" },
  TOKEN_EXPIRED: { status: 401, code: "TOKEN_EXPIRED", message: "Session expired, please login again" },
  TOKEN_BLACKLISTED: { status: 401, code: "TOKEN_BLACKLISTED", message: "Token has been invalidated" },
  INSUFFICIENT_PERMISSIONS: { status: 403, code: "INSUFFICIENT_PERMISSIONS", message: "You do not have permission to perform this action" },

  // Not Found (404)
  INVOICE_NOT_FOUND: { status: 404, code: "INVOICE_NOT_FOUND", message: "Invoice not found" },
  CUSTOMER_NOT_FOUND: { status: 404, code: "CUSTOMER_NOT_FOUND", message: "Customer not found" },
  SUB_ACCOUNT_NOT_FOUND: { status: 404, code: "SUB_ACCOUNT_NOT_FOUND", message: "Sub-account not found in registry" },

  // Conflict (409)
  EMAIL_TAKEN: { status: 409, code: "EMAIL_TAKEN", message: "Email is already registered" },
  CUSTOMER_SUSPENDED: { status: 409, code: "CUSTOMER_SUSPENDED", message: "Customer account is suspended" },
  INVOICE_ALREADY_PAID: { status: 409, code: "INVOICE_ALREADY_PAID", message: "Invoice is already fully paid" },
  INVOICE_CANCELLED: { status: 409, code: "INVOICE_CANCELLED", message: "Invoice is cancelled" },
  INVOICE_NOT_EDITABLE: { status: 409, code: "INVOICE_NOT_EDITABLE", message: "Invoice cannot be edited in its current state" },

  // Validation (422)
  VALIDATION_ERROR: { status: 422, code: "VALIDATION_ERROR", message: "Validation failed" },
  DESTINATION_UNREGISTERED: { status: 422, code: "DESTINATION_UNREGISTERED", message: "Destination account is not registered" },
  INSUFFICIENT_CREDIT: { status: 422, code: "INSUFFICIENT_CREDIT", message: "Insufficient credit balance" },

  // Nomba upstream (502/503)
  NOMBA_AUTH_FAILED: { status: 502, code: "NOMBA_AUTH_FAILED", message: "Upstream Nomba authentication failed" },
  NOMBA_VA_CREATION_FAILED: { status: 502, code: "NOMBA_VA_CREATION_FAILED", message: "Virtual account creation failed upstream" },
  NOMBA_TRANSFER_FAILED: { status: 502, code: "NOMBA_TRANSFER_FAILED", message: "Upstream wallet transfer failed" },
  NOMBA_AUTH_TIMEOUT: { status: 503, code: "NOMBA_AUTH_TIMEOUT", message: "Token acquisition timed out" },
} as const;

export function throwError(errorDef: { status: number; code: string; message: string }, customMessage?: string, details?: unknown): never {
  throw new AppError(errorDef.code, customMessage || errorDef.message, errorDef.status, details);
}
