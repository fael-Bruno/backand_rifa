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
  ssl: process.env.DATABASE_URL?.includes("render.com")
    ? { rejectUnauthorized: false }
    : false
});

// ---------------- CRIAR TABELAS ----------------
async function criarTabelas() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS config (
      id SERIAL PRIMARY KEY,
      valor_rifa NUMERIC(10,2) NOT NULL DEFAULT 10.00,
      premio NUMERIC(12,2) NOT NULL DEFAULT 5000.00
    )
  `);
  const cfg = await pool.query("SELECT COUNT(*) FROM config");
  if (parseInt(cfg.rows[0].count) === 0) {
    await pool.query("INSERT INTO config (valor_rifa, premio) VALUES ($1,$2)", [10.0, 5000.0]);
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS admins (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      senha TEXT NOT NULL
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS nomes (
      id SERIAL PRIMARY KEY,
      nome TEXT NOT NULL,
      status TEXT,
      premiado BOOLEAN DEFAULT FALSE
    )
  `);
  const nomes = await pool.query("SELECT COUNT(*) FROM nomes");
  if (parseInt(nomes.rows[0].count) === 0) {
    const values = Array.from({ length: 100 }, (_, i) => `('Nome ${i + 1}')`).join(",");
    await pool.query(`INSERT INTO nomes (nome) VALUES ${values}`);
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS pedidos (
      id SERIAL PRIMARY KEY,
      nome_id INT REFERENCES nomes(id),
      cliente_nome TEXT NOT NULL,
      telefone TEXT NOT NULL
    )
  `);
}
await criarTabelas();

// ---------------- GARANTIR PREMIADO ----------------
async function garantirPremiado() {
  const r = await pool.query("SELECT COUNT(*) FROM nomes WHERE premiado = true");
  if (parseInt(r.rows[0].count) === 0) {
    await pool.query(`
      UPDATE nomes SET premiado = true
      WHERE id = (SELECT id FROM nomes ORDER BY RANDOM() LIMIT 1)
    `);
    console.log("✅ Nome premiado escolhido aleatoriamente");
  }
}

// ---------------- LOGIN ADMIN ----------------
app.post("/admin/login", async (req, res) => {
  const { email, senha } = req.body;
  try {
    const r = await pool.query("SELECT * FROM admins WHERE email=$1 AND senha=$2", [email, senha]);
    if (r.rowCount === 0) return res.status(401).json({ error: "Credenciais inválidas" });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Erro ao logar", details: err.message });
  }
});

// ---------------- CONFIG ----------------
app.get("/config", async (req, res) => {
  try {
    const r = await pool.query("SELECT valor_rifa, premio FROM config LIMIT 1");
    if (r.rowCount === 0) return res.status(404).json({ error: "Config não encontrada" });

    const cfg = r.rows[0];
    res.json({
      valor_rifa: parseFloat(cfg.valor_rifa) || 0,
      premio: parseFloat(cfg.premio) || 0
    });
  } catch (err) {
    res.status(500).json({ error: "Erro ao buscar configuração", details: err.message });
  }
});

app.post("/config", async (req, res) => {
  let { valor, premio } = req.body;

  valor = valor !== undefined && valor !== null && valor !== "" && !isNaN(valor) ? Number(valor) : null;
  premio = premio !== undefined && premio !== null && premio !== "" && !isNaN(premio) ? Number(premio) : null;

  if (valor === null && premio === null)
    return res.status(400).json({ error: "Nenhum valor enviado" });

  try {
    const atual = await pool.query("SELECT id FROM config LIMIT 1");
    if (atual.rowCount === 0) {
      await pool.query(
        "INSERT INTO config (valor_rifa, premio) VALUES ($1,$2)",
        [valor ?? 10.0, premio ?? 5000.0]
      );
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

// ---------------- NOMES / PEDIDOS ----------------
app.get("/nomes", async (req, res) => {
  try {
    const r = await pool.query("SELECT * FROM nomes ORDER BY id");
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: "Erro ao buscar nomes", details: err.message });
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
    const r = await pool.query(`
      SELECT p.id, p.cliente_nome, p.telefone, n.nome, n.id AS nome_id, n.status
      FROM pedidos p
      JOIN nomes n ON p.nome_id = n.id
      ORDER BY p.id DESC
    `);
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: "Erro ao buscar pedidos", details: err.message });
  }
});

app.post("/confirmar", async (req, res) => {
  try {
    await pool.query("UPDATE nomes SET status='vendido' WHERE id=$1", [req.body.nomeId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Erro ao confirmar", details: err.message });
  }
});

app.post("/cancelar", async (req, res) => {
  try {
    await pool.query("DELETE FROM pedidos WHERE nome_id=$1", [req.body.nomeId]);
    await pool.query("UPDATE nomes SET status=NULL WHERE id=$1", [req.body.nomeId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Erro ao cancelar", details: err.message });
  }
});

// ---------------- SORTEIO ----------------
app.get("/sorteio", async (req, res) => {
  try {
    const vendidos = await pool.query("SELECT COUNT(*) FROM nomes WHERE status = 'vendido'");
    const total = await pool.query("SELECT COUNT(*) FROM nomes");
    if (parseInt(vendidos.rows[0].count) < parseInt(total.rows[0].count)) {
      return res.status(400).json({ error: "Ainda há nomes não vendidos" });
    }

    const r = await pool.query(`
      SELECT n.nome, p.cliente_nome, p.telefone
      FROM nomes n
      JOIN pedidos p ON p.nome_id = n.id
      WHERE n.premiado = true
      LIMIT 1
    `);

    if (r.rowCount === 0)
      return res.status(404).json({ error: "Nenhum nome premiado encontrado" });

    res.json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: "Erro ao buscar ganhador", details: err.message });
  }
});

// ---------------- START ----------------
await garantirPremiado();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Servidor rodando na porta " + PORT));
