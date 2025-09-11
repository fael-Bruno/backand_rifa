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
// Cria compra pendente (NÃO bloqueia nome ainda)
app.post("/comprar", async (req, res) => {
  const { nomeId, usuarioNome, telefone } = req.body;
  if (!nomeId || !usuarioNome || !telefone) {
    return res.status(400).json({ error: "Parâmetros inválidos" });
  }

  try {
    // nome só é bloqueado se já foi aprovado antes
    const check = await pool.query(
      "SELECT id FROM public.compras WHERE nome_id = $1 AND status = 'Aprovado'",
      [nomeId]
    );
    if (check.rowCount > 0) {
      return res.status(400).json({ error: "Nome já vendido" });
    }

    // cria usuário
    const user = await pool.query(
      "INSERT INTO public.usuarios (nome, telefone) VALUES ($1,$2) RETURNING id",
      [usuarioNome, telefone]
    );

    // cria compra pendente
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

    // muda status da compra
    await client.query("UPDATE public.compras SET status = 'Aprovado' WHERE id = $1", [compraId]);

    // só agora marca como vendido
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

// ---------------- ADMINS ----------------
app.post("/admin/cadastrar", async (req, res) => {
  const { email, senha } = req.body;
  if (!email || !senha) {
    return res.status(400).json({ error: "Email e senha são obrigatórios" });
  }

  try {
    const result = await pool.query(
      "INSERT INTO public.admins (email, senha) VALUES ($1,$2) RETURNING id, email",
      [email, senha]
    );
    res.json({ success: true, admin: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: "Erro ao cadastrar", details: err.message });
  }
});

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

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Erro ao logar", details: err.message });
  }
});

// ---------------- STATUS ----------------
app.get("/status", (req, res) => res.json({ status: "API online 🚀" }));
app.get("/", (req, res) => res.send("🎉 Backend da Rifa rodando!"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 API rodando na porta ${PORT}`));
