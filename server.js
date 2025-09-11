import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import pkg from "pg";

dotenv.config();
const { Pool } = pkg;

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Cria tabela config automaticamente, se não existir
async function criarTabelaConfigSeNecessario() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS config (
        id SERIAL PRIMARY KEY,
        valor_rifa NUMERIC(10,2) NOT NULL DEFAULT 10.00,
        premio NUMERIC(12,2) NOT NULL DEFAULT 5000.00
      )
    `);
    const r = await pool.query("SELECT COUNT(*) FROM config");
    if (parseInt(r.rows[0].count) === 0) {
      await pool.query("INSERT INTO config (valor_rifa, premio) VALUES ($1,$2)", [10.0, 5000.0]);
    }
  } catch (err) {
    console.error("Erro ao criar tabela config:", err.message);
  }
}
criarTabelaConfigSeNecessario();

// ---------------------- ADMIN ----------------------

app.post("/admin/cadastrar", async (req, res) => {
  const { email, senha } = req.body;
  if (!email || !senha) return res.status(400).json({ error: "Email e senha são obrigatórios" });

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

app.post("/admin/login", async (req, res) => {
  const { email, senha } = req.body;
  if (!email || !senha) return res.status(400).json({ error: "Email e senha obrigatórios" });

  try {
    const result = await pool.query(
      "SELECT * FROM admins WHERE email = $1 AND senha = $2",
      [email, senha]
    );
    if (result.rowCount === 0) return res.status(401).json({ error: "Email ou senha incorretos" });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Erro ao logar admin", details: err.message });
  }
});

// ---------------------- RIFA ----------------------

app.get("/nomes", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM nomes ORDER BY id ASC");
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: "Erro ao buscar nomes", details: err.message });
  }
});

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

app.post("/comprar", async (req, res) => {
  const { nomeId, usuarioNome, telefone } = req.body;
  if (!nomeId || !usuarioNome || !telefone)
    return res.status(400).json({ error: "Campos obrigatórios faltando" });

  try {
    await pool.query(
      "INSERT INTO pedidos (nome_id, cliente_nome, telefone) VALUES ($1,$2,$3)",
      [nomeId, usuarioNome, telefone]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Erro ao registrar compra", details: err.message });
  }
});

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

// ---------------------- SORTEIO ----------------------

async function garantirPremiado() {
  try {
    const jaTem = await pool.query("SELECT COUNT(*) FROM nomes WHERE premiado = true");
    if (parseInt(jaTem.rows[0].count) === 0) {
      await pool.query(`
        UPDATE nomes SET premiado = true 
        WHERE id = (SELECT id FROM nomes ORDER BY RANDOM() LIMIT 1)
      `);
      console.log("✅ Nome premiado escolhido aleatoriamente!");
    }
  } catch (err) {
    console.error("Erro em garantirPremiado:", err.message);
  }
}

app.get("/sorteio", async (req, res) => {
  try {
    const vendidos = await pool.query("SELECT COUNT(*) FROM nomes WHERE status = 'vendido'");
    const total = await pool.query("SELECT COUNT(*) FROM nomes");
    if (parseInt(vendidos.rows[0].count) < parseInt(total.rows[0].count)) {
      return res.status(400).json({ error: "Ainda há nomes não vendidos" });
    }

    const result = await pool.query(`
      SELECT n.nome, p.cliente_nome, p.telefone
      FROM nomes n
      JOIN pedidos p ON p.nome_id = n.id
      WHERE n.premiado = true
      LIMIT 1
    `);

    if (result.rowCount === 0)
      return res.status(404).json({ error: "Nenhum nome premiado encontrado" });

    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: "Erro ao buscar ganhador", details: err.message });
  }
});

// ---------------------- CONFIG ----------------------

app.get("/config", async (req, res) => {
  try {
    const result = await pool.query("SELECT id, valor_rifa, premio FROM config LIMIT 1");
    if (result.rowCount === 0) return res.status(404).json({ error: "Configuração não encontrada" });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: "Erro ao buscar configuração", details: err.message });
  }
});

app.post("/config", async (req, res) => {
  const { valor, premio } = req.body;
  if (valor === undefined && premio === undefined) return res.status(400).json({ error: "Nenhum valor enviado" });
  try {
    const atual = await pool.query("SELECT id FROM config LIMIT 1");
    if (atual.rowCount === 0) {
      await pool.query("INSERT INTO config (valor_rifa, premio) VALUES ($1,$2)", [valor ?? 10.0, premio ?? 5000.0]);
    } else {
      await pool.query(
        `UPDATE config SET
          valor_rifa = COALESCE($1, valor_rifa),
          premio = COALESCE($2, premio)
         WHERE id = $3`,
        [valor, premio, atual.rows[0].id]
      );
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Erro ao atualizar configuração", details: err.message });
  }
});

// ---------------------- RESET ----------------------

app.post("/resetar", async (req, res) => {
  try {
    await pool.query("DELETE FROM pedidos");
    await pool.query("UPDATE nomes SET status = NULL, premiado = FALSE");
    await pool.query(`
      UPDATE nomes SET premiado = true
      WHERE id = (SELECT id FROM nomes ORDER BY RANDOM() LIMIT 1)
    `);
    res.json({ success: true, message: "Rifa resetada e novo premiado escolhido" });
  } catch (err) {
    res.status(500).json({ error: "Erro ao resetar rifa", details: err.message });
  }
});

garantirPremiado();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Servidor rodando na porta " + PORT));
