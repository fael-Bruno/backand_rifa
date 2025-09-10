// server.js
import express from "express";
import pkg from "pg";
import cors from "cors";

const { Pool } = pkg;
const app = express();
app.use(cors());
app.use(express.json());

// 🔹 Render pega a variável de ambiente DATABASE_URL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// --- Endpoints ---

// Listar todos os nomes
app.get("/nomes", async (req, res) => {
  try {
    const q = await pool.query("SELECT id, nome, preco, disponivel FROM nomes ORDER BY id");
    res.json(q.rows);
  } catch (err) {
    res.status(500).json({ error: "Erro ao buscar nomes" });
  }
});

// Registrar compra
app.post("/compras", async (req, res) => {
  const { usuario, nomesSelecionados } = req.body;
  if (!usuario || !usuario.nome || !usuario.telefone || !nomesSelecionados?.length) {
    return res.status(400).json({ error: "Dados inválidos" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const u = await client.query(
      "INSERT INTO usuarios (nome, telefone) VALUES ($1,$2) RETURNING id",
      [usuario.nome, usuario.telefone]
    );
    const userId = u.rows[0].id;

    for (const nomeId of nomesSelecionados) {
      await client.query(
        "INSERT INTO compras (usuario_id, nome_id, status) VALUES ($1,$2,'Pendente')",
        [userId, nomeId]
      );
      await client.query("UPDATE nomes SET disponivel=false WHERE id=$1", [nomeId]);
    }

    await client.query("COMMIT");
    res.json({ success: true });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: "Erro ao registrar compra" });
  } finally {
    client.release();
  }
});

// Listar compras
app.get("/compras", async (req, res) => {
  try {
    const q = await pool.query(`
      SELECT c.id, u.nome as usuario, u.telefone, n.nome as nome_rifa, n.preco, c.status
      FROM compras c
      JOIN usuarios u ON c.usuario_id=u.id
      JOIN nomes n ON c.nome_id=n.id
      ORDER BY c.id DESC
    `);
    res.json(q.rows);
  } catch (err) {
    res.status(500).json({ error: "Erro ao buscar compras" });
  }
});

// Marcar como pago
app.put("/compras/:id/pago", async (req, res) => {
  try {
    await pool.query("UPDATE compras SET status='Pago' WHERE id=$1", [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Erro ao atualizar status" });
  }
});

// Sincronizar nomes (marca como indisponíveis os que já foram comprados)
app.put("/nomes/sync", async (req, res) => {
  try {
    const q = await pool.query("SELECT DISTINCT nome_id FROM compras");
    const ids = q.rows.map(r => r.nome_id);
    if (ids.length) {
      await pool.query("UPDATE nomes SET disponivel=false WHERE id = ANY($1::int[])", [ids]);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Erro ao sincronizar" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("API rodando na porta " + PORT));
