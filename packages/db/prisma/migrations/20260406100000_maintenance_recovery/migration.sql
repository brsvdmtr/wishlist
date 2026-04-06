-- Maintenance Recovery: incident tracking + per-user exposure

CREATE TABLE "MaintenanceIncident" (
    "id" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'active',
    "recoveryConfirmedAt" TIMESTAMP(3),
    "lastMaintenanceSignalAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "exposureCount" INTEGER NOT NULL DEFAULT 0,
    "notificationsSent" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MaintenanceIncident_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MaintenanceExposure" (
    "id" TEXT NOT NULL,
    "incidentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "surface" TEXT NOT NULL,
    "locale" TEXT NOT NULL DEFAULT 'ru',
    "telegramChatId" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notifiedAt" TIMESTAMP(3),
    "returnedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MaintenanceExposure_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "MaintenanceIncident_status_idx" ON "MaintenanceIncident"("status");
CREATE INDEX "MaintenanceIncident_startedAt_idx" ON "MaintenanceIncident"("startedAt");

CREATE UNIQUE INDEX "MaintenanceExposure_incidentId_userId_surface_key" ON "MaintenanceExposure"("incidentId", "userId", "surface");
CREATE INDEX "MaintenanceExposure_incidentId_notifiedAt_idx" ON "MaintenanceExposure"("incidentId", "notifiedAt");
CREATE INDEX "MaintenanceExposure_userId_idx" ON "MaintenanceExposure"("userId");

ALTER TABLE "MaintenanceExposure" ADD CONSTRAINT "MaintenanceExposure_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "MaintenanceIncident"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MaintenanceExposure" ADD CONSTRAINT "MaintenanceExposure_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
