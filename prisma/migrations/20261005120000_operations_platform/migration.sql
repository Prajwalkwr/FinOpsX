-- CreateEnum
CREATE TYPE "SettlementBatchStatus" AS ENUM ('PENDING', 'PROCESSING', 'SETTLED', 'DELAYED', 'FAILED');

-- CreateEnum
CREATE TYPE "ReconStatus" AS ENUM ('MATCHED', 'MISMATCH', 'INVESTIGATING', 'RESOLVED');

-- CreateEnum
CREATE TYPE "ReconIssue" AS ENUM ('MISSING_AT_INSTITUTION', 'MISSING_ON_PLATFORM', 'AMOUNT_MISMATCH', 'NOT_SETTLED');

-- CreateEnum
CREATE TYPE "JobType" AS ENUM ('EOD_SETTLEMENT', 'TRANSACTION_RECONCILIATION', 'DAILY_REPORT', 'DATA_VALIDATION', 'BACKUP_SIMULATION', 'SETTLEMENT_VALIDATION');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "DqType" AS ENUM ('MISSING_MERCHANT_REFERENCE', 'DUPLICATE_CORRELATION_ID', 'INVALID_CUSTOMER_ID', 'MISSING_RESPONSE_CODE', 'MISSING_FAILURE_REASON', 'DELAYED_SETTLEMENT', 'MISSING_LEDGER_RECORD');

