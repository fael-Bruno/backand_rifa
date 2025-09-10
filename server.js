import express from "express";
import cors from "cors";
import pkg from "pg";
import dotenv from "dotenv";

dotenv.config();
const { Pool } = pkg;

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ✅ Rota para listar os nomes
app.get("/nomes", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM public.nomes ORDER BY id ASC");
    res.json(result.rows);
  } catch (err) {
    console.error("❌ Erro ao buscar nomes:", err.message);
    res.status(500).json({ error: "Erro ao buscar nomes", details: err.message });
  }
});

// ✅ Rota para registrar compra
app.post("/comprar", async (req, res) => {
  const { nomeId, usuarioNome, telefone } = req.body;

  try {
    // Criar usuário
    const userResult = await pool.query(
      "INSERT INTO public.usuarios (nome, telefone) VALUES ($1, $2) RETURNING id",
      [usuarioNome, telefone]
    );
    const usuarioId = userResult.rows[0].id;

    // Marcar nome como indisponível
    await pool.query("UPDATE public.nomes SET disponivel = false WHERE id = $1", [nomeId]);

    // Registrar compra
    const compra = await pool.query(
      "INSERT INTO public.compras (usuario_id, nome_id, status) VALUES ($1, $2, 'Pendente') RETURNING *",
      [usuarioId, nomeId]
    );

    res.json(compra.rows[0]);
  } catch (err) {
    console.error("❌ Erro ao registrar compra:", err.message);
    res.status(500).json({ error: "Erro ao registrar compra", details: err.message });
  }
});

// ✅ Rota para listar compras (para admin.html)
app.get("/compras", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT c.id, u.nome AS usuario, u.telefone, n.nome AS nome_rifa, c.status, c.criado_em
      FROM public.compras c
      JOIN public.usuarios u ON c.usuario_id = u.id
      JOIN public.nomes n ON c.nome_id = n.id
      ORDER BY c.criado_em DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error("❌ Erro ao buscar compras:", err.message);
    res.status(500).json({ error: "Erro ao buscar compras", details: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});
