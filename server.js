require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DB_SSL === "true" ? { rejectUnauthorized: false } : false
});

// Inicializa tabelas
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id SERIAL PRIMARY KEY,
      nome TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      senha TEXT NOT NULL,
      ativo BOOLEAN DEFAULT FALSE,
      criado_em TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS admins (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      senha TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS config (
      id SERIAL PRIMARY KEY,
      valor_rifa NUMERIC,
      premio TEXT,
      usuario_id INT REFERENCES usuarios(id) UNIQUE
    );

    CREATE TABLE IF NOT EXISTS nomes (
      id SERIAL PRIMARY KEY,
      nome TEXT NOT NULL,
      status TEXT DEFAULT 'disponivel',
      usuario_id INT REFERENCES usuarios(id)
    );

    CREATE TABLE IF NOT EXISTS pedidos (
      id SERIAL PRIMARY KEY,
      nome_id INT REFERENCES nomes(id),
      cliente_nome TEXT,
      telefone TEXT,
      status TEXT DEFAULT 'reservado',
      usuario_id INT REFERENCES usuarios(id)
    );
  `);

  const r = await pool.query("SELECT COUNT(*) FROM admins");
  if (parseInt(r.rows[0].count) === 0) {
    await pool.query("INSERT INTO admins (email,senha) VALUES ($1,$2)", [
      "admin@local",
      "123"
    ]);
  }
  console.log("Banco inicializado.");
}
initDB().catch((e) => console.error("Erro initDB:", e));

// ---- ROTAS ADMIN ----
app.post("/admin/login", async (req, res) => {
  const { email, senha } = req.body;
  const r = await pool.query("SELECT * FROM admins WHERE email=$1 AND senha=$2", [email, senha]);
  if (r.rowCount === 0) return res.status(401).json({ error: "Credenciais inválidas" });
  res.json({ success: true });
});

app.get("/usuarios", async (req, res) => {
  const r = await pool.query("SELECT id,nome,email,ativo FROM usuarios ORDER BY id DESC");
  res.json(r.rows);
});

app.post("/usuarios/ativar", async (req, res) => {
  const { usuarioId, ativo } = req.body;
  await pool.query("UPDATE usuarios SET ativo=$1 WHERE id=$2", [ativo, usuarioId]);
  res.json({ success: true });
});

// ---- ROTAS ORGANIZADORES ----
app.post("/usuarios/registro", async (req, res) => {
  const { nome, email, senha } = req.body;
  try {
    const hash = await bcrypt.hash(senha, 10);
    await pool.query("INSERT INTO usuarios (nome,email,senha) VALUES ($1,$2,$3)", [nome, email, hash]);
    res.json({ success: true, message: "Cadastro realizado. Aguarde ativação do admin." });
  } catch (e) {
    res.status(500).json({ error: "Erro no cadastro" });
  }
});

app.post("/usuarios/login", async (req, res) => {
  const { email, senha } = req.body;
  const r = await pool.query("SELECT * FROM usuarios WHERE email=$1", [email]);
  if (r.rowCount === 0) return res.status(401).json({ error: "Usuário não encontrado" });
  const u = r.rows[0];
  if (!u.ativo) return res.status(403).json({ error: "Conta aguardando ativação" });
  const ok = await bcrypt.compare(senha, u.senha);
  if (!ok) return res.status(401).json({ error: "Senha incorreta" });
  res.json({ success: true, usuarioId: u.id });
});

// ---- CONFIGURAÇÃO ----
app.get("/config", async (req, res) => {
  const { usuarioId } = req.query;
  const r = await pool.query("SELECT * FROM config WHERE usuario_id=$1", [usuarioId]);
  res.json(r.rows[0] || {});
});
app.post("/config", async (req, res) => {
  const { valor_rifa, premio, usuarioId } = req.body;
  await pool.query(
    `INSERT INTO config (valor_rifa,premio,usuario_id) VALUES ($1,$2,$3)
     ON CONFLICT (usuario_id) DO UPDATE SET valor_rifa=$1, premio=$2`,
    [valor_rifa, premio, usuarioId]
  );
  res.json({ success: true });
});

// ---- NOMES ----
app.get("/nomes", async (req, res) => {
  const { usuarioId } = req.query;
  const r = await pool.query("SELECT * FROM nomes WHERE usuario_id=$1 ORDER BY id", [usuarioId]);
  res.json(r.rows);
});
app.post("/nomes", async (req, res) => {
  const { nome, usuarioId } = req.body;
  await pool.query("INSERT INTO nomes (nome,usuario_id) VALUES ($1,$2)", [nome, usuarioId]);
  res.json({ success: true });
});

// ---- PEDIDOS ----
app.get("/pedidos", async (req, res) => {
  const { usuarioId } = req.query;
  if (usuarioId) {
    const r = await pool.query(
      "SELECT p.*,n.nome FROM pedidos p JOIN nomes n ON n.id=p.nome_id WHERE p.usuario_id=$1",
      [usuarioId]
    );
    res.json(r.rows);
  } else {
    const r = await pool.query(
      "SELECT p.*,n.nome FROM pedidos p JOIN nomes n ON n.id=p.nome_id ORDER BY p.id DESC"
    );
    res.json(r.rows);
  }
});

app.post("/comprar", async (req, res) => {
  const { nomeId, cliente_nome, telefone, usuarioId } = req.body;
  try {
    await pool.query(
      "INSERT INTO pedidos (nome_id,cliente_nome,telefone,usuario_id) VALUES ($1,$2,$3,$4)",
      [nomeId, cliente_nome, telefone, usuarioId]
    );
    await pool.query("UPDATE nomes SET status='reservado' WHERE id=$1", [nomeId]);
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: "Erro ao reservar" });
  }
});

app.post("/confirmar", async (req, res) => {
  const { nomeId } = req.body;
  await pool.query("UPDATE pedidos SET status='confirmado' WHERE nome_id=$1", [nomeId]);
  await pool.query("UPDATE nomes SET status='vendido' WHERE id=$1", [nomeId]);
  res.json({ success: true });
});

app.post("/cancelar", async (req, res) => {
  const { nomeId } = req.body;
  await pool.query("DELETE FROM pedidos WHERE nome_id=$1", [nomeId]);
  await pool.query("UPDATE nomes SET status='disponivel' WHERE id=$1", [nomeId]);
  res.json({ success: true });
});

// ---- SORTEIO E RESET ----
app.get("/sorteio", async (req, res) => {
  const { usuarioId } = req.query;
  const r = await pool.query(
    "SELECT p.*,n.nome FROM pedidos p JOIN nomes n ON n.id=p.nome_id WHERE p.status='confirmado' AND p.usuario_id=$1 ORDER BY RANDOM() LIMIT 1",
    [usuarioId]
  );
  if (r.rowCount === 0) return res.status(404).json({ error: "Nenhum pedido confirmado" });
  res.json(r.rows[0]);
});
app.post("/resetar", async (req, res) => {
  const { usuarioId } = req.body;
  await pool.query("DELETE FROM pedidos WHERE usuario_id=$1", [usuarioId]);
  await pool.query("UPDATE nomes SET status='disponivel' WHERE usuario_id=$1", [usuarioId]);
  res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Servidor ativo"));
