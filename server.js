// server.js
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

// cria tabelas se necessário e altera esquema para multi-usuario
async function criarTabelas() {
  try {
    // usuarios (organizadores)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS usuarios (
        id SERIAL PRIMARY KEY,
        nome TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        senha TEXT NOT NULL,
        ativo BOOLEAN DEFAULT FALSE,
        criado_em TIMESTAMP DEFAULT NOW()
      );
    `);

    // config (agora com usuario_id nullable — se NULL é config "global/legacy")
    await pool.query(`
      CREATE TABLE IF NOT EXISTS config (
        id SERIAL PRIMARY KEY,
        usuario_id INT REFERENCES usuarios(id),
        valor_rifa NUMERIC(10,2) NOT NULL DEFAULT 10.00,
        premio NUMERIC(12,2) NOT NULL DEFAULT 5000.00
      );
    `);

    // admins (admin geral)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS admins (
        id SERIAL PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        senha TEXT NOT NULL
      );
    `);

    // nomes (cada nome pode pertencer a um usuario ou ser global se usuario_id IS NULL)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS nomes (
        id SERIAL PRIMARY KEY,
        usuario_id INT REFERENCES usuarios(id),
        nome TEXT NOT NULL,
        status TEXT,
        premiado BOOLEAN DEFAULT FALSE
      );
    `);

    // pedidos (associado ao usuario em que a venda ocorreu)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS pedidos (
        id SERIAL PRIMARY KEY,
        usuario_id INT REFERENCES usuarios(id),
        nome_id INT REFERENCES nomes(id),
        cliente_nome TEXT NOT NULL,
        telefone TEXT NOT NULL
      );
    `);

    // Garantir pelo menos uma config global (usuario_id IS NULL) para compatibilidade
    const cfg = await pool.query("SELECT COUNT(*) FROM config WHERE usuario_id IS NULL");
    if (parseInt(cfg.rows[0].count) === 0) {
      await pool.query("INSERT INTO config (usuario_id, valor_rifa, premio) VALUES (NULL, $1, $2)", [10.0, 5000.0]);
    }

    // Criar nomes globais legacy se não existirem (manter compatibilidade)
    const nomesCount = await pool.query("SELECT COUNT(*) FROM nomes WHERE usuario_id IS NULL");
    if (parseInt(nomesCount.rows[0].count) === 0) {
      const valores = Array.from({ length: 100 }, (_, i) => `('Nome ${i + 1}')`).join(",");
      await pool.query(`INSERT INTO nomes (nome) VALUES ${valores}`);
    }
  } catch (err) {
    console.error("Erro criando tabelas:", err);
  }
}
await criarTabelas();

// ---------------- HELPERS ----------------
function parseNumberInput(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === "string") {
    const s = v.replace(/\s/g, "").replace(",", ".");
    const n = parseFloat(s);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  return null;
}

// ---------------- ADMIN LOGIN (ADMIN GERAL) ----------------
app.post("/admin/login", async (req, res) => {
  const { email, senha } = req.body;
  if (!email || !senha) return res.status(400).json({ error: "Email e senha obrigatórios" });
  try {
    const r = await pool.query("SELECT * FROM admins WHERE email = $1 AND senha = $2", [email, senha]);
    if (r.rowCount === 0) return res.status(401).json({ error: "Email ou senha incorretos" });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Erro ao logar admin", details: err.message });
  }
});

// ---------------- USUARIOS (ORGANIZADORES) ----------------
// Registrar novo organizador (cria usuario + config e 100 nomes para ele)
app.post("/usuarios/registro", async (req, res) => {
  const { nome, email, senha } = req.body;
  if (!nome || !email || !senha) return res.status(400).json({ error: "Campos obrigatórios faltando" });
  try {
    const ins = await pool.query(
      "INSERT INTO usuarios (nome, email, senha) VALUES ($1,$2,$3) RETURNING id",
      [nome, email, senha]
    );
    const usuarioId = ins.rows[0].id;

    // cria config padrão para esse usuario
    await pool.query("INSERT INTO config (usuario_id, valor_rifa, premio) VALUES ($1, $2, $3)", [usuarioId, 10.0, 5000.0]);

    // cria 100 nomes para esse organizador
    const valores = Array.from({ length: 100 }, (_, i) => `($1, 'Nome ${i + 1}')`).join(",");
    // Para evitar SQL injection e limites de parâmetros, vamos inserir em loop simples
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (let i = 1; i <= 100; i++) {
        await client.query("INSERT INTO nomes (usuario_id, nome) VALUES ($1,$2)", [usuarioId, `Nome ${i}`]);
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      console.error("Erro criando nomes do usuario:", e);
    } finally {
      client.release();
    }

    res.json({ success: true, message: "Cadastro realizado. Aguarde ativação do admin." });
  } catch (err) {
    if (err.code === "23505") { // unique_violation
      res.status(400).json({ error: "Email já cadastrado" });
    } else {
      res.status(500).json({ error: "Erro ao registrar", details: err.message });
    }
  }
});

