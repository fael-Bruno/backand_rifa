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

// Lista nomes (disponíveis e vendidos)
app.get("/nomes", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, nome, preco, disponivel FROM public.nomes ORDER BY id ASC"
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Erro ao buscar nomes:", err.message);
    res.status(500).json({ error: "Erro ao buscar nomes", details: err.message });
  }
});

// Registrar compra (NÃO bloqueia o nome; cria compra Pendente)
// Bloqueia múltiplas tentativas criando uma verificação: se já existe compra Pendente/Aprovado, rejeita
app.post("/comprar", async (req, res) => {
  const { nomeId, usuarioNome, telefone } = req.body;
  if (!nomeId || !usuarioNome || !telefone) {
    return res.status(400).json({ error: "Parâmetros inválidos" });
  }

  try {
    // verifica se já existe compra pendente ou aprovada para esse nome
    const check = await pool.query(
      "SELECT id, status FROM public.compras WHERE nome_id = $1 AND status IN ('Pendente','Aprovado')",
      [nomeId]
    );
    if (check.rowCount > 0) {
      return res.status(400).json({ error: "Nome já reservado ou vendido" });
    }

    // criar usuário (pode ser otimizado para reusar por telefone, se quiser)
    const userResult = await pool.query(
      "INSERT INTO public.usuarios (nome, telefone) VALUES ($1, $2) RETURNING id",
      [usuarioNome, telefone]
    );
    const usuarioId = userResult.rows[0].id;

    // registrar compra como Pendente
    const compra = await pool.query(
      "INSERT INTO public.compras (usuario_id, nome_id, status) VALUES ($1, $2, 'Pendente') RETURNING id, usuario_id, nome_id, status, criado_em",
      [usuarioId, nomeId]
    );

    res.json({ success: true, compra: compra.rows[0] });
  } catch (err) {
    console.error("Erro ao registrar compra:", err.message);
    res.status(500).json({ error: "Erro ao registrar compra", details: err.message });
  }
});

// Listar compras (para admin) — retorna campos usados no admin.html
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
    console.error("Erro ao buscar compras:", err.message);
    res.status(500).json({ error: "Erro ao buscar compras", details: err.message });
  }
});

// Confirmar pagamento: muda status para Aprovado e bloqueia o nome (em transação)
app.post("/confirmar", async (req, res) => {
  const { compraId } = req.body;
  if (!compraId) return res.status(400).json({ error: "compraId é obrigatório" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // checa compra
    const compRes = await client.query("SELECT id, nome_id, status FROM public.compras WHERE id = $1 FOR UPDATE", [compraId]);
    if (compRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Compra não encontrada" });
    }

    const compra = compRes.rows[0];
    if (compra.status !== "Pendente") {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Somente compras pendentes podem ser confirmadas" });
    }

    // atualizar status
    await client.query("UPDATE public.compras SET status = 'Aprovado' WHERE id = $1", [compraId]);

    // marcar nome como indisponível
    await client.query("UPDATE public.nomes SET disponivel = false WHERE id = $1", [compra.nome_id]);

    await client.query("COMMIT");
    res.json({ success: true, message: "Pagamento confirmado e nome bloqueado" });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Erro ao confirmar pagamento:", err.message);
    res.status(500).json({ error: "Erro ao confirmar pagamento", details: err.message });
  } finally {
    client.release();
  }
});

// status + raiz
app.get("/status", (req, res) => res.json({ status: "API online 🚀" }));
app.get("/", (req, res) => res.send("🎉 Backend da Rifa está rodando!"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor API rodando na porta ${PORT}`));
