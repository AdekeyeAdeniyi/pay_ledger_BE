import crypto, { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { env } from "../config/env";

export interface NombaWebhookPayload {
  event_type: "payment_success" | "payment_failed";
  requestId: string;
  data: {
    merchant: NombaMerchant;
    terminal?: NombaTerminal;
    transaction: NombaTransaction;
    customer: NombaCustomer;
    order?: NombaOrder;
    tokenizedCardData?: NombaTokenizedCardData;
  };
}

export interface NombaMerchant {
  walletId?: string;
  walletBalance?: number;
  userId: string;
}

export interface NombaTerminal {
  terminalLabel?: string;
  terminalId?: string;
}

export interface NombaTransaction {
  aliasAccountNumber?: string;
  aliasAccountName?: string;
  aliasAccountReference?: string;
  aliasAccountType?: "VIRTUAL";
  fee: number;
  sessionId?: string;
  type: "vact_transfer" | "online_checkout" | "purchase" | "withdrawal" | (string & {});
  transactionId: string;
  responseCode?: string;
  responseCodeMessage?: string;
  originatingFrom: "api" | "pos" | "web" | string;
  merchantTxRef?: string;
  transactionAmount: number;
  narration?: string;
  time: string;
  rrn?: string;
  terminalSerialNumber?: string;
  cardIssuer?: string;
  cardBank?: string;
}

export interface NombaCustomer {
  senderName?: string;
  bankCode?: string;
  bankName?: string;
  accountNumber?: string;
  productId?: string;
  billerId?: string;
  cardPan?: string;
}

export interface NombaOrder {
  amount: number;
  orderId: string;
  orderReference: string;
  cardType?: string;
  cardLast4Digits?: string;
  cardCurrency?: string;
  accountId?: string;
  customerEmail?: string;
  customerId?: string;
  isTokenizedCardPayment?: string;
  paymentMethod?: string;
  callbackUrl?: string;
  currency?: string;
}

export interface NombaTokenizedCardData {
  tokenKey?: string;
  cardType?: string;
  tokenExpiryYear?: string;
  tokenExpiryMonth?: string;
  cardPan?: string;
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", env.WEBHOOK_SECRET_ENCRYPTION_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
}

export function decryptSecret(stored: string): string {
  const [ivHex, tagHex, ctHex] = stored.split(":");
  const iv = Buffer.from(ivHex, "hex");
  const tag = Buffer.from(tagHex, "hex");
  const ciphertext = Buffer.from(ctHex, "hex");
  const decipher = createDecipheriv("aes-256-gcm", env.WEBHOOK_SECRET_ENCRYPTION_KEY, iv);
  decipher.setAuthTag(tag);
  return decipher.update(ciphertext).toString("utf8") + decipher.final("utf8");
}

export function verifyNombaSignature(rawBody: string, signature: string, secret: string) {
  const digest = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");

  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(digest));
}
