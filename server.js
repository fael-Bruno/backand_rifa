import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import pkg from "pg";
import bcrypt from "bcrypt";

dotenv.config();
const { Pool } = pkg;

const app = express();
app.use(cors());
app.use(express.json());

// Conexão com Postgres
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("render.com")
    ? { rejectUnauthorized: false }
    : false
});

pool.on("error", (err) => console.error("Erro no pool do Postgres:", err));

// ---------------- CRIA TABELAS ----------------
async function criarTabelas() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS usuarios (
        id SERIAL PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        senha TEXT NOT NULL,
        approved BOOLEAN DEFAULT false,
        blocked BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log("✅ Tabela usuarios criada/verificada");
  } catch (err) {
    console.error("Erro criando tabelas:", err.message);
  }
}
await criarTabelas();

// ---------------- USUÁRIOS ----------------
// Registro de usuário
app.post("/users/register", async (req, res) => {
  try {
    console.log("Recebido registro:", req.body);
    const { email, senha } = req.body;
    if (!email || !senha)
      return res.status(400).json({ error: "Email e senha obrigatórios" });

    const emailLower = email.trim().toLowerCase();

    const r = await pool.query("SELECT id FROM usuarios WHERE email = $1", [emailLower]);
    if (r.rowCount > 0) {
      console.log("Email já cadastrado:", emailLower);
      return res.status(400).json({ error: "Email já cadastrado" });
    }

    const hash = await bcrypt.hash(senha, 10);
    await pool.query(
      "INSERT INTO usuarios (email, senha, approved, blocked) VALUES ($1,$2,false,false)",
      [emailLower, hash]
    );

    console.log("Usuário cadastrado com sucesso:", emailLower);
    res.json({ success: true, message: "Cadastro realizado! Aguarde aprovação do administrador." });

  } catch (err) {
    console.error("Erro ao cadastrar usuário:", err);
    res.status(500).json({ error: "Erro ao cadastrar usuário", details: err.message });
  }
});

// Login de usuário
app.post("/users/login", async (req, res) => {
  try {
    const { email, senha } = req.body;
    if (!email || !senha)
      return res.status(400).json({ error: "Email e senha obrigatórios" });

    const r = await pool.query(
      "SELECT id, email, senha, blocked, approved FROM usuarios WHERE email = $1",
      [email.trim().toLowerCase()]
    );

    if (r.rowCount === 0) return res.status(401).json({ error: "Email ou senha incorretos" });

    const u = r.rows[0];
    if (!u.approved) return res.status(403).json({ error: "Aguardando aprovação do administrador" });
    if (u.blocked) return res.status(403).json({ error: "Usuário bloqueado" });

    const ok = await bcrypt.compare(senha, u.senha);
    if (!ok) return res.status(401).json({ error: "Email ou senha incorretos" });

    res.json({ success: true, user: { id: u.id, email: u.email } });

  } catch (err) {
    res.status(500).json({ error: "Erro ao logar usuário", details: err.message });
  }
});

// ---------------- INICIAR SERVIDOR ----------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Servidor rodando na porta " + PORT));
