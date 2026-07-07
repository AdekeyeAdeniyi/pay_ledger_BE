import { FastifyInstance, FastifyRequest } from "fastify";
import QRCode from "qrcode";
import PDFDocument from "pdfkit";
import { prisma } from "../services/prisma.service";
import { authenticateJWT, requireRole } from "../middleware/auth.middleware";
import { writeAuditLog } from "../services/audit.service";
import { CreateInvoiceSchema, GeneratePaymentOptionsSchema } from "../schemas/invoice.schema";
import { AppError } from "../utils/errors";
import { env } from "../config/env";
import { InvoiceStatus, Prisma } from "../generated/client";
import { createNombaCheckoutOrder } from "../services/nomba.service";
import { addHours } from "date-fns";
import { FastifyReply } from "fastify/types/reply";
import { InvoiceWithRelations, VirtualBankDetails } from "../types/invoice";
import { formatDate, money } from "../utils/utils";

interface ReceiptParams {
  id: string;
}

const BRAND = {
  dark: "#0B1220",
  primary: "#22C55E",
  text: "#111827",
  muted: "#6B7280",
  border: "#E5E7EB",
  bgSoft: "#F9FAFB",
  white: "#FFFFFF",
} as const;

const STATUS_COLORS: Record<string, string> = {
  PENDING: "#B45309",
  PAID: "#15803D",
  OVERDUE: "#B91C1C",
  CANCELLED: "#6B7280",
  EXPIRED: "#6B7280",
};

