-- CreateTable: ServiceHeartbeat
CREATE TABLE "ServiceHeartbeat" (
    "serviceName" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "metadata" TEXT,

    CONSTRAINT "ServiceHeartbeat_pkey" PRIMARY KEY ("serviceName")
);
