// server.js - Backend da Rifa (CommonJS)
// Rodar com: node server.js

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Para Render/Heroku geralmente precisa SSL:
  ssl: { rejectUnauthorized: false }
});

const PORT = process.env.PORT || 3000;

/* ---------------------------
   Inicialização do banco
   --------------------------- */
async function initDb() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(`
      ALTER TABLE nomes
      ADD COLUMN IF NOT EXISTS valor DECIMAL(10,2) DEFAULT 10.00;
    `);

    await client.query(`
      ALTER TABLE nomes
      ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'disponivel';
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS pedidos (
        id SERIAL PRIMARY KEY,
        nome_id INT REFERENCES nomes(id),
        cliente_nome VARCHAR(200) NOT NULL,
        telefone VARCHAR(50) NOT NULL,
        status VARCHAR(20) DEFAULT 'pendente',
        criado_em TIMESTAMP DEFAULT now()
      );
    `);

    await client.query("COMMIT");
    console.log("DB init OK ✅");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Erro init DB:", err);
  } finally {
    client.release();
  }
}

/* ---------------------------
   Rotas
   --------------------------- */

// Listar nomes
app.get("/nomes", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, nome, valor, status FROM nomes ORDER BY id ASC"
    );
    res.json(result.rows);
  } catch (err) {
    console.error("/nomes error", err);
    res.status(500).json({ error: "Erro ao buscar nomes" });
  }
});

// Reservar nome
app.post("/reservar", async (req, res) => {
  const { nomeId } = req.body;
  if (!nomeId)
    return res.status(400).json({ success: false, error: "nomeId é obrigatório" });

  try {
    const result = await pool.query(
      "UPDATE nomes SET status = 'reservado' WHERE id = $1 AND status = 'disponivel' RETURNING id",
      [nomeId]
    );

    if (result.rowCount === 0) {
      return res.json({ success: false, error: "Nome não disponível para reserva" });
    }

    res.json({ success: true });
  } catch (err) {
    console.error("/reservar error", err);
    res.status(500).json({ success: false, error: "Erro ao reservar nome" });
  }
});

// Comprar (criar pedido + reservar)
app.post("/comprar", async (req, res) => {
  const { nomeId, usuarioNome, telefone } = req.body;
  if (!nomeId || !usuarioNome || !telefone) {
    return res
      .status(400)
      .json({ success: false, error: "nomeId, usuarioNome e telefone são obrigatórios" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const upd = await client.query(
      "UPDATE nomes SET status = 'reservado' WHERE id = $1 AND status = 'disponivel' RETURNING id",
      [nomeId]
    );

    if (upd.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.json({ success: false, error: "Nome não disponível" });
    }

    const insert = await client.query(
      `INSERT INTO pedidos (nome_id, cliente_nome, telefone, status)
       VALUES ($1, $2, $3, 'pendente') RETURNING id`,
      [nomeId, usuarioNome, telefone]
    );

    await client.query("COMMIT");
    res.json({ success: true, pedidoId: insert.rows[0].id });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("/comprar error", err);
    res.status(500).json({ success: false, error: "Erro ao criar pedido" });
  } finally {
    client.release();
  }
});

// Listar pedidos (admin)
app.get("/pedidos", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT p.id, p.nome_id, p.cliente_nome, p.telefone, p.status AS pedido_status, p.criado_em,
             n.nome AS nome, n.status AS nome_status, n.valor
      FROM pedidos p
      JOIN nomes n ON p.nome_id = n.id
      ORDER BY p.id DESC
    `);

    const rows = result.rows.map((r) => ({
      id: r.id,
      nome_id: r.nome_id,
      cliente_nome: r.cliente_nome,
      telefone: r.telefone,
      status: r.pedido_status,
      criado_em: r.criado_em,
      nome: r.nome,
      nome_status: r.nome_status,
      valor: r.valor,
    }));

    res.json(rows);
  } catch (err) {
    console.error("/pedidos error", err);
    res.status(500).json({ error: "Erro ao buscar pedidos" });
  }
});

// Confirmar pagamento
app.post("/confirmar", async (req, res) => {
  const { nomeId, pedidoId } = req.body;
  if (!nomeId)
    return res.status(400).json({ success: false, error: "nomeId é obrigatório" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const updNome = await client.query(
      "UPDATE nomes SET status = 'vendido' WHERE id = $1 AND status = 'reservado' RETURNING id",
      [nomeId]
    );

    if (updNome.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.json({ success: false, error: "Nome não estava reservado" });
    }

    if (pedidoId) {
      await client.query(
        "UPDATE pedidos SET status = 'confirmado' WHERE id = $1",
        [pedidoId]
      );
    } else {
      await client.query(
        "UPDATE pedidos SET status = 'confirmado' WHERE nome_id = $1 AND status = 'pendente'",
        [nomeId]
      );
    }

    await client.query("COMMIT");
    res.json({ success: true });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("/confirmar error", err);
    res.status(500).json({ success: false, error: "Erro ao confirmar pagamento" });
  } finally {
    client.release();
  }
});

// Cancelar reserva
app.post("/cancelar", async (req, res) => {
  const { nomeId, pedidoId } = req.body;
  if (!nomeId)
    return res.status(400).json({ success: false, error: "nomeId é obrigatório" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const updNome = await client.query(
      "UPDATE nomes SET status = 'disponivel' WHERE id = $1 AND status = 'reservado' RETURNING id",
      [nomeId]
    );

    if (updNome.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.json({ success: false, error: "Nome não estava reservado" });
    }

    if (pedidoId) {
      await client.query("UPDATE pedidos SET status = 'cancelado' WHERE id = $1", [pedidoId]);
    } else {
      await client.query(
        "UPDATE pedidos SET status = 'cancelado' WHERE nome_id = $1 AND status = 'pendente'",
        [nomeId]
      );
    }

    await client.query("COMMIT");
    res.json({ success: true });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("/cancelar error", err);
    res.status(500).json({ success: false, error: "Erro ao cancelar reserva" });
  } finally {
    client.release();
  }
});

// Health check
app.get("/", (req, res) => res.send("🎟️ Backend da Rifa rodando!"));

// Start server
initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT} 🚀`);
  });
});
