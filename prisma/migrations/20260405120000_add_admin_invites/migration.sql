-- CreateTable
CREATE TABLE "AdminInvites" (
    "id" SERIAL NOT NULL,
    "token" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "roleId" INTEGER NOT NULL,
    "invitedById" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdminInvites_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AdminInvites_token_key" ON "AdminInvites"("token");

-- CreateIndex
CREATE INDEX "AdminInvites_email_acceptedAt_idx" ON "AdminInvites"("email", "acceptedAt");

-- AddForeignKey
ALTER TABLE "AdminInvites" ADD CONSTRAINT "AdminInvites_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminInvites" ADD CONSTRAINT "AdminInvites_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES "Users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
