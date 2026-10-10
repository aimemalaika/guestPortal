import { randomBytes } from 'crypto';
import { hashSync } from 'bcrypt';
import { prisma } from '../db';

// =============================================================================
// Forgotten admin password recovery
//
//   docker exec omada-guest-portal node dist/cli/reset-admin-password.js <username>
//
// Sets a random temporary password, signs the admin out everywhere, and prints
// the temporary password once. Change it afterwards under Admin -> Account.
// =============================================================================

async function main(): Promise<void> {
  const username = process.argv[2];
  if (!username) {
    console.error('Usage: node dist/cli/reset-admin-password.js <username>');
    process.exitCode = 1;
    return;
  }

  const admin = await prisma.adminUser.findUnique({ where: { username } });
  if (!admin) {
    const usernames = (await prisma.adminUser.findMany({ select: { username: true } })).map((a) => a.username);
    console.error(`No admin named '${username}'. Existing admins: ${usernames.join(', ') || '(none)'}`);
    process.exitCode = 1;
    return;
  }

  const temporaryPassword = randomBytes(12).toString('base64url');

  await prisma.adminUser.update({
    where: { id: admin.id },
    data: { passwordHash: hashSync(temporaryPassword, 12) },
  });
  await prisma.httpSession.deleteMany({ where: { data: { contains: `"adminId":"${admin.id}"` } } });
  await prisma.auditLog.create({
    data: {
      action: 'ADMIN_PASSWORD_RESET',
      success: true,
      adminId: admin.id,
      details: JSON.stringify({ via: 'cli' }),
    },
  });

  console.log(`Temporary password for '${username}': ${temporaryPassword}`);
  console.log('Log in with it, then set a new password under Account.');
}

main()
  .catch((error) => {
    console.error('Password reset failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
