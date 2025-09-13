require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// 🔧 Inicializar tabelas
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
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS admins (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      senha TEXT NOT NULL
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS config (
      id SERIAL PRIMARY KEY,
      valor_rifa NUMERIC,
      premio TEXT,
      usuario_id INT REFERENCES usuarios(id)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS nomes (
      id SERIAL PRIMARY KEY,
      nome TEXT NOT NULL,
      status TEXT DEFAULT 'disponivel',
      usuario_id INT REFERENCES usuarios(id)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS pedidos (
      id SERIAL PRIMARY KEY,
      nome_id INT REFERENCES nomes(id),
      cliente_nome TEXT,
      telefone TEXT,
      status TEXT DEFAULT 'reservado',
      usuario_id INT REFERENCES usuarios(id)
    );
  `);

  // cria admin padrão se não existir
  await pool.query(`
    INSERT INTO admins (email, senha)
    VALUES ('admin@local', '123')
    ON CONFLICT (email) DO NOTHING;
  `);
}
initDB();

// 🧍 Cadastro de organizador
app.post("/usuarios/registro", async (req, res) => {
  const { nome, email, senha } = req.body;
  try {
    await pool.query(
      "INSERT INTO usuarios (nome, email, senha) VALUES ($1,$2,$3)",
      [nome, email, senha]
    );
    res.json({ success: true, message: "Conta criada. Aguarde ativação pelo Admin Geral." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao cadastrar usuário" });
  }
});

// 🧍 Login de organizador
app.post("/usuarios/login", async (req, res) => {
  const { email, senha } = req.body;
  try {
    const r = await pool.query("SELECT id,ativo FROM usuarios WHERE email=$1 AND senha=$2", [email, senha]);
    if (r.rowCount === 0) return res.status(401).json({ error: "Credenciais inválidas." });
    if (!r.rows[0].ativo) return res.status(403).json({ error: "Conta aguardando ativação." });
    res.json({ success: true, usuarioId: r.rows[0].id });
  } catch {
    res.status(500).json({ error: "Erro ao fazer login" });
  }
});

// 🧍 Listar usuários
app.get("/usuarios", async (req, res) => {
  try {
    const r = await pool.query("SELECT id,nome,email,ativo FROM usuarios ORDER BY id");
    res.json(r.rows);
  } catch {
    res.status(500).json({ error: "Erro ao buscar usuários" });
  }
});

// 🧍 Ativar/Bloquear usuário
app.post("/usuarios/ativar", async (req, res) => {
  const { usuarioId, ativo } = req.body;
  try {
    await pool.query("UPDATE usuarios SET ativo=$1 WHERE id=$2", [ativo, usuarioId]);
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: "Erro ao atualizar usuário" });
  }
});

// 🔐 Login do Admin Geral
app.post("/admin/login", async (req, res) => {
  const { email, senha } = req.body;
  try {
    const r = await pool.query("SELECT * FROM admins WHERE email=$1 AND senha=$2", [email, senha]);
    if (r.rowCount === 0) return res.status(401).json({ error: "Credenciais inválidas" });
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: "Erro ao fazer login" });
  }
});

// ⚙️ CONFIGURAÇÕES
app.get("/config", async (req, res) => {
  const { usuarioId } = req.query;
  try {
    const r = await pool.query("SELECT * FROM config WHERE usuario_id=$1 LIMIT 1", [usuarioId]);
    res.json(r.rows[0] || {});
  } catch {
    res.status(500).json({ error: "Erro ao buscar config" });
  }
});

app.post("/config", async (req, res) => {
  const { valor_rifa, premio, usuarioId } = req.body;
  try {
    const existe = await pool.query("SELECT id FROM config WHERE usuario_id=$1", [usuarioId]);
    if (existe.rowCount > 0) {
      await pool.query("UPDATE config SET valor_rifa=$1, premio=$2 WHERE usuario_id=$3", [valor_rifa, premio, usuarioId]);
    } else {
      await pool.query("INSERT INTO config (valor_rifa, premio, usuario_id) VALUES ($1,$2,$3)", [valor_rifa, premio, usuarioId]);
    }
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: "Erro ao salvar config" });
  }
});

// 📋 NOMES
app.get("/nomes", async (req, res) => {
  const { usuarioId } = req.query;
  try {
    const r = await pool.query("SELECT * FROM nomes WHERE usuario_id=$1 ORDER BY id", [usuarioId]);
    res.json(r.rows);
  } catch {
    res.status(500).json({ error: "Erro ao buscar nomes" });
  }
});

app.post("/nomes", async (req, res) => {
  const { nome, usuarioId } = req.body;
  try {
    await pool.query("INSERT INTO nomes (nome, usuario_id) VALUES ($1,$2)", [nome, usuarioId]);
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: "Erro ao adicionar nome" });
  }
});

// 🛒 PEDIDOS
app.get("/pedidos", async (req, res) => {
  const { usuarioId } = req.query;
  try {
    let r;
    if (usuarioId) {
      r = await pool.query(`
        SELECT p.*, n.nome
        FROM pedidos p JOIN nomes n ON p.nome_id=n.id
        WHERE p.usuario_id=$1
      `, [usuarioId]);
    } else {
      r = await pool.query(`
        SELECT p.*, n.nome
        FROM pedidos p JOIN nomes n ON p.nome_id=n.id
      `);
    }
    res.json(r.rows);
  } catch {
    res.status(500).json({ error: "Erro ao buscar pedidos" });
  }
});

app.post("/comprar", async (req, res) => {
  const { nomeId, cliente_nome, telefone, usuarioId } = req.body;
  try {
    await pool.query("UPDATE nomes SET status='reservado' WHERE id=$1", [nomeId]);
    await pool.query(
      "INSERT INTO pedidos (nome_id, cliente_nome, telefone, usuario_id) VALUES ($1,$2,$3,$4)",
      [nomeId, cliente_nome, telefone, usuarioId]
    );
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: "Erro ao reservar nome" });
  }
});

app.post("/confirmar", async (req, res) => {
  const { nomeId } = req.body;
  try {
    await pool.query("UPDATE nomes SET status='vendido' WHERE id=$1", [nomeId]);
    await pool.query("UPDATE pedidos SET status='confirmado' WHERE nome_id=$1", [nomeId]);
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: "Erro ao confirmar" });
  }
});

app.post("/cancelar", async (req, res) => {
  const { nomeId } = req.body;
  try {
    await pool.query("UPDATE nomes SET status='disponivel' WHERE id=$1", [nomeId]);
    await pool.query("DELETE FROM pedidos WHERE nome_id=$1", [nomeId]);
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: "Erro ao cancelar" });
  }
});

// 🎯 SORTEIO
app.get("/sorteio", async (req, res) => {
  const { usuarioId } = req.query;
  try {
    const r = await pool.query(`
      SELECT p.*, n.nome FROM pedidos p
      JOIN nomes n ON p.nome_id = n.id
      WHERE p.status='confirmado' AND p.usuario_id=$1
      ORDER BY RANDOM() LIMIT 1
    `, [usuarioId]);
    if (r.rowCount === 0) return res.json({ error: "Nenhum participante confirmado" });
    res.json(r.rows[0]);
  } catch {
    res.status(500).json({ error: "Erro ao realizar sorteio" });
  }
});

// ♻️ RESET
app.post("/resetar", async (req, res) => {
  const { usuarioId } = req.body;
  try {
    await pool.query("DELETE FROM pedidos WHERE usuario_id=$1", [usuarioId]);
    await pool.query("UPDATE nomes SET status='disponivel' WHERE usuario_id=$1", [usuarioId]);
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: "Erro ao resetar" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Servidor rodando na porta " + PORT));
