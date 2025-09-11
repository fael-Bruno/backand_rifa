import express from "express";
import cors from "cors";
import pkg from "pg";
import dotenv from "dotenv";

dotenv.config();
const { Pool } = pkg;

// Cria servidor
const app = express();
app.use(cors());
app.use(express.json());

// Conexão com banco
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});


// ---------------- ADMINS ----------------
// Cadastro de admin
app.post("/admin/cadastrar", async (req, res) => {
  const { email, senha } = req.body;
  if (!email || !senha) {
    return res.status(400).json({ error: "Email e senha são obrigatórios" });
  }

  try {
    const result = await pool.query(
      "INSERT INTO public.admins (email, senha) VALUES ($1, $2) RETURNING id, email",
      [email, senha]
    );
    res.json({ success: true, admin: result.rows[0] });
  } catch (err) {
    console.error("Erro ao cadastrar:", err.message);
    res.status(500).json({ error: "Erro ao cadastrar", details: err.message });
  }
});

// Login de admin
app.post("/admin/login", async (req, res) => {
  const { email, senha } = req.body;
  if (!email || !senha) {
    return res.status(400).json({ error: "Email e senha são obrigatórios" });
  }

  try {
    const result = await pool.query(
      "SELECT * FROM public.admins WHERE email = $1 AND senha = $2",
      [email, senha]
    );

    if (result.rowCount === 0) {
      return res.status(401).json({ error: "Email ou senha incorretos" });
    }

    res.json({ success: true, message: "Login bem-sucedido" });
  } catch (err) {
    console.error("Erro ao logar:", err.message);
    res.status(500).json({ error: "Erro ao logar", details: err.message });
  }
});


// ---------------- NOMES ----------------
app.get("/nomes", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, nome, preco, disponivel FROM public.nomes ORDER BY id ASC"
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: "Erro ao buscar nomes", details: err.message });
  }
});


// ---------------- COMPRAR ----------------
app.post("/comprar", async (req, res) => {
  const { nomeId, usuarioNome, telefone } = req.body;
  if (!nomeId || !usuarioNome || !telefone) {
    return res.status(400).json({ error: "Parâmetros inválidos" });
  }

  try {
    const check = await pool.query(
      "SELECT id FROM public.compras WHERE nome_id = $1 AND status IN ('Pendente','Aprovado')",
      [nomeId]
    );
    if (check.rowCount > 0) {
      return res.status(400).json({ error: "Nome já reservado ou vendido" });
    }

    const user = await pool.query(
      "INSERT INTO public.usuarios (nome, telefone) VALUES ($1,$2) RETURNING id",
      [usuarioNome, telefone]
    );

    const compra = await pool.query(
      "INSERT INTO public.compras (usuario_id, nome_id, status) VALUES ($1,$2,'Pendente') RETURNING *",
      [user.rows[0].id, nomeId]
    );

    res.json({ success: true, compra: compra.rows[0] });
  } catch (err) {
    res.status(500).json({ error: "Erro ao comprar", details: err.message });
  }
});


// ---------------- LISTAR COMPRAS ----------------
app.get("/compras", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        c.id,
        u.nome AS usuario_nome,
        u.telefone,
        n.nome AS nome,
        c.status,
        c.criado_em
      FROM public.compras c
      JOIN public.usuarios u ON c.usuario_id = u.id
      JOIN public.nomes n ON c.nome_id = n.id
      ORDER BY c.criado_em DESC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: "Erro ao buscar compras", details: err.message });
  }
});


// ---------------- CONFIRMAR PAGAMENTO ----------------
app.post("/confirmar", async (req, res) => {
  const { compraId } = req.body;
  if (!compraId) return res.status(400).json({ error: "compraId obrigatório" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const compra = await client.query(
      "SELECT * FROM public.compras WHERE id = $1 FOR UPDATE",
      [compraId]
    );
    if (compra.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Compra não encontrada" });
    }
    if (compra.rows[0].status !== "Pendente") {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Compra já processada" });
    }

    await client.query("UPDATE public.compras SET status = 'Aprovado' WHERE id = $1", [compraId]);
    await client.query("UPDATE public.nomes SET disponivel = false WHERE id = $1", [compra.rows[0].nome_id]);

    await client.query("COMMIT");
    res.json({ success: true });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: "Erro ao confirmar", details: err.message });
  } finally {
    client.release();
  }
});


// ---------------- STATUS ----------------
app.get("/status", (req, res) => res.json({ status: "API online 🚀" }));
app.get("/", (req, res) => res.send("🎉 Backend da Rifa rodando!"));

// Start
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 API rodando na porta ${PORT}`));
