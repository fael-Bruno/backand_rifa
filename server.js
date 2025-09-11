import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import pg from "pg";
import bcrypt from "bcrypt";

const app = express();
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

app.use(cors());
app.use(bodyParser.json());

/* ==========================
   CRIAÇÃO DE TABELAS (SE NÃO EXISTIREM)
========================== */
async function criarTabelas() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS nomes (
      id SERIAL PRIMARY KEY,
      nome VARCHAR(100) NOT NULL,
      status VARCHAR(20),
      premiado BOOLEAN DEFAULT false
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS pedidos (
      id SERIAL PRIMARY KEY,
      cliente_nome VARCHAR(100) NOT NULL,
      telefone VARCHAR(20) NOT NULL,
      nome_id INT REFERENCES nomes(id),
      nome VARCHAR(100),
      status VARCHAR(20) DEFAULT 'pendente'
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS admins (
      id SERIAL PRIMARY KEY,
      email VARCHAR(100) UNIQUE NOT NULL,
      senha VARCHAR(255) NOT NULL
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS config (
      id SERIAL PRIMARY KEY,
      valor_rifa NUMERIC(10,2) NOT NULL
    )
  `);

  // garantir que existe pelo menos um valor_rifa
  const conf = await pool.query("SELECT COUNT(*) FROM config");
  if (parseInt(conf.rows[0].count) === 0) {
    await pool.query("INSERT INTO config (valor_rifa) VALUES (10.00)");
  }
}
criarTabelas();

/* ==========================
   LOGIN ADMIN
========================== */
app.post("/admin/cadastrar", async (req, res) => {
  const { email, senha } = req.body;
  if (!email || !senha) return res.status(400).json({ error: "Campos obrigatórios" });

  const hash = await bcrypt.hash(senha, 10);
  try {
    await pool.query("INSERT INTO admins (email, senha) VALUES ($1,$2)", [email, hash]);
    res.json({ sucesso: true });
  } catch {
    res.status(400).json({ error: "Email já cadastrado" });
  }
});

app.post("/admin/login", async (req, res) => {
  const { email, senha } = req.body;
  if (!email || !senha) return res.status(400).json({ error: "Campos obrigatórios" });

  try {
    const result = await pool.query("SELECT * FROM admins WHERE email = $1", [email]);
    if (result.rowCount === 0) return res.status(401).json({ error: "Credenciais inválidas" });

    const valido = await bcrypt.compare(senha, result.rows[0].senha);
    if (!valido) return res.status(401).json({ error: "Credenciais inválidas" });

    res.json({ sucesso: true });
  } catch {
    res.status(500).json({ error: "Erro no login" });
  }
});

/* ==========================
   CRUD DE NOMES
========================== */
app.get("/nomes", async (req, res) => {
  try {
    const result = await pool.query("SELECT id, nome, status FROM nomes ORDER BY id");
    res.json(result.rows);
  } catch {
    res.status(500).json({ error: "Erro ao buscar nomes" });
  }
});

app.post("/reservar", async (req, res) => {
  const { nomeId } = req.body;
  if (!nomeId) return res.status(400).json({ error: "nomeId obrigatório" });
  try {
    await pool.query("UPDATE nomes SET status = 'reservado' WHERE id = $1", [nomeId]);
    res.json({ sucesso: true });
  } catch {
    res.status(500).json({ error: "Erro ao reservar nome" });
  }
});

app.post("/comprar", async (req, res) => {
  const { nomeId, cliente_nome, telefone } = req.body;
  if (!nomeId || !cliente_nome || !telefone)
    return res.status(400).json({ error: "Campos obrigatórios" });

  try {
    const nome = await pool.query("SELECT nome FROM nomes WHERE id = $1", [nomeId]);
    if (nome.rowCount === 0) return res.status(404).json({ error: "Nome não encontrado" });

    await pool.query(
      "INSERT INTO pedidos (cliente_nome, telefone, nome_id, nome) VALUES ($1,$2,$3,$4)",
      [cliente_nome, telefone, nomeId, nome.rows[0].nome]
    );

    res.json({ sucesso: true });
  } catch {
    res.status(500).json({ error: "Erro ao registrar pedido" });
  }
});

/* ==========================
   ADMIN: GERENCIAR PEDIDOS
========================== */
app.get("/pedidos", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM pedidos ORDER BY id DESC");
    res.json(result.rows);
  } catch {
    res.status(500).json({ error: "Erro ao buscar pedidos" });
  }
});

app.post("/confirmar", async (req, res) => {
  const { nomeId } = req.body;
  if (!nomeId) return res.status(400).json({ error: "nomeId obrigatório" });

  try {
    await pool.query("UPDATE nomes SET status = 'vendido' WHERE id = $1", [nomeId]);
    await pool.query("UPDATE pedidos SET status = 'pago' WHERE nome_id = $1", [nomeId]);
    res.json({ sucesso: true });
  } catch {
    res.status(500).json({ error: "Erro ao confirmar pedido" });
  }
});

app.post("/cancelar", async (req, res) => {
  const { nomeId } = req.body;
  if (!nomeId) return res.status(400).json({ error: "nomeId obrigatório" });

  try {
    await pool.query("UPDATE nomes SET status = NULL WHERE id = $1", [nomeId]);
    await pool.query("DELETE FROM pedidos WHERE nome_id = $1", [nomeId]);
    res.json({ sucesso: true });
  } catch {
    res.status(500).json({ error: "Erro ao cancelar pedido" });
  }
});

/* ==========================
   RESET DA RIFA
========================== */
app.post("/resetar", async (req, res) => {
  try {
    await pool.query("DELETE FROM pedidos");
    await pool.query("UPDATE nomes SET status = NULL, premiado = false");
    // Escolher novo premiado aleatório
    await pool.query(`
      UPDATE nomes SET premiado = true
      WHERE id = (SELECT id FROM nomes ORDER BY RANDOM() LIMIT 1)
    `);
    res.json({ sucesso: true });
  } catch {
    res.status(500).json({ error: "Erro ao resetar rifa" });
  }
});

/* ==========================
   SORTEIO DO GANHADOR
========================== */
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

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Não há nome premiado definido" });
    }

    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: "Erro ao buscar ganhador" });
  }
});

/* ==========================
   CONFIG: VALOR DA RIFA
========================== */
app.get("/config", async (req, res) => {
  try {
    const result = await pool.query("SELECT valor_rifa FROM config LIMIT 1");
    res.json(result.rows[0]);
  } catch {
    res.status(500).json({ error: "Erro ao buscar valor da rifa" });
  }
});

app.post("/config", async (req, res) => {
  const { valor } = req.body;
  if (!valor || isNaN(valor)) {
    return res.status(400).json({ error: "Valor inválido" });
  }
  try {
    await pool.query("UPDATE config SET valor_rifa = $1 WHERE id = 1", [valor]);
    res.json({ sucesso: true });
  } catch {
    res.status(500).json({ error: "Erro ao atualizar valor da rifa" });
  }
});

/* ========================== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Servidor rodando na porta " + PORT));
