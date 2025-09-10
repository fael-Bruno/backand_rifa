// server.js
import express from "express";
import pkg from "pg";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();
const { Pool } = pkg;

const app = express();
app.use(cors());
app.use(express.json());

// Conexão PostgreSQL (use DATABASE_URL nas variáveis de ambiente do Render)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production"
    ? { rejectUnauthorized: false }
    : false
});

// --- Endpoints ---

// GET /nomes -> lista nomes (id, nome, preco, disponivel)
app.get("/nomes", async (req, res) => {
  try {
    const q = await pool.query("SELECT id, nome, preco, disponivel FROM nomes ORDER BY id");
    res.json(q.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao buscar nomes" });
  }
});

// POST /compras -> registra compra (body: { usuario: {nome,telefone}, nomesSelecionados: [id,...] })
app.post("/compras", async (req, res) => {
  const { usuario, nomesSelecionados } = req.body;
  if (!usuario || !usuario.nome || !usuario.telefone || !Array.isArray(nomesSelecionados) || !nomesSelecionados.length) {
    return res.status(400).json({ error: "Payload inválido" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // cria usuário
    const u = await client.query(
      "INSERT INTO usuarios (nome, telefone) VALUES ($1,$2) RETURNING id, nome, telefone",
      [usuario.nome, usuario.telefone]
    );
    const userId = u.rows[0].id;

    // para cada nome selecionado, cria compra e marca nome indisponível
    const comprasInseridas = [];
    for (const nomeId of nomesSelecionados) {
      const r = await client.query(
        "INSERT INTO compras (usuario_id, nome_id, status) VALUES ($1,$2,'Pendente') RETURNING id",
        [userId, nomeId]
      );
      comprasInseridas.push(r.rows[0].id);
      await client.query("UPDATE nomes SET disponivel=false WHERE id=$1", [nomeId]);
    }

    await client.query("COMMIT");
    res.json({ success: true, comprasInseridas });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "Erro ao registrar compra" });
  } finally {
    client.release();
  }
});

// GET /compras -> lista compras com info usuario e nome
app.get("/compras", async (req, res) => {
  try {
    const q = await pool.query(`
      SELECT c.id, u.nome as usuario, u.telefone, n.id as nome_id, n.nome as nome_rifa, n.preco, c.status, c.criado_em
      FROM compras c
      JOIN usuarios u ON c.usuario_id = u.id
      JOIN nomes n ON c.nome_id = n.id
      ORDER BY c.id DESC
    `);
    res.json(q.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao buscar compras" });
  }
});

// PUT /compras/:id/pago -> marca compra como Pago
app.put("/compras/:id/pago", async (req, res) => {
  const id = req.params.id;
  try {
    await pool.query("UPDATE compras SET status='Pago' WHERE id=$1", [id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao atualizar status" });
  }
});

// PUT /nomes/sync -> (opcional) - força sincronizar nomes com compras: marca como indisponível todos nomes que já tem compra registrada
app.put("/nomes/sync", async (req, res) => {
  try {
    // pega lista de nome_id que estão em compras
    const q = await pool.query("SELECT DISTINCT nome_id FROM compras");
    const ids = q.rows.map(r => r.nome_id);
    if (ids.length) {
      const sql = `UPDATE nomes SET disponivel=false WHERE id = ANY($1::int[])`;
      await pool.query(sql, [ids]);
    }
    res.json({ success: true, idsAtualizados: ids });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao sincronizar nomes" });
  }
});

// servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`API rodando na porta ${PORT}`);
});
