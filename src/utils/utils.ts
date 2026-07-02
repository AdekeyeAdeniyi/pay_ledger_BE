import { Decimal } from "@prisma/client/runtime/client";

function money(amount: string | number | undefined | null | Decimal, currency: string): string {
  const n = Number(amount || 0);
  const symbol = currency === "NGN" ? "\u20A6" : `${currency} `;
  return `${symbol}${n.toLocaleString("en-NG", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatDate(iso: Date | null | undefined): string {
  if (!iso) return "\u2014";
  const d = new Date(iso);
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

export { money, formatDate };
