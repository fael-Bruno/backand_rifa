import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import pkg from "pg";

dotenv.config();
const { Pool } = pkg;

const app = express();
app.use(cors());
app.use(express.json());

// conexão com o banco
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } // necessário para o Render
});

// ---------------------- ROTAS ADMIN ----------------------

// Cadastro de admin
app.post("/admin/cadastrar", async (req, res) => {
  const { email, senha } = req.body;
  if (!email || !senha) {
    return res.status(400).json({ error: "Email e senha são obrigatórios" });
  }

  try {
    const result = await pool.query(
      "INSERT INTO admins (email, senha) VALUES ($1, $2) RETURNING id, email",
      [email, senha]
    );
    res.json({ success: true, admin: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: "Erro ao cadastrar admin", details: err.message });
  }
});

// Login de admin
app.post("/admin/login", async (req, res) => {
  const { email, senha } = req.body;
  if (!email || !senha) {
    return res.status(400).json({ error: "Email e senha obrigatórios" });
  }

  try {
    const result = await pool.query(
      "SELECT * FROM admins WHERE email = $1 AND senha = $2",
      [email, senha]
    );

    if (result.rowCount === 0) {
      return res.status(401).json({ error: "Email ou senha incorretos" });
    }

    res.json({ success: true, message: "Login bem-sucedido" });
  } catch (err) {
    res.status(500).json({ error: "Erro ao logar admin", details: err.message });
  }
});

// ---------------------- ROTAS RIFA ----------------------

// Buscar todos os nomes
app.get("/nomes", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM nomes ORDER BY id ASC");
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: "Erro ao buscar nomes", details: err.message });
  }
});

// Reservar um nome
app.post("/reservar", async (req, res) => {
  const { nomeId } = req.body;
  if (!nomeId) return res.status(400).json({ error: "nomeId é obrigatório" });

  try {
    await pool.query("UPDATE nomes SET status = 'reservado' WHERE id = $1", [nomeId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Erro ao reservar nome", details: err.message });
  }
});

// Criar pedido (registrar compra)
app.post("/comprar", async (req, res) => {
  const { nomeId, usuarioNome, telefone } = req.body;
  if (!nomeId || !usuarioNome || !telefone) {
    return res.status(400).json({ error: "Campos obrigatórios faltando" });
  }

  try {
    await pool.query(
      "INSERT INTO pedidos (nome_id, cliente_nome, telefone) VALUES ($1, $2, $3)",
      [nomeId, usuarioNome, telefone]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Erro ao registrar compra", details: err.message });
  }
});

// Buscar todos os pedidos (usado na página admin)
app.get("/pedidos", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT p.id, p.cliente_nome, p.telefone, n.nome, n.id AS nome_id, n.status
      FROM pedidos p
      JOIN nomes n ON p.nome_id = n.id
      ORDER BY p.id DESC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: "Erro ao buscar pedidos", details: err.message });
  }
});

// Confirmar compra (muda status para vendido)
app.post("/confirmar", async (req, res) => {
  const { nomeId } = req.body;
  if (!nomeId) return res.status(400).json({ error: "nomeId é obrigatório" });

  try {
    await pool.query("UPDATE nomes SET status = 'vendido' WHERE id = $1", [nomeId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Erro ao confirmar compra", details: err.message });
  }
});

// Cancelar reserva (remove pedido e libera nome)
app.post("/cancelar", async (req, res) => {
  const { nomeId } = req.body;
  if (!nomeId) return res.status(400).json({ error: "nomeId é obrigatório" });

  try {
    await pool.query("DELETE FROM pedidos WHERE nome_id = $1", [nomeId]);
    await pool.query("UPDATE nomes SET status = NULL WHERE id = $1", [nomeId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Erro ao cancelar reserva", details: err.message });
  }
});

// ---------------------- INICIAR SERVIDOR ----------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