export async function generateReceiptPdf(invoice: InvoiceWithRelations, virtualBank: VirtualBankDetails | null): Promise<Buffer> {
  const { invoiceNumber, status, totalAmount, amountPaid, balanceDue, currency, dueDate, notes, checkoutLink, orderReference, createdAt, lineItems, customer, ledgerEntries } = invoice;

  // Bank transfer takes priority: if a virtual bank account was provided,
  // show those details instead of the Nomba checkout link / QR code.
  const hasVirtualBank = Boolean(virtualBank?.accountName && virtualBank?.accountNumber && virtualBank?.bankName);
  const showCheckout = !hasVirtualBank && Boolean(checkoutLink);

  // Pre-render QR code for the checkout link, only when we're actually
  // going to show the checkout section (i.e. no virtual bank override).
  let qrBuffer: Buffer | null = null;
  if (showCheckout && checkoutLink) {
    qrBuffer = await QRCode.toBuffer(checkoutLink, {
      type: "png",
      margin: 1,
      width: 220,
      color: { dark: BRAND.dark, light: "#FFFFFF" },
    });
  }

  const doc = new PDFDocument({ size: "A4", margin: 0, bufferPages: true });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  const pageW = doc.page.width;
  const marginX = 48;
  const contentW = pageW - marginX * 2;

  // ---------------- Header ----------------
  doc.rect(0, 0, pageW, 120).fill(BRAND.dark);

  doc.font("Helvetica-Bold").fontSize(22).fillColor(BRAND.white).text("Pay", marginX, 40, { continued: true }).fillColor(BRAND.primary).text("Ledger");

  doc.font("Helvetica").fontSize(9).fillColor("#9CA3AF").text("Payment Receipt", marginX, 68);

  // Right-aligned invoice meta in header
  const statusColor = STATUS_COLORS[status] || BRAND.primary;
  doc
    .font("Helvetica-Bold")
    .fontSize(16)
    .fillColor(BRAND.white)
    .text(invoiceNumber || "", marginX, 38, { width: contentW, align: "right" });

  doc
    .font("Helvetica")
    .fontSize(9)
    .fillColor("#9CA3AF")
    .text(`Issued ${formatDate(createdAt)}`, marginX, 60, { width: contentW, align: "right" });

  // status pill
  const pillText = String(status || "")
    .replace(/_/g, " ")
    .toUpperCase();
  doc.font("Helvetica-Bold").fontSize(9);
  const pillW = doc.widthOfString(pillText) + 20;
  const pillX = pageW - marginX - pillW;
  const pillY = 80;
  doc.roundedRect(pillX, pillY, pillW, 18, 9).fill(statusColor);
  doc.fillColor(BRAND.white).text(pillText, pillX, pillY + 5, { width: pillW, align: "center" });

  let y = 150;

  // ---------------- Bill To / Invoice Info ----------------
  const colW = (contentW - 24) / 2;

  doc.font("Helvetica-Bold").fontSize(10).fillColor(BRAND.muted).text("BILLED TO", marginX, y);
  doc
    .font("Helvetica-Bold")
    .fontSize(10)
    .fillColor(BRAND.muted)
    .text("INVOICE DETAILS", marginX + colW + 24, y);
  y += 16;

  doc
    .font("Helvetica-Bold")
    .fontSize(12)
    .fillColor(BRAND.text)
    .text(customer?.name || "\u2014", marginX, y, { width: colW });
  doc.font("Helvetica").fontSize(9).fillColor(BRAND.muted);
  let leftY = y + 16;
  if (customer?.email) {
    doc.text(customer.email, marginX, leftY, { width: colW });
    leftY += 13;
  }
  if (customer?.phone) {
    doc.text(customer.phone, marginX, leftY, { width: colW });
    leftY += 13;
  }
  if (customer?.customerCode) {
    doc.text(`Customer ID: ${customer.customerCode}`, marginX, leftY, { width: colW });
    leftY += 13;
  }

  const infoX = marginX + colW + 24;
  let infoY = y;
  const infoRow = (label: string, value: string) => {
    doc
      .font("Helvetica")
      .fontSize(9)
      .fillColor(BRAND.muted)
      .text(label, infoX, infoY, { width: colW - 90 });
    doc
      .font("Helvetica-Bold")
      .fontSize(9)
      .fillColor(BRAND.text)
      .text(value, infoX + (colW - 90), infoY, { width: 90, align: "right" });
    infoY += 16;
  };
  infoRow("Due date", formatDate(dueDate));
  infoRow("Currency", currency || "\u2014");
  if (!hasVirtualBank && orderReference) infoRow("Order ref.", orderReference.slice(0, 18));

  y = Math.max(leftY, infoY) + 20;

  // ---------------- Line items table ----------------
  const tableTop = y;
  const cols = {
    desc: marginX,
    qty: marginX + contentW - 220,
    price: marginX + contentW - 150,
    amount: marginX + contentW - 80,
  };
  const colWidths = { desc: contentW - 220, qty: 60, price: 70, amount: 80 };

  doc.rect(marginX, tableTop, contentW, 22).fill(BRAND.bgSoft);
  doc.font("Helvetica-Bold").fontSize(9).fillColor(BRAND.muted);
  doc.text("DESCRIPTION", cols.desc + 8, tableTop + 7, { width: colWidths.desc - 8 });
  doc.text("QTY", cols.qty, tableTop + 7, { width: colWidths.qty, align: "right" });
  doc.text("UNIT PRICE", cols.price, tableTop + 7, { width: colWidths.price, align: "right" });
  doc.text("AMOUNT", cols.amount, tableTop + 7, { width: colWidths.amount, align: "right" });

  y = tableTop + 22;
  doc.font("Helvetica").fontSize(10).fillColor(BRAND.text);
  lineItems.forEach((item: InvoiceWithRelations["lineItems"][number], i: number) => {
    const rowH = 24;
    if (i % 2 === 1) doc.rect(marginX, y, contentW, rowH).fill("#FCFCFD");
    doc.fillColor(BRAND.text);
    doc.text(item.description || "", cols.desc + 8, y + 6, { width: colWidths.desc - 8 });
    doc.text(Number(item.quantity).toString(), cols.qty, y + 6, { width: colWidths.qty, align: "right" });
    doc.text(money(item.unitPrice, currency), cols.price, y + 6, { width: colWidths.price, align: "right" });
    doc.text(money(item.amount, currency), cols.amount, y + 6, { width: colWidths.amount, align: "right" });
    y += rowH;
  });

  doc
    .moveTo(marginX, y)
    .lineTo(marginX + contentW, y)
    .strokeColor(BRAND.border)
    .stroke();
  y += 14;

  // ---------------- Totals ----------------
  const totalsX = marginX + contentW - 220;
  const totalsW = 220;
  const totalRow = (label: string, value: string, opts: { bold?: boolean; color?: string } = {}) => {
    doc.font(opts.bold ? "Helvetica-Bold" : "Helvetica").fontSize(opts.bold ? 11 : 9.5);
    doc.fillColor(opts.bold ? BRAND.text : BRAND.muted);
    doc.text(label, totalsX, y, { width: totalsW - 100 });
    doc.fillColor(opts.color || BRAND.text);
    doc.text(value, totalsX + totalsW - 100, y, { width: 100, align: "right" });
    y += opts.bold ? 20 : 16;
  };
  totalRow("Total amount", money(totalAmount, currency));
  totalRow("Amount paid", money(amountPaid, currency));
  doc
    .moveTo(totalsX, y)
    .lineTo(totalsX + totalsW, y)
    .strokeColor(BRAND.border)
    .stroke();
  y += 8;
  if (balanceDue.lt(0)) {
    totalRow("Overpaid amount", money(balanceDue.negated(), currency), { bold: true, color: STATUS_COLORS.OVERDUE });
    y += 4;
    doc
      .font("Helvetica-Oblique")
      .fillColor(BRAND.primary)
      .text("This invoice has been overpaid. Please contact the customer to arrange a refund or credit.", totalsX, y, { width: totalsW, align: "right" });
  } else {
    totalRow("Balance due", money(balanceDue, currency), { bold: true, color: balanceDue.eq(0) ? STATUS_COLORS.PAID : STATUS_COLORS.PENDING });
  }

  y += 20;

  // ---------------- Payment section: virtual bank OR checkout/QR ----------------
  if (invoice.status === "PENDING" || invoice.status === "PARTIALLY_PAID")
    if (hasVirtualBank && virtualBank) {
      const boxH = 110;
      doc.roundedRect(marginX, y, contentW, boxH, 8).fillAndStroke(BRAND.bgSoft, BRAND.border);

      const padX = 20;
      const innerX = marginX + padX;
      const innerW = contentW - padX * 2;
      let by = y + 18;

      doc.font("Helvetica-Bold").fontSize(12).fillColor(BRAND.text).text("Pay via bank transfer", innerX, by, { width: innerW });
      by += 22;

      const rowColW = innerW / 3;
      const bankRow = (label: string, value: string, colIndex: number) => {
        const x = innerX + rowColW * colIndex;
        doc
          .font("Helvetica")
          .fontSize(8)
          .fillColor(BRAND.muted)
          .text(label, x, by, { width: rowColW - 10 });
        doc
          .font("Helvetica-Bold")
          .fontSize(11)
          .fillColor(BRAND.text)
          .text(value, x, by + 12, { width: rowColW - 10 });
      };

      bankRow("BANK NAME", virtualBank.bankName, 0);
      bankRow("ACCOUNT NUMBER", virtualBank.accountNumber, 1);
      bankRow("ACCOUNT NAME", virtualBank.accountName, 2);

      by += 32;
      doc.font("Helvetica").fontSize(8).fillColor(BRAND.muted).text("Transfer the exact balance due to this account to settle this invoice.", innerX, by, {
        width: innerW,
      });

      y += boxH + 20;
    } else if (showCheckout && checkoutLink && qrBuffer) {
      const boxH = 130;
      doc.roundedRect(marginX, y, contentW, boxH, 8).fillAndStroke(BRAND.bgSoft, BRAND.border);

      const qrSize = 96;
      const qrX = marginX + 20;
      const qrY = y + (boxH - qrSize) / 2;
      doc.image(qrBuffer, qrX, qrY, { width: qrSize, height: qrSize });
      // Make the QR image itself clickable
      doc.link(qrX, qrY, qrSize, qrSize, checkoutLink);

      const textX = qrX + qrSize + 24;
      const textW = contentW - (qrX + qrSize + 24 - marginX) - 20;

      doc
        .font("Helvetica-Bold")
        .fontSize(12)
        .fillColor(BRAND.text)
        .text("Complete this payment", textX, y + 22, { width: textW });
      doc
        .font("Helvetica")
        .fontSize(9)
        .fillColor(BRAND.muted)
        .text("Scan the QR code with your phone, or tap the link below to pay securely via Nomba.", textX, y + 42, { width: textW });

      const linkY = y + 80;
      doc.font("Helvetica-Bold").fontSize(9.5).fillColor(BRAND.primary).text(checkoutLink, textX, linkY, { width: textW, underline: true });
      doc.link(textX, linkY, doc.widthOfString(checkoutLink), 12, checkoutLink);

      y += boxH + 20;
    }

  // ---------------- Notes ----------------
  if (notes) {
    doc.font("Helvetica-Bold").fontSize(9).fillColor(BRAND.muted).text("NOTES", marginX, y);
    y += 14;
    doc.font("Helvetica").fontSize(9.5).fillColor(BRAND.text).text(notes, marginX, y, { width: contentW });
    y += 30;
  }

  // ---------------- Ledger reference (subtle audit trail) ----------------
  if (ledgerEntries.length) {
    const entry = ledgerEntries[0];
    doc
      .font("Helvetica")
      .fontSize(8)
      .fillColor(BRAND.muted)
      .text(`Ledger ref: ${entry.reference || entry.id} \u2022 ${formatDate(entry.postedAt)}`, marginX, y);
    y += 14;
  }

  // ---------------- Footer ----------------
  const footerY = doc.page.height - 60;
  doc
    .moveTo(marginX, footerY)
    .lineTo(marginX + contentW, footerY)
    .strokeColor(BRAND.border)
    .stroke();
  doc
    .font("Helvetica")
    .fontSize(8)
    .fillColor(BRAND.muted)
    .text("Generated by PayLedger \u2022 This is a system-generated receipt.", marginX, footerY + 10, {
      width: contentW,
      align: "center",
    });

  doc.end();
  return done;
}

