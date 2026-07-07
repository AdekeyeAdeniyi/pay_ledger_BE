# PayLedger Backend

PayLedger Backend is a RESTful API for invoice management, customer
management, virtual accounts, payment reconciliation, and bookkeeping
automation using Nomba.

## Features

-   JWT Authentication
-   Organization & User Management
-   Customer Management
-   Virtual Account Provisioning
-   Invoice Management
-   Automatic Payment Reconciliation
-   Customer Credit Handling
-   Double-entry Ledger
-   Dashboard Statistics
-   Transaction History
-   Audit Logging
-   BullMQ Background Workers
-   Swagger API Documentation

## Tech Stack

-   **Runtime:** Bun
-   **Framework:** Fastify
-   **Language:** TypeScript
-   **Database:** PostgreSQL
-   **ORM:** Prisma
-   **Queue:** BullMQ
-   **Cache:** Redis
-   **Validation:** Zod
-   **Logging:** Pino
-   **Authentication:** JWT

## Project Structure

``` text
src/
├── config/
├── middleware/
├── routes/
├── services/
├── workers/
├── queues/
├── utils/
├── prisma/
└── server.ts
```

## Installation

``` bash
git clone <repository-url>
cd payledger-backend
bun install
```

## Environment Variables

Create a `.env` file.

``` env
DATABASE_URL=
JWT_SECRET=
JWT_EXPIRES_IN=
REDIS_URL=

NOMBA_BASE_URL=
NOMBA_CLIENT_ID=
NOMBA_CLIENT_SECRET=
NOMBA_API_KEY=
NOMBA_WEBHOOK_SECRET=
NOMBA_SUB_ACCOUNT_ID=

LOG_LEVEL=debug
PORT=3000
```

## Available Scripts

``` json
{
  "scripts": {
    "dev": "bun --watch src/server.ts",
    "build": "bunx prisma generate && tsc",
    "start": "bun dist/server.js",
    "prisma:generate": "bunx prisma generate",
    "prisma:migrate": "bunx prisma migrate dev",
    "lint": "eslint . --ext .ts"
  }
}
```

### Development

``` bash
bun run dev
```

### Build

``` bash
bun run build
```

### Start

``` bash
bun run start
```

### Generate Prisma Client

``` bash
bun run prisma:generate
```

### Run Migrations

``` bash
bun run prisma:migrate
```

### Lint

``` bash
bun run lint
```

## Payment Flow

1.  Customer pays into a virtual account.
2.  Nomba sends a webhook.
3.  Webhook signature is verified.
4.  Event is stored.
5.  Reconciliation job is queued.
6.  Worker allocates payment to invoices.
7.  Ledger entries are created.
8.  Excess payment is stored as customer credit.
9.  Dashboard statistics are updated.

## API Highlights

-   Authentication
-   Organizations
-   Customers
-   Virtual Accounts
-   Invoices
-   Transactions
-   Dashboard
-   Webhooks

Swagger documentation is available after starting the server:

    http://localhost:3000/docs

## License

Private project.
