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

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("render.com")
    ? { rejectUnauthorized: false }
    : false
});

// ---------------- CRIA TABELAS ----------------
async function criarTabelas() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS config (
        id SERIAL PRIMARY KEY,
        valor_rifa NUMERIC(10,2) NOT NULL DEFAULT 10.00,
        premio NUMERIC(12,2) NOT NULL DEFAULT 5000.00
      );
    `);

    // garante que exista apenas uma linha
    const cfg = await pool.query("SELECT COUNT(*) FROM config");
    if (parseInt(cfg.rows[0].count) === 0) {
      await pool.query("INSERT INTO config (valor_rifa, premio) VALUES ($1,$2)", [10.0, 5000.0]);
    } else if (parseInt(cfg.rows[0].count) > 1) {
      await pool.query("DELETE FROM config WHERE id NOT IN (SELECT id FROM config ORDER BY id LIMIT 1)");
    }

    await pool.query(`
      CREATE TABLE IF NOT EXISTS admins (
        id SERIAL PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        senha TEXT NOT NULL
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS nomes (
        id SERIAL PRIMARY KEY,
        nome TEXT NOT NULL,
        status TEXT,
        premiado BOOLEAN DEFAULT FALSE
      );
    `);
    const nomes = await pool.query("SELECT COUNT(*) FROM nomes");
    if (parseInt(nomes.rows[0].count) === 0) {
      const valores = Array.from({ length: 100 }, (_, i) => `('Nome ${i + 1}')`).join(",");
      await pool.query(`INSERT INTO nomes (nome) VALUES ${valores}`);
    }

    await pool.query(`
      CREATE TABLE IF NOT EXISTS pedidos (
        id SERIAL PRIMARY KEY,
        nome_id INT REFERENCES nomes(id),
        cliente_nome TEXT NOT NULL,
        telefone TEXT NOT NULL
      );
    `);

    // TABELA DE USUÁRIOS DO PAINEL
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
  } catch (err) {
    console.error("Erro criando tabelas:", err.message);
  }
}
await criarTabelas();

// ---------------- FUNÇÃO GARANTIR PREMIADO ----------------
async function garantirPremiado() {
  try {
    const r = await pool.query("SELECT COUNT(*) FROM nomes WHERE premiado = true");
    if (parseInt(r.rows[0].count) === 0) {
      await pool.query(`
        UPDATE nomes SET premiado = true
        WHERE id = (SELECT id FROM nomes ORDER BY RANDOM() LIMIT 1)
      `);
      console.log("✅ Nome premiado escolhido");
    }
  } catch (err) {
    console.error("Erro garantirPremiado:", err.message);
  }
}

// ---------------- ADMIN LOGIN ----------------
app.post("/admin/login", async (req, res) => {
  const { email, senha } = req.body;
  if (!email || !senha) return res.status(400).json({ error: "Email e senha obrigatórios" });

  try {
    const r = await pool.query("SELECT * FROM admins WHERE email = $1", [email]);
    if (r.rowCount === 0) return res.status(401).json({ error: "Email ou senha incorretos" });

    const admin = r.rows[0];
    if (admin.senha.startsWith("$2b$") || admin.senha.startsWith("$2a$")) {
      const ok = await bcrypt.compare(senha, admin.senha);
      if (!ok) return res.status(401).json({ error: "Email ou senha incorretos" });
    } else {
      if (senha !== admin.senha) return res.status(401).json({ error: "Email ou senha incorretos" });
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Erro ao logar admin", details: err.message });
  }
});

// ---------------- USUÁRIOS ----------------
// Registro de usuário
app.post("/users/register", async (req, res) => {
  try {
    const { email, senha } = req.body;
    if (!email || !senha) return res.status(400).json({ error: "Email e senha obrigatórios" });

    const emailLower = email.trim().toLowerCase();
    const r = await pool.query("SELECT id FROM usuarios WHERE email = $1", [emailLower]);
    if (r.rowCount > 0) return res.status(400).json({ error: "Email já cadastrado" });

    const hash = await bcrypt.hash(senha, 10);
    await pool.query("INSERT INTO usuarios (email, senha, approved, blocked) VALUES ($1,$2,false,false)", [emailLower, hash]);

    res.json({ success: true, message: "Cadastro realizado! Aguarde aprovação do administrador." });
  } catch (err) {
    res.status(500).json({ error: "Erro ao cadastrar usuário", details: err.message });
  }
});

// Login de usuário
app.post("/users/login", async (req, res) => {
  try {
    const { email, senha } = req.body;
    if (!email || !senha) return res.status(400).json({ error: "Email e senha obrigatórios" });

    const r = await pool.query("SELECT id, email, senha, blocked, approved FROM usuarios WHERE email = $1", [email.trim().toLowerCase()]);
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

// ---------------- ADMIN: GERENCIAR USUÁRIOS ----------------
app.get("/admin/users", async (req, res) => {
  try {
    const r = await pool.query("SELECT id, email, approved, blocked, created_at FROM usuarios ORDER BY id DESC");
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: "Erro ao buscar usuários", details: err.message });
  }
});

app.post("/admin/users/approve", async (req, res) => {
  try {
    const { id, approve } = req.body;
    if (!id || typeof approve !== "boolean") return res.status(400).json({ error: "id e approve(boolean) obrigatórios" });
    await pool.query("UPDATE usuarios SET approved = $1 WHERE id = $2", [approve, id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Erro ao aprovar usuário", details: err.message });
  }
});

app.post("/admin/users/block", async (req, res) => {
  try {
    const { id, block } = req.body;
    if (!id || typeof block !== "boolean") return res.status(400).json({ error: "id e block(boolean) obrigatórios" });
    await pool.query("UPDATE usuarios SET blocked = $1 WHERE id = $2", [block, id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Erro ao bloquear usuário", details: err.message });
  }
});

app.delete("/admin/users/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: "id inválido" });
    await pool.query("DELETE FROM usuarios WHERE id = $1", [id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Erro ao excluir usuário", details: err.message });
  }
});

// ---------------- CONFIG, NOMES, PEDIDOS, SORTEIO, RESET ----------------
// (mantive igual ao seu server.js anterior — continua funcionando para rifa)

function parseNumberInput(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === "string") {
    const s = v.replace(/\s/g, "").replace(",", ".");
    const n = parseFloat(s);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  return null;
}

app.get("/config", async (req, res) => {
  try {
    const r = await pool.query("SELECT valor_rifa, premio FROM config LIMIT 1");
    res.json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: "Erro ao buscar configuração" });
  }
});

// ... aqui seguem as rotas de /config POST, /nomes, /comprar, /pedidos, /confirmar, /cancelar, /sorteio, /resetar exatamente como no seu código anterior ...

// ---------------- INICIAR ----------------
await garantirPremiado();
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Servidor rodando na porta " + PORT));
