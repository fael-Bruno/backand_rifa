import dotenv from "dotenv";
import pkg from "pg";
import bcrypt from "bcrypt";

dotenv.config();
const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("render.com")
    ? { rejectUnauthorized: false }
    : false
});

async function criarAdmin(email, senha) {
  try {
    const hash = await bcrypt.hash(senha, 10);
    await pool.query(
      "INSERT INTO admins (email, senha) VALUES ($1,$2)",
      [email.trim().toLowerCase(), hash]
    );
    console.log("✅ Admin criado com sucesso:", email);
    process.exit(0);
  } catch (err) {
    console.error("❌ Erro ao criar admin:", err.message);
    process.exit(1);
  }
}

// troque pelo email/senha desejado
criarAdmin("admin@teste.com", "123456");
