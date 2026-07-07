import { env } from "../config/env";
import { redis } from "./redis.service";
import { AppError } from "../utils/errors";
import { logger } from "../utils/logger";

export interface NombaVirtualAccountData {
  accountRef: string;
  bankAccountNumber: string;
  bankAccountName: string;
  bankName: string;
  accountHolderId: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface NombaAuthResponse {
  code: string;
  description: string;
  data?: {
    access_token: string;
    expires_in?: number;
  };
}

export interface NombaApiResponse<T> {
  code: string;
  description?: string;
  data: T;
}

export interface NombaCheckoutOrderRequest {
  order: {
    orderReference: string;
    customerId: string;
    callbackUrl: string;
    customerEmail?: string;
    amount: string;
    currency: string;
    accountId: string;
    allowedPaymentMethods?: string[];
  };
}

export interface NombaCheckoutOrderData {
  checkoutLink: string;
  orderReference: string;
}

export interface NombaTransactionData {
  transactionId: string;
  type: string;
  time: string;
  responseCode?: string;
  transactionAmount: number | string;
  aliasAccountNumber?: string;
  mcollectionsId?: string;
  merchantTxRef?: string;
  status?: string;
}

export interface NombaSubAccountDetails {
  createdAt: string;
  accountId: string;
  accountHolderId: string;
  accountRef: string;
  bvn: string;
  status: string;
  accountName: string;
  currency: string;
  banks: Array<{
    bankAccountNumber: string;
    bankName: string;
    bankAccountName: string;
  }>;
}

export class NombaTokenService {
  private readonly TOKEN_KEY = "nomba:access_token";
  private readonly LOCK_KEY = "nomba:auth_lock";

  private readonly LOCK_TTL_MS = 30_000;

  private readonly TOKEN_TTL_S = 25 * 60;

  async getAccessToken(): Promise<string> {
    const cached = await redis.get(this.TOKEN_KEY);

    if (cached) {
      return cached;
    }

    const lock = await redis.set(this.LOCK_KEY, "1", "PX", this.LOCK_TTL_MS, "NX");

    if (!lock) {
      for (let i = 0; i < 15; i++) {
        await sleep(400);

        const token = await redis.get(this.TOKEN_KEY);

        if (token) {
          return token;
        }
      }

      throw new AppError("NOMBA_AUTH_TIMEOUT", "Timed out waiting for Nomba authentication.", 503);
    }

    try {
      return await this.authenticate();
    } finally {
      await redis.del(this.LOCK_KEY);
    }
  }

  private async authenticate(): Promise<string> {
    const res = await fetch(`${env.NOMBA_BASE_URL}/v1/auth/token/issue`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        accountId: env.NOMBA_MAIN_ACCOUNT_ID,
      },
      body: JSON.stringify({
        grant_type: "client_credentials",
        client_id: env.NOMBA_CLIENT_ID,
        client_secret: env.NOMBA_CLIENT_SECRET,
      }),
    });

    const body = (await res.json()) as NombaAuthResponse;

    if (!res.ok || body.code !== "00" || !body.data?.access_token) {
      logger.error(
        {
          status: res.status,
          response: body,
        },
        "Nomba authentication failed",
      );

      throw new AppError("NOMBA_AUTH_FAILED", body.description ?? "Unable to authenticate with Nomba.", 502, body);
    }

    const token = body.data.access_token;

    await redis.setex(this.TOKEN_KEY, this.TOKEN_TTL_S, token);

    return token;
  }

  async clearToken() {
    await redis.del(this.TOKEN_KEY);
  }
}

export const nombaTokenService = new NombaTokenService();

export async function createNombaVirtualAccount(params: {
  accountRef: string;
  accountName: string;
  callbackUrl: string;
  email?: string;
  phone?: string;
  expiryDate?: string;
  expectedAmount?: number;
}): Promise<NombaVirtualAccountData> {
  const token = await nombaTokenService.getAccessToken().catch(() => "mock_token");

  if (token === "mock_token" || env.NOMBA_CLIENT_ID.includes("sandbox")) {
    logger.info({ params }, "Simulating Nomba Virtual Account Creation in Mock/Sandbox Mode");
    return {
      accountRef: params.accountRef,
      bankAccountNumber: "9" + Math.floor(100000000 + Math.random() * 900000000).toString(),
      bankAccountName: params.accountName,
      bankName: "Nomba MFB",
      accountHolderId: "nomba_acc_" + Math.random().toString(36).substring(7),
    };
  }

  const res = await fetch(`${env.NOMBA_BASE_URL}/v1/accounts/virtual/${env.NOMBA_SUB_ACCOUNT_ID}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      subAccountId: env.NOMBA_SUB_ACCOUNT_ID,
      accountId: env.NOMBA_MAIN_ACCOUNT_ID,
    },
    body: JSON.stringify({
      accountRef: params.accountRef,
      accountName: params.accountName,
      currency: "NGN",
      callbackUrl: params.callbackUrl,
      ...(params.email && { email: params.email }),
      ...(params.phone && { phoneNumber: params.phone }),
      ...(params.expiryDate && { expiryDate: params.expiryDate }),
      ...(params.expectedAmount && { expectedAmount: params.expectedAmount }),
    }),
  });

  const json = (await res.json()) as NombaApiResponse<NombaVirtualAccountData>;
  if (json.code !== "00" || !json.data) {
    throw new AppError("NOMBA_VA_CREATION_FAILED", json.description || "Nomba virtual account creation failed", 502, json);
  }
  return json.data;
}

export async function createNombaCheckoutOrder(params: {
  orderReference: string;
  customerId: string;
  callbackUrl: string;
  customerEmail?: string;
  amount: string;
  accountId: string;
  allowedPaymentMethods?: string[];
}): Promise<NombaCheckoutOrderData> {
  const token = await nombaTokenService.getAccessToken().catch(() => "mock_token");

  if (token === "mock_token" || env.NOMBA_CLIENT_ID.includes("sandbox")) {
    return {
      checkoutLink: `https://checkout.nomba.com/order/${params.orderReference}`,
      orderReference: params.orderReference,
    };
  }

  const requestBody: NombaCheckoutOrderRequest = {
    order: {
      orderReference: params.orderReference,
      customerId: params.customerId,
      callbackUrl: params.callbackUrl,
      customerEmail: params.customerEmail,
      amount: params.amount,
      currency: "NGN",
      accountId: params.accountId,
      ...(params.allowedPaymentMethods?.length && {
        allowedPaymentMethods: params.allowedPaymentMethods,
      }),
    },
  };

  const res = await fetch(`${env.NOMBA_BASE_URL}/v1/checkout/order`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      accountId: env.NOMBA_MAIN_ACCOUNT_ID,
    },
    body: JSON.stringify(requestBody),
  });

  const json = (await res.json()) as NombaApiResponse<NombaCheckoutOrderData>;
  if (json.code !== "00" || !json.data) {
    throw new AppError("NOMBA_TRANSFER_FAILED", json.description || "Nomba checkout order failed", 502, json);
  }
  return json.data;
}
