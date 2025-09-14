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
    // Usuários
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

    // Admins
    await pool.query(`
      CREATE TABLE IF NOT EXISTS admins (
        id SERIAL PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        senha TEXT NOT NULL
      );
    `);

    // Config
    await pool.query(`
      CREATE TABLE IF NOT EXISTS config (
        id SERIAL PRIMARY KEY,
        valor_rifa NUMERIC(10,2) NOT NULL DEFAULT 10.00,
        premio NUMERIC(12,2) NOT NULL DEFAULT 5000.00
      );
    `);

    // Nomes
    await pool.query(`
      CREATE TABLE IF NOT EXISTS nomes (
        id SERIAL PRIMARY KEY,
        nome TEXT NOT NULL,
        status TEXT,
        premiado BOOLEAN DEFAULT FALSE
      );
    `);

    // Pedidos
    await pool.query(`
      CREATE TABLE IF NOT EXISTS pedidos (
        id SERIAL PRIMARY KEY,
        nome_id INT REFERENCES nomes(id),
        cliente_nome TEXT NOT NULL,
        telefone TEXT NOT NULL
      );
    `);

    console.log("✅ Tabelas criadas/verificadas com sucesso");
  } catch (err) {
    console.error("Erro criando tabelas:", err.message);
  }
}
await criarTabelas();

// ---------------- USUÁRIOS ----------------
// Registro de usuário
app.post("/users/register", async (req, res) => {
  try {
    console.log("🟢 Requisição recebida em /users/register:", req.body);

    const { email, senha } = req.body;
    if (!email || !senha)
      return res.status(400).json({ error: "Email e senha obrigatórios" });

    const emailLower = email.trim().toLowerCase();

    const r = await pool.query("SELECT id FROM usuarios WHERE email = $1", [emailLower]);
    if (r.rowCount > 0) {
      console.log("⚠️ Email já cadastrado:", emailLower);
      return res.status(400).json({ error: "Email já cadastrado" });
    }

    const hash = await bcrypt.hash(senha, 10);

    const insert = await pool.query(
      "INSERT INTO usuarios (email, senha, approved, blocked) VALUES ($1,$2,false,false) RETURNING id",
      [emailLower, hash]
    );

    console.log("✅ Usuário cadastrado com sucesso:", insert.rows[0].id);
    res.json({ success: true, message: "Cadastro realizado! Aguarde aprovação do administrador." });

  } catch (err) {
    console.error("❌ Erro ao cadastrar usuário:", err);
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

// ---------------- ADMINS ----------------
// Login admin
app.post("/admin/login", async (req, res) => {
  try {
    const { email, senha } = req.body;
    if (!email || !senha) return res.status(400).json({ error: "Email e senha obrigatórios" });

    const r = await pool.query("SELECT * FROM admins WHERE email = $1", [email.trim().toLowerCase()]);
    if (r.rowCount === 0) return res.status(401).json({ error: "Admin não encontrado" });

    const admin = r.rows[0];
    const ok = await bcrypt.compare(senha, admin.senha);
    if (!ok) return res.status(401).json({ error: "Senha incorreta" });

    res.json({ success: true, admin: { id: admin.id, email: admin.email } });
  } catch (err) {
    res.status(500).json({ error: "Erro ao logar admin", details: err.message });
  }
});

// Listar usuários
app.get("/admin/users", async (req, res) => {
  try {
    const r = await pool.query("SELECT id,email,approved,blocked FROM usuarios ORDER BY id ASC");
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: "Erro ao listar usuários", details: err.message });
  }
});

// Aprovar/reprovar usuário
app.post("/admin/users/approve", async (req, res) => {
  const { id, approve } = req.body;
  try {
    await pool.query("UPDATE usuarios SET approved = $1 WHERE id = $2", [approve, id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Erro ao aprovar usuário", details: err.message });
  }
});

// Bloquear/desbloquear usuário
app.post("/admin/users/block", async (req, res) => {
  const { id, block } = req.body;
  try {
    await pool.query("UPDATE usuarios SET blocked = $1 WHERE id = $2", [block, id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Erro ao bloquear usuário", details: err.message });
  }
});

// Excluir usuário
app.delete("/admin/users/:id", async (req, res) => {
  try {
    await pool.query("DELETE FROM usuarios WHERE id = $1", [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Erro ao excluir usuário", details: err.message });
  }
});

// ---------------- INICIAR SERVIDOR ----------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Servidor rodando na porta " + PORT));