export async function invoiceRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.addHook("preHandler", authenticateJWT);

  fastify.post(
    "/invoices",
    {
      preHandler: [requireRole(["OWNER", "FINANCE_MANAGER"])],
      schema: { tags: ["Invoices"], description: "Create invoice with line items,", body: CreateInvoiceSchema },
    },
    async (request) => {
      const body = CreateInvoiceSchema.parse(request.body);
      const orgId = request.user!.org;

      const customer = await prisma.customer.findFirst({
        where: {
          id: body.customerId,
          organizationId: orgId,
        },
        include: {
          virtualAccount: true,
        },
      });

      if (!customer) {
        throw new AppError("CUSTOMER_NOT_FOUND", "Customer not found in organization", 404);
      }

      const totalAmount = body.lineItems.reduce((sum, item) => sum.add(new Prisma.Decimal(item.quantity).mul(new Prisma.Decimal(item.unitPrice))), new Prisma.Decimal(0));

      const dueDate = new Date(body.dueDate);

      const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");

      const random = crypto.randomUUID().split("-")[0].toUpperCase();

      const invoiceNumber = `INV-${date}-${random}`;
      const invoiceId = crypto.randomUUID();

      const invoiceData: Prisma.InvoiceUncheckedCreateInput = {
        id: invoiceId,
        invoiceNumber,
        organizationId: orgId,
        customerId: customer.id,

        status: "PENDING",

        totalAmount,
        amountPaid: new Prisma.Decimal(0),
        balanceDue: totalAmount,

        dueDate,
        notes: body.notes,

        paymentPath: customer.virtualAccount ? "BANK_TRANSFER" : "CHECKOUT",

        accountRef: customer.virtualAccount?.accountRef ?? null,
        accountId: customer.virtualAccount ? null : env.NOMBA_SUB_ACCOUNT_ID,

        orderReference: null,

        lineItems: {
          create: body.lineItems.map((item) => ({
            description: item.description,
            quantity: new Prisma.Decimal(item.quantity),
            unitPrice: new Prisma.Decimal(item.unitPrice),
            amount: new Prisma.Decimal(item.quantity).mul(new Prisma.Decimal(item.unitPrice)),
          })),
        },
      };

      const invoice = await prisma.$transaction(async (tx) => {
        const freshCustomer = await tx.customer.findUniqueOrThrow({
          where: { id: customer.id },
          select: { creditBalance: true, outstandingDebt: true },
        });

        const inv = await tx.invoice.create({
          data: invoiceData,
          include: {
            customer: true,
            lineItems: true,
          },
        });

        const totalAmount = new Prisma.Decimal(inv.totalAmount);
        let remainingInvoiceBalance = totalAmount;
        let runningCustomerDebt = freshCustomer.outstandingDebt.add(totalAmount);
        let runningCustomerCredit = freshCustomer.creditBalance;

        await tx.ledgerEntry.create({
          data: {
            organizationId: orgId,
            customerId: customer.id,
            invoiceId: inv.id,
            entryType: "INVOICE_CREATED",
            debitAmount: totalAmount,
            creditAmount: new Prisma.Decimal(0),
            runningBalance: runningCustomerDebt.sub(runningCustomerCredit),
            reference: `INV_${invoiceNumber}`,
            description: `Invoice ${invoiceNumber} created`,
          },
        });

        let creditApplied = new Prisma.Decimal(0);

        if (runningCustomerCredit.gt(0)) {
          creditApplied = Prisma.Decimal.min(remainingInvoiceBalance, runningCustomerCredit);
          remainingInvoiceBalance = remainingInvoiceBalance.sub(creditApplied);

          runningCustomerCredit = runningCustomerCredit.sub(creditApplied);
          runningCustomerDebt = runningCustomerDebt.sub(creditApplied);

          await tx.ledgerEntry.create({
            data: {
              organizationId: orgId,
              customerId: customer.id,
              invoiceId: inv.id,
              entryType: "CUSTOMER_CREDIT_APPLIED",
              debitAmount: new Prisma.Decimal(0),
              creditAmount: creditApplied,
              runningBalance: runningCustomerDebt.sub(runningCustomerCredit),
              reference: `CR_APP_${invoiceNumber}`,
              description: `Applied internal wallet credit balance to invoice ${invoiceNumber}`,
            },
          });
        }

        if (creditApplied.gt(0)) {
          await tx.invoice.update({
            where: { id: inv.id },
            data: {
              amountPaid: creditApplied,
              balanceDue: remainingInvoiceBalance,
              status: remainingInvoiceBalance.eq(0) ? "PAID" : "PARTIALLY_PAID",
              paidAt: remainingInvoiceBalance.eq(0) ? new Date() : null,
            },
          });
        }

        await tx.customer.update({
          where: { id: customer.id },
          data: {
            outstandingDebt: runningCustomerDebt,
            creditBalance: runningCustomerCredit,
          },
        });

        return inv;
      });

      await writeAuditLog({
        organizationId: orgId,
        userId: request.user!.sub,
        action: "INVOICE_CREATED",
        entity: "Invoice",
        entityId: invoice.id,
      });

      return {
        success: true,
        data: invoice,
      };
    },
  );

  fastify.get<{ Querystring: { page?: string; limit?: string; status?: InvoiceStatus; customerId?: string } }>(
    "/invoices",
    { schema: { tags: ["Invoices"], description: "Paginated list of organization invoices" } },
    async (request) => {
      const orgId = request.user!.org;
      const page = Number(request.query.page) || 1;
      const limit = Number(request.query.limit) || 20;
      const skip = (page - 1) * limit;

      const where: Prisma.InvoiceWhereInput = {
        organizationId: orgId,
        ...(request.query.status && { status: request.query.status }),
        ...(request.query.customerId && { customerId: request.query.customerId }),
      };

      const [invoices, total] = await Promise.all([
        prisma.invoice.findMany({
          where,
          skip,
          take: limit,
          orderBy: { createdAt: "desc" },
          include: { customer: { select: { name: true, customerCode: true, customerType: true } } },
        }),
        prisma.invoice.count({ where }),
      ]);

      return { success: true, data: invoices, meta: { page, limit, total } };
    },
  );

  fastify.get<{ Params: { id: string } }>("/invoices/:id", { schema: { tags: ["Invoices"], description: "Retrieve detailed invoice with line items and ledger" } }, async (request) => {
    const invoice = await prisma.invoice.findFirst({
      where: { id: request.params.id, organizationId: request.user!.org },
      include: { lineItems: true, customer: true, ledgerEntries: true },
    });
    if (!invoice) throw new AppError("INVOICE_NOT_FOUND", "Invoice not found", 404);
    return { success: true, data: invoice };
  });

  fastify.put<{ Params: { id: string } }>(
    "/invoices/:id",
    {
      preHandler: [requireRole(["OWNER", "FINANCE_MANAGER"])],
      schema: {
        tags: ["Invoices"],
        description: "Update invoice",
        body: CreateInvoiceSchema,
      },
    },
    async (request) => {
      const body = CreateInvoiceSchema.parse(request.body);
      const orgId = request.user!.org;
      const invoiceId = request.params.id;

      const existingInvoice = await prisma.invoice.findFirst({
        where: {
          id: invoiceId,
          organizationId: orgId,
        },
        include: {
          lineItems: true,
        },
      });

      if (!existingInvoice) {
        throw new AppError("INVOICE_NOT_FOUND", "Invoice not found", 404);
      }

      if (existingInvoice.status === "PAID" && existingInvoice.checkoutLink) {
        throw new AppError("INVOICE_ALREADY_PAID", "Paid invoices cannot be edited", 409);
      }

      const customer = await prisma.customer.findFirst({
        where: {
          id: body.customerId,
          organizationId: orgId,
        },
      });

      if (!customer) {
        throw new AppError("CUSTOMER_NOT_FOUND", "Customer not found", 404);
      }

      const totalAmount = body.lineItems.reduce((sum, item) => sum.add(new Prisma.Decimal(item.quantity).mul(new Prisma.Decimal(item.unitPrice))), new Prisma.Decimal(0));

      const invoice = await prisma.$transaction(async (tx) => {
        await tx.lineItem.deleteMany({
          where: {
            invoiceId,
          },
        });

        return tx.invoice.update({
          where: {
            id: invoiceId,
          },
          data: {
            customerId: customer.id,
            dueDate: new Date(body.dueDate),
            notes: body.notes,

            totalAmount,
            balanceDue: totalAmount.sub(existingInvoice.amountPaid),

            checkoutLink: null,
            orderReference: null,
            checkoutExpiresAt: null,

            lineItems: {
              create: body.lineItems.map((item) => ({
                description: item.description,
                quantity: new Prisma.Decimal(item.quantity),
                unitPrice: new Prisma.Decimal(item.unitPrice),
                amount: new Prisma.Decimal(item.quantity).mul(new Prisma.Decimal(item.unitPrice)),
              })),
            },
          },
          include: {
            customer: true,
            lineItems: true,
          },
        });
      });

      await writeAuditLog({
        organizationId: orgId,
        userId: request.user!.sub,
        action: "INVOICE_UPDATED",
        entity: "Invoice",
        entityId: invoice.id,
      });

      return {
        success: true,
        data: invoice,
      };
    },
  );

  fastify.post<{ Params: { id: string } }>(
    "/invoices/:id/payment-options",
    {
      preHandler: [requireRole(["OWNER", "FINANCE_MANAGER"])],
      schema: {
        tags: ["Invoices"],
        description: "Generate Nomba checkout payment options for an invoice",
        body: GeneratePaymentOptionsSchema,
      },
    },
    async (request) => {
      const orgId = request.user!.org;
      const invoiceId = request.params.id;
      const body = GeneratePaymentOptionsSchema.parse(request.body);

      const invoice = await prisma.invoice.findFirst({
        where: {
          id: invoiceId,
          organizationId: orgId,
        },
        include: {
          customer: true,
        },
      });

      if (!invoice) {
        throw new AppError("INVOICE_NOT_FOUND", "Invoice not found", 404);
      }

      if (["PAID", "OVERPAID", "CANCELLED", "EXPIRED"].includes(invoice.status)) {
        throw new AppError("INVALID_INVOICE_STATE", `Invoice is ${invoice.status.toLowerCase()} and cannot generate payment.`, 409);
      }

      /**
       * Return existing checkout if still valid
       */
      if (invoice.checkoutLink && invoice.orderReference && invoice.checkoutExpiresAt && invoice.checkoutExpiresAt > new Date()) {
        return {
          success: true,
          data: {
            checkoutLink: invoice.checkoutLink,
            orderReference: invoice.orderReference,
            expiresAt: invoice.checkoutExpiresAt,
          },
        };
      }

      /**
       * Create Checkout Order
       */
      const checkout = await createNombaCheckoutOrder({
        orderReference: invoice.invoiceNumber,
        customerId: invoice.customer.id,
        customerEmail: invoice.customer.email ?? undefined,
        callbackUrl: `${env.FRONTEND_URL}/payments/result`,

        amount: invoice.balanceDue.toString(),

        accountId: invoice.accountId!,

        allowedPaymentMethods: body.allowedPaymentMethods,
      });

      const expiresAt = addHours(new Date(), 24);

      await prisma.invoice.update({
        where: {
          id: invoice.id,
        },
        data: {
          checkoutLink: checkout.checkoutLink,
          orderReference: checkout.orderReference,
          checkoutExpiresAt: expiresAt,
        },
      });

      return {
        success: true,
        data: {
          checkoutLink: checkout.checkoutLink,
          orderReference: checkout.orderReference,
          expiresAt,
        },
      };
    },
  );

  fastify.patch<{ Params: { id: string } }>("/invoices/:id/cancel", { preHandler: [requireRole(["OWNER"])], schema: { tags: ["Invoices"], description: "Cancel unpaid invoice" } }, async (request) => {
    const invoice = await prisma.invoice.findUnique({ where: { id: request.params.id } });
    if (!invoice || ["PAID", "CANCELLED"].includes(invoice.status)) {
      throw new AppError("INVOICE_NOT_EDITABLE", "Cannot cancel invoice in current state", 409);
    }

    const updated = await prisma.$transaction(async (tx) => {
      const inv = await tx.invoice.update({ where: { id: invoice.id }, data: { status: "CANCELLED", cancelledAt: new Date() } });
      await tx.customer.update({ where: { id: invoice.customerId }, data: { outstandingDebt: { decrement: invoice.balanceDue } } });
      return inv;
    });

    await writeAuditLog({ organizationId: request.user!.org, userId: request.user!.sub, action: "INVOICE_CANCELLED", entity: "Invoice", entityId: invoice.id });
    return { success: true, data: updated };
  });

  fastify.get<{ Params: ReceiptParams }>("/invoices/:id/receipt", async (request: FastifyRequest<{ Params: ReceiptParams }>, reply: FastifyReply) => {
    const { id } = request.params;

    const invoice = await prisma.invoice.findFirst({
      where: {
        id,
        organizationId: request.user!.org,
      },
      include: {
        lineItems: true,
        ledgerEntries: true,
        customer: {
          include: {
            virtualAccount: true,
          },
        },
      },
    });

    if (!invoice) throw new AppError("INVOICE_NOT_FOUND", "Invoice not found", 404);

    const pdfBuffer = await generateReceiptPdf(invoice, invoice.customer.virtualAccount);

    return reply
      .header("Content-Type", "application/pdf")
      .header("Content-Disposition", `inline; filename="${invoice.invoiceNumber || invoice.id}-receipt.pdf"`)
      .send(pdfBuffer);
  });
}
