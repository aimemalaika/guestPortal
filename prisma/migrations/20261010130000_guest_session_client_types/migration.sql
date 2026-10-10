-- Store normalized client platform details captured during guest authorization.
ALTER TABLE "GuestSession" ADD COLUMN "osType" TEXT;
ALTER TABLE "GuestSession" ADD COLUMN "deviceType" TEXT;