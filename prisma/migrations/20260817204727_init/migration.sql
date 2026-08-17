-- CreateTable
CREATE TABLE "AdminUser" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "username" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "lastLoginAt" DATETIME
);

-- CreateTable
CREATE TABLE "Voucher" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,
    "durationMinutes" INTEGER NOT NULL,
    "dataLimitMb" INTEGER,
    "maxDevices" INTEGER NOT NULL DEFAULT 1,
    "maxUses" INTEGER NOT NULL DEFAULT 1,
    "expiresAt" DATETIME,
    "usedCount" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'UNUSED',
    "note" TEXT,
    "batchId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "GuestSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clientMac" TEXT NOT NULL,
    "apMac" TEXT NOT NULL,
    "ssidName" TEXT NOT NULL,
    "radioId" INTEGER NOT NULL,
    "authMethod" TEXT NOT NULL,
    "voucherId" TEXT,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL,
    "endedAt" DATETIME,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "dataUsedBytes" BIGINT NOT NULL DEFAULT 0,
    "redirectUrl" TEXT,
    CONSTRAINT "GuestSession_voucherId_fkey" FOREIGN KEY ("voucherId") REFERENCES "Voucher" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PortalSettings" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'default',
    "logoUrl" TEXT,
    "backgroundUrl" TEXT,
    "backgroundColor" TEXT NOT NULL DEFAULT '#1a1a2e',
    "accentColor" TEXT NOT NULL DEFAULT '#4f46e5',
    "welcomeHeading" TEXT NOT NULL DEFAULT 'Welcome to Guest WiFi',
    "welcomeBody" TEXT NOT NULL DEFAULT 'Please authenticate to access the internet.',
    "termsText" TEXT NOT NULL DEFAULT 'By connecting, you agree to our acceptable use policy.',
    "termsRequired" BOOLEAN NOT NULL DEFAULT true,
    "sharedPasswordEnabled" BOOLEAN NOT NULL DEFAULT true,
    "sharedPasswordHash" TEXT,
    "voucherEnabled" BOOLEAN NOT NULL DEFAULT true,
    "clickThroughEnabled" BOOLEAN NOT NULL DEFAULT false,
    "successHeading" TEXT NOT NULL DEFAULT 'You''re connected!',
    "successBody" TEXT NOT NULL DEFAULT 'Redirecting you shortly...',
    "redirectDelay" INTEGER NOT NULL DEFAULT 3,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "action" TEXT NOT NULL,
    "success" BOOLEAN NOT NULL,
    "details" TEXT,
    "ipAddress" TEXT,
    "clientMac" TEXT,
    "adminId" TEXT,
    "voucherId" TEXT,
    "sessionId" TEXT,
    CONSTRAINT "AuditLog_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "AdminUser" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "AuditLog_voucherId_fkey" FOREIGN KEY ("voucherId") REFERENCES "Voucher" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "AuditLog_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "GuestSession" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "AdminUser_username_key" ON "AdminUser"("username");

-- CreateIndex
CREATE UNIQUE INDEX "Voucher_code_key" ON "Voucher"("code");

-- CreateIndex
CREATE INDEX "GuestSession_clientMac_idx" ON "GuestSession"("clientMac");

-- CreateIndex
CREATE INDEX "GuestSession_status_idx" ON "GuestSession"("status");

-- CreateIndex
CREATE INDEX "AuditLog_timestamp_idx" ON "AuditLog"("timestamp");

-- CreateIndex
CREATE INDEX "AuditLog_action_idx" ON "AuditLog"("action");
