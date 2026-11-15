-- CreateTable
CREATE TABLE "FavoriteOutfit" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "wearer" TEXT,
    "bodyModelId" TEXT,
    "imageKey" TEXT NOT NULL,
    "items" JSONB NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FavoriteOutfit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FavoriteOutfit_userId_createdAt_idx" ON "FavoriteOutfit"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "FavoriteOutfit" ADD CONSTRAINT "FavoriteOutfit_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
