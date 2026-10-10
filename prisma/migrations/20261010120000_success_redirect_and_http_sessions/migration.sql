-- AlterTable
ALTER TABLE "PortalSettings" ADD COLUMN "successRedirectUrl" TEXT;

-- CreateTable
CREATE TABLE "HttpSession" (
    "sid" TEXT NOT NULL PRIMARY KEY,
    "data" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "HttpSession_expiresAt_idx" ON "HttpSession"("expiresAt");

