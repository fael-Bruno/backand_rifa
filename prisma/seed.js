import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  // Cria usuário MASTER
  const passwordHash = await bcrypt.hash("master123", 10);
  await prisma.user.upsert({
    where: { email: "master@barbearia.com" },
    update: {},
    create: {
      name: "Administrador",
      email: "master@barbearia.com",
      password: passwordHash,
      role: "MASTER"
    }
  });

  // Cria barbearia de teste
  await prisma.barber.upsert({
    where: { name: "Barbearia Central" },
    update: {},
    create: {
      name: "Barbearia Central",
      address: "Rua Principal, 123",
      phone: "99999-9999"
    }
  });

  console.log("Seed concluído!");
}

main()
  .catch(e => console.error(e))
  .finally(async () => await prisma.$disconnect());
