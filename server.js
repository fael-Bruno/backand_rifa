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
    const result = await pool.query("SELECT * FROM nomes ORDER BY id ASC");
    res.json(result.rows);
  } catch (err) {
    console.error("Erro ao buscar nomes:", err);
    res.status(500).json({ error: "Erro ao buscar nomes" });
  }
});

// ✅ Rota para registrar compra
app.post("/comprar", async (req, res) => {
  const { nomeId, usuarioNome, telefone } = req.body;

  try {
    // Cria usuário (se não existir)
    const userResult = await pool.query(
      "INSERT INTO usuarios (nome, telefone) VALUES ($1, $2) RETURNING id",
      [usuarioNome, telefone]
    );
    const usuarioId = userResult.rows[0].id;

    // Marca nome como indisponível
    await pool.query("UPDATE nomes SET disponivel = false WHERE id = $1", [nomeId]);

    // Registra compra
    const compra = await pool.query(
      "INSERT INTO compras (usuario_id, nome_id, status) VALUES ($1, $2, 'Pendente') RETURNING *",
      [usuarioId, nomeId]
    );

    res.json(compra.rows[0]);
  } catch (err) {
    console.error("Erro ao registrar compra:", err);
    res.status(500).json({ error: "Erro ao registrar compra" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