// Login de organizador (retorna usuarioId se ativo)
app.post("/usuarios/login", async (req, res) => {
  const { email, senha } = req.body;
  if (!email || !senha) return res.status(400).json({ error: "Email e senha obrigatórios" });
  try {
    const r = await pool.query("SELECT id, ativo, nome FROM usuarios WHERE email=$1 AND senha=$2", [email, senha]);
    if (r.rowCount === 0) return res.status(401).json({ error: "Credenciais inválidas" });
    if (!r.rows[0].ativo) return res.status(403).json({ error: "Conta aguardando ativação pelo admin" });
    res.json({ success: true, usuarioId: r.rows[0].id, nome: r.rows[0].nome });
  } catch (err) {
    res.status(500).json({ error: "Erro ao logar", details: err.message });
  }
});

// Listar todos usuarios (para admin geral) - sem autenticação real por simplicidade
app.get("/usuarios", async (req, res) => {
  try {
    const r = await pool.query("SELECT id, nome, email, ativo, criado_em FROM usuarios ORDER BY criado_em DESC");
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: "Erro ao buscar usuarios", details: err.message });
  }
});

// Ativar / bloquear usuario
app.post("/usuarios/ativar", async (req, res) => {
  const { usuarioId, ativo } = req.body;
  if (usuarioId === undefined) return res.status(400).json({ error: "usuarioId é obrigatório" });
  try {
    await pool.query("UPDATE usuarios SET ativo = $1 WHERE id = $2", [!!ativo, usuarioId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Erro ao atualizar usuario", details: err.message });
  }
});

// ---------------- CONFIG (por usuario) ----------------
app.get("/config", async (req, res) => {
  // pode receber ?usuarioId=123
  const usuarioId = req.query.usuarioId ? parseInt(req.query.usuarioId) : null;
  try {
    let r;
    if (usuarioId) {
      r = await pool.query("SELECT valor_rifa, premio FROM config WHERE usuario_id = $1 LIMIT 1", [usuarioId]);
    } else {
      r = await pool.query("SELECT valor_rifa, premio FROM config WHERE usuario_id IS NULL LIMIT 1");
    }
    if (r.rowCount === 0) return res.status(404).json({ error: "Configuração não encontrada" });
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
  try {
    let { valor, premio, usuarioId } = req.body;
    valor = parseNumberInput(valor);
    premio = parseNumberInput(premio);
    usuarioId = usuarioId ? parseInt(usuarioId) : null;

    if (valor === null && premio === null) {
      return res.status(400).json({ error: "Nenhum valor enviado" });
    }

    const atual = await pool.query(
      "SELECT id FROM config WHERE usuario_id IS NOT DISTINCT FROM $1 LIMIT 1",
      [usuarioId]
    );
    let id;
    if (atual.rowCount === 0) {
      const ins = await pool.query("INSERT INTO config (usuario_id, valor_rifa, premio) VALUES ($1,$2,$3) RETURNING id", [usuarioId, valor ?? 10.0, premio ?? 5000.0]);
      id = ins.rows[0].id;
    } else {
      id = atual.rows[0].id;
      await pool.query(
        `UPDATE config SET
          valor_rifa = COALESCE($1, valor_rifa),
          premio = COALESCE($2, premio)
         WHERE id = $3`,
        [valor, premio, id]
      );
    }
    res.json({ success: true });
  } catch (err) {
    console.error("Erro POST /config:", err.message);
    res.status(500).json({ error: "Erro ao atualizar configuração", details: err.message });
  }
});

// ---------------- NOMES / PEDIDOS (por usuario) ----------------
app.get("/nomes", async (req, res) => {
  // aceita ?usuarioId=123 ; se ausente traz nomes globais (usuario_id IS NULL)
  const usuarioId = req.query.usuarioId ? parseInt(req.query.usuarioId) : null;
  try {
    let r;
    if (usuarioId) {
      r = await pool.query("SELECT * FROM nomes WHERE usuario_id = $1 ORDER BY id", [usuarioId]);
    } else {
      r = await pool.query("SELECT * FROM nomes WHERE usuario_id IS NULL ORDER BY id");
    }
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: "Erro ao buscar nomes", details: err.message });
  }
});

app.post("/comprar", async (req, res) => {
  const { nomeId, usuarioNome, telefone, usuarioId } = req.body;
  if (!nomeId || !usuarioNome || !telefone) return res.status(400).json({ error: "Campos obrigatórios faltando" });
  try {
    // inserir pedido associado ao usuarioId (pode ser null para legacy)
    await pool.query("INSERT INTO pedidos (usuario_id, nome_id, cliente_nome, telefone) VALUES ($1,$2,$3,$4)", [usuarioId ?? null, nomeId, usuarioNome, telefone]);
    await pool.query("UPDATE nomes SET status = 'reservado' WHERE id = $1", [nomeId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Erro ao registrar compra", details: err.message });
  }
});

app.get("/pedidos", async (req, res) => {
  // aceita ?usuarioId=123 ; se ausente retorna todos pedidos (para admin)
  const usuarioId = req.query.usuarioId ? parseInt(req.query.usuarioId) : null;
  try {
    let r;
    if (usuarioId) {
      r = await pool.query(`
        SELECT p.id, p.cliente_nome, p.telefone, n.nome, n.id AS nome_id, n.status
        FROM pedidos p
        JOIN nomes n ON p.nome_id = n.id
        WHERE p.usuario_id = $1
        ORDER BY p.id DESC
      `, [usuarioId]);
    } else {
      r = await pool.query(`
        SELECT p.id, p.cliente_nome, p.telefone, n.nome, n.id AS nome_id, n.status, p.usuario_id
        FROM pedidos p
        JOIN nomes n ON p.nome_id = n.id
        ORDER BY p.id DESC
      `);
    }
    res.json(r.rows);
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

// ---------------- SORTEIO (por usuario) ----------------
app.get("/sorteio", async (req, res) => {
  // exige query ?usuarioId=123 (sorteio do usuario)
  const usuarioId = req.query.usuarioId ? parseInt(req.query.usuarioId) : null;
  if (!usuarioId) return res.status(400).json({ error: "usuarioId é obrigatório para sorteio" });

  try {
    const vendidos = await pool.query("SELECT COUNT(*) FROM nomes WHERE usuario_id = $1 AND status = 'vendido'", [usuarioId]);
    const total = await pool.query("SELECT COUNT(*) FROM nomes WHERE usuario_id = $1", [usuarioId]);
    if (parseInt(vendidos.rows[0].count) < parseInt(total.rows[0].count)) {
      return res.status(400).json({ error: "Ainda há nomes não vendidos" });
    }

    const r = await pool.query(`
      SELECT n.nome, p.cliente_nome, p.telefone
      FROM nomes n
      JOIN pedidos p ON p.nome_id = n.id
      WHERE n.premiado = true AND n.usuario_id = $1
      LIMIT 1
    `, [usuarioId]);

    if (r.rowCount === 0) return res.status(404).json({ error: "Nenhum nome premiado encontrado" });
    res.json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: "Erro ao buscar ganhador", details: err.message });
  }
});

// ---------------- RESETAR (por usuario) ----------------
app.post("/resetar", async (req, res) => {
  // aceita { usuarioId }
  const { usuarioId } = req.body;
  if (!usuarioId) return res.status(400).json({ error: "usuarioId é obrigatório para resetar" });
  try {
    await pool.query("DELETE FROM pedidos WHERE usuario_id = $1", [usuarioId]);
    await pool.query("UPDATE nomes SET status = NULL, premiado = FALSE WHERE usuario_id = $1", [usuarioId]);
    await pool.query(`
      UPDATE nomes SET premiado = true
      WHERE id = (SELECT id FROM nomes WHERE usuario_id = $1 ORDER BY RANDOM() LIMIT 1)
    `, [usuarioId]);
    res.json({ success: true, message: "Rifa resetada e novo premiado escolhido" });
  } catch (err) {
    res.status(500).json({ error: "Erro ao resetar rifa", details: err.message });
  }
});

// ---------------- UTILIDADES ----------------
// escolher premiado se faltar algum (para cada usuario)
async function garantirPremiado() {
  try {
    // para cada usuario com nomes, garantir ao menos 1 premiado
    const users = await pool.query("SELECT id FROM usuarios");
    for (const u of users.rows) {
      const r = await pool.query("SELECT COUNT(*) FROM nomes WHERE usuario_id = $1 AND premiado = true", [u.id]);
      if (parseInt(r.rows[0].count) === 0) {
        await pool.query(`
          UPDATE nomes SET premiado = true
          WHERE id = (SELECT id FROM nomes WHERE usuario_id = $1 ORDER BY RANDOM() LIMIT 1)
        `, [u.id]);
        console.log(`✅ Nome premiado escolhido para usuario ${u.id}`);
      }
    }

    // legacy global (usuario_id IS NULL)
    const r = await pool.query("SELECT COUNT(*) FROM nomes WHERE usuario_id IS NULL AND premiado = true");
    if (parseInt(r.rows[0].count) === 0) {
      await pool.query(`
        UPDATE nomes SET premiado = true
        WHERE id = (SELECT id FROM nomes WHERE usuario_id IS NULL ORDER BY RANDOM() LIMIT 1)
      `);
      console.log("✅ Nome premiado escolhido para rifa global");
    }
  } catch (err) {
    console.error("Erro garantirPremiado:", err.message);
  }
}

await garantirPremiado();

// start
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Servidor rodando na porta " + PORT));