-- CreateEnum
CREATE TYPE "DqStatus" AS ENUM ('OPEN', 'INVESTIGATING', 'RESOLVED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "TxStatus" ADD VALUE 'INITIATED';
ALTER TYPE "TxStatus" ADD VALUE 'PROCESSING';
ALTER TYPE "TxStatus" ADD VALUE 'REVERSED';
ALTER TYPE "TxStatus" ADD VALUE 'SETTLED';

-- AlterEnum (rename values in place so existing rows keep their meaning)
ALTER TYPE "PaymentMethod" RENAME VALUE 'MOBILE_BANKING' TO 'ACCOUNT_PAYMENT';
ALTER TYPE "IncidentStatus" RENAME VALUE 'OPEN' TO 'DETECTED';
ALTER TYPE "IncidentStatus" RENAME VALUE 'CLOSED' TO 'POST_INCIDENT_REVIEW';
ALTER TYPE "IncidentStatus" ADD VALUE 'ACKNOWLEDGED';
ALTER TYPE "AnomalyType" RENAME VALUE 'API_LATENCY_ANOMALY' TO 'API_LATENCY_SPIKE';
ALTER TYPE "AnomalyType" RENAME VALUE 'MERCHANT_ACTIVITY_ANOMALY' TO 'MERCHANT_VOLUME_SPIKE';
ALTER TYPE "AnomalyType" RENAME VALUE 'BANK_FAILURE_SPIKE' TO 'FAILURE_RATE_SPIKE';
ALTER TYPE "AnomalyType" ADD VALUE 'INSTITUTION_ACTIVITY';

-- AlterEnum
ALTER TYPE "AnomalyStatus" ADD VALUE 'RESOLVED';

-- AlterEnum
ALTER TYPE "ReportType" ADD VALUE 'RECONCILIATION_REPORT';

-- DropIndex
DROP INDEX "Transaction_transactionId_idx";

-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN     "authenticatedAt" TIMESTAMP(3),
ADD COLUMN     "completedAt" TIMESTAMP(3),
ADD COLUMN     "destinationInstitutionId" TEXT,
ADD COLUMN     "initiatedAt" TIMESTAMP(3),
ADD COLUMN     "lifecycleStage" TEXT NOT NULL DEFAULT 'COMPLETED',
ADD COLUMN     "merchantReference" TEXT,
ADD COLUMN     "processedAt" TIMESTAMP(3),
ADD COLUMN     "responseCode" TEXT,
ADD COLUMN     "serviceKey" TEXT NOT NULL DEFAULT 'payment-api',
ADD COLUMN     "settledAt" TIMESTAMP(3),
ADD COLUMN     "settlementId" TEXT;

-- AlterTable
ALTER TABLE "Service" ADD COLUMN     "description" TEXT,
ADD COLUMN     "errorRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "layer" TEXT;

-- AlterTable
ALTER TABLE "ApiMetric" ADD COLUMN     "name" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "p50Ms" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "SystemMetric" ADD COLUMN     "cacheUsagePct" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "eventLoopLagMs" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "processMemoryMb" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "replicationLagMs" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "slowQueries" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "storageMb" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Incident" ADD COLUMN     "acknowledgedAt" TIMESTAMP(3),
ADD COLUMN     "preventiveAction" TEXT,
ADD COLUMN     "rca" JSONB,
ADD COLUMN     "reopenCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "rootCauseConfirmed" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "scenario" TEXT,
ADD COLUMN     "team" TEXT;

-- AlterTable
ALTER TABLE "IncidentEvent" ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'EVENT';

-- AlterTable
ALTER TABLE "Anomaly" ADD COLUMN     "entityName" TEXT,
ADD COLUMN     "entityType" TEXT,
ADD COLUMN     "normalValue" DOUBLE PRECISION,
ADD COLUMN     "observedValue" DOUBLE PRECISION,
ADD COLUMN     "resolvedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "AiMessage" ADD COLUMN     "actions" JSONB;

-- AlterTable
ALTER TABLE "SimulatorConfig" ADD COLUMN     "averageAmount" INTEGER NOT NULL DEFAULT 3500;

-- CreateTable
CREATE TABLE "InstitutionLedgerEntry" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "transactionRef" TEXT NOT NULL,
    "transactionId" TEXT,
    "amount" DECIMAL(14,2) NOT NULL,
    "status" TEXT NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InstitutionLedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Settlement" (
    "id" TEXT NOT NULL,
    "publicId" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "status" "SettlementBatchStatus" NOT NULL DEFAULT 'PENDING',
    "transactionCount" INTEGER NOT NULL,
    "amount" DECIMAL(16,2) NOT NULL,
    "expectedAt" TIMESTAMP(3),
    "settledAt" TIMESTAMP(3),
    "jobId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Settlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReconciliationRun" (
    "id" TEXT NOT NULL,
    "publicId" TEXT NOT NULL,
    "windowFrom" TIMESTAMP(3) NOT NULL,
    "windowTo" TIMESTAMP(3) NOT NULL,
    "institutionId" TEXT,
    "status" "ReconStatus" NOT NULL,
    "expectedCount" INTEGER NOT NULL,
    "actualCount" INTEGER NOT NULL,
    "matchedCount" INTEGER NOT NULL,
    "unmatchedCount" INTEGER NOT NULL,
    "expectedAmount" DECIMAL(16,2) NOT NULL,
    "actualAmount" DECIMAL(16,2) NOT NULL,
    "difference" DECIMAL(16,2) NOT NULL,
    "settledCount" INTEGER NOT NULL DEFAULT 0,
    "settledAmount" DECIMAL(16,2) NOT NULL DEFAULT 0,
    "settlementDifference" DECIMAL(16,2) NOT NULL DEFAULT 0,
    "notes" TEXT,
    "createdById" TEXT,
    "jobId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReconciliationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReconciliationItem" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "transactionRef" TEXT NOT NULL,
    "institutionId" TEXT,
    "issue" "ReconIssue" NOT NULL,
    "platformAmount" DECIMAL(14,2),
    "institutionAmount" DECIMAL(14,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReconciliationItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OperationalJob" (
    "id" TEXT NOT NULL,
    "publicId" TEXT NOT NULL,
    "type" "JobType" NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "recordsProcessed" INTEGER NOT NULL DEFAULT 0,
    "successfulRecords" INTEGER NOT NULL DEFAULT 0,
    "failedRecords" INTEGER NOT NULL DEFAULT 0,
    "triggeredBy" TEXT NOT NULL,
    "output" JSONB,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OperationalJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DataQualityIssue" (
    "id" TEXT NOT NULL,
    "publicId" TEXT NOT NULL,
    "type" "DqType" NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "affectedCount" INTEGER NOT NULL DEFAULT 0,
    "status" "DqStatus" NOT NULL DEFAULT 'OPEN',
    "note" TEXT,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastCheckedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DataQualityIssue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceDependency" (
    "id" TEXT NOT NULL,
    "fromServiceId" TEXT NOT NULL,
    "toServiceId" TEXT NOT NULL,

    CONSTRAINT "ServiceDependency_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiCall" (
    "id" TEXT NOT NULL,
    "endpointId" TEXT NOT NULL,
    "statusCode" INTEGER NOT NULL,
    "latencyMs" INTEGER NOT NULL,
    "institutionId" TEXT,
    "transactionRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApiCall_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiQuery" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "kind" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "intent" TEXT,
    "structuredQuery" JSONB,
    "resultCount" INTEGER,
    "status" TEXT NOT NULL,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiQuery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InstitutionLedgerEntry_transactionId_key" ON "InstitutionLedgerEntry"("transactionId");

-- CreateIndex
CREATE INDEX "InstitutionLedgerEntry_institutionId_recordedAt_idx" ON "InstitutionLedgerEntry"("institutionId", "recordedAt");

-- CreateIndex
CREATE INDEX "InstitutionLedgerEntry_recordedAt_idx" ON "InstitutionLedgerEntry"("recordedAt");

-- CreateIndex
CREATE INDEX "InstitutionLedgerEntry_transactionRef_idx" ON "InstitutionLedgerEntry"("transactionRef");

-- CreateIndex
CREATE UNIQUE INDEX "Settlement_publicId_key" ON "Settlement"("publicId");

-- CreateIndex
CREATE INDEX "Settlement_createdAt_idx" ON "Settlement"("createdAt");

-- CreateIndex
CREATE INDEX "Settlement_status_idx" ON "Settlement"("status");

-- CreateIndex
CREATE UNIQUE INDEX "ReconciliationRun_publicId_key" ON "ReconciliationRun"("publicId");

-- CreateIndex
CREATE INDEX "ReconciliationRun_createdAt_idx" ON "ReconciliationRun"("createdAt");

-- CreateIndex
CREATE INDEX "ReconciliationRun_status_idx" ON "ReconciliationRun"("status");

-- CreateIndex
CREATE INDEX "ReconciliationItem_runId_idx" ON "ReconciliationItem"("runId");

-- CreateIndex
CREATE UNIQUE INDEX "OperationalJob_publicId_key" ON "OperationalJob"("publicId");

-- CreateIndex
CREATE INDEX "OperationalJob_createdAt_idx" ON "OperationalJob"("createdAt");

-- CreateIndex
CREATE INDEX "OperationalJob_type_status_idx" ON "OperationalJob"("type", "status");

-- CreateIndex
CREATE UNIQUE INDEX "DataQualityIssue_publicId_key" ON "DataQualityIssue"("publicId");

-- CreateIndex
CREATE UNIQUE INDEX "DataQualityIssue_type_key" ON "DataQualityIssue"("type");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceDependency_fromServiceId_toServiceId_key" ON "ServiceDependency"("fromServiceId", "toServiceId");

-- CreateIndex
CREATE INDEX "ApiCall_endpointId_createdAt_idx" ON "ApiCall"("endpointId", "createdAt");

-- CreateIndex
CREATE INDEX "ApiCall_createdAt_idx" ON "ApiCall"("createdAt");

-- CreateIndex
CREATE INDEX "AiQuery_createdAt_idx" ON "AiQuery"("createdAt");

-- CreateIndex
CREATE INDEX "AiQuery_userId_idx" ON "AiQuery"("userId");

-- CreateIndex
CREATE INDEX "Transaction_institutionId_createdAt_idx" ON "Transaction"("institutionId", "createdAt");

-- CreateIndex
CREATE INDEX "Transaction_correlationId_idx" ON "Transaction"("correlationId");

-- CreateIndex
CREATE INDEX "Transaction_settlementStatus_idx" ON "Transaction"("settlementStatus");

-- CreateIndex
CREATE INDEX "Transaction_settlementId_idx" ON "Transaction"("settlementId");

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_destinationInstitutionId_fkey" FOREIGN KEY ("destinationInstitutionId") REFERENCES "Institution"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "Settlement"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InstitutionLedgerEntry" ADD CONSTRAINT "InstitutionLedgerEntry_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "Institution"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InstitutionLedgerEntry" ADD CONSTRAINT "InstitutionLedgerEntry_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Settlement" ADD CONSTRAINT "Settlement_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "Institution"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReconciliationRun" ADD CONSTRAINT "ReconciliationRun_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "Institution"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReconciliationRun" ADD CONSTRAINT "ReconciliationRun_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReconciliationItem" ADD CONSTRAINT "ReconciliationItem_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ReconciliationRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceDependency" ADD CONSTRAINT "ServiceDependency_fromServiceId_fkey" FOREIGN KEY ("fromServiceId") REFERENCES "Service"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceDependency" ADD CONSTRAINT "ServiceDependency_toServiceId_fkey" FOREIGN KEY ("toServiceId") REFERENCES "Service"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiCall" ADD CONSTRAINT "ApiCall_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "ApiMetric"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiQuery" ADD CONSTRAINT "AiQuery_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

