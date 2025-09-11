// server.js
// Node.js + Express backend para Rifa de Nomes
// Requisitos: NODE >= 14, npm install express pg cors dotenv
//
// Uso:
// 1) Crie um arquivo .env com: DATABASE_URL="postgres://user:pass@host:port/dbname"
// 2) npm install express pg cors dotenv
// 3) node server.js
//
// Observação: se for rodar no Render/Heroku, DATABASE_URL normalmente já vem no ambiente.

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // ssl may be necessary depending on host; uncomment if needed:
  // ssl: { rejectUnauthorized: false }
});

const PORT = process.env.PORT || 3000;

/* ---------------------------
   Inicialização do banco (opcional)
   — Cria colunas/tabelas se não existirem.
   --------------------------- */
async function initDb() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // garante coluna valor
    await client.query(`
      ALTER TABLE nomes
      ADD COLUMN IF NOT EXISTS valor DECIMAL(10,2) DEFAULT 10.00;
    `);

    // garante coluna status
    await client.query(`
      ALTER TABLE nomes
      ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'disponivel';
    `);

    // tabela pedidos
    await client.query(`
      CREATE TABLE IF NOT EXISTS pedidos (
        id SERIAL PRIMARY KEY,
        nome_id INT REFERENCES nomes(id),
        cliente_nome VARCHAR(200) NOT NULL,
        telefone VARCHAR(50) NOT NULL,
        status VARCHAR(20) DEFAULT 'pendente',
        criado_em TIMESTAMP DEFAULT now()
      );
    `);

    await client.query('COMMIT');
    console.log('DB init OK');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Erro init DB:', err);
  } finally {
    client.release();
  }
}

/* ---------------------------
   Rotas
   --------------------------- */

// listar nomes (id, nome, valor, status)
app.get('/nomes', async (req, res) => {
  try {
    const q = 'SELECT id, nome, valor, status FROM nomes ORDER BY id ASC';
    const result = await pool.query(q);
    res.json(result.rows);
  } catch (err) {
    console.error('/nomes error', err);
    res.status(500).json({ error: 'Erro ao buscar nomes' });
  }
});

/*
 Reservar nome:
 - Apenas muda status de 'disponivel' -> 'reservado'
 - Retorna success: true quando efetivado
 - Se já reservado/vendido, retorna success: false e mensagem
*/
app.post('/reservar', async (req, res) => {
  const { nomeId } = req.body;
  if (!nomeId) return res.status(400).json({ success: false, error: 'nomeId é obrigatório' });

  try {
    const result = await pool.query(
      "UPDATE nomes SET status = 'reservado' WHERE id = $1 AND status = 'disponivel' RETURNING id",
      [nomeId]
    );

    if (result.rowCount === 0) {
      return res.json({ success: false, error: 'Nome não disponível para reserva' });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('/reservar error', err);
    res.status(500).json({ success: false, error: 'Erro ao reservar nome' });
  }
});

/*
 Comprar (criar pedido)
 - Faz duas ações em transação:
   1) tenta reservar o nome (disponivel -> reservado)
   2) insere um pedido em pedidos (status = 'pendente')
 - Se não conseguir reservar, rollback e retorna erro
*/
app.post('/comprar', async (req, res) => {
  const { nomeId, usuarioNome, telefone } = req.body;
  if (!nomeId || !usuarioNome || !telefone) {
    return res.status(400).json({ success: false, error: 'nomeId, usuarioNome e telefone são obrigatórios' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1) reservar o nome (só se estiver disponivel)
    const upd = await client.query(
      "UPDATE nomes SET status = 'reservado' WHERE id = $1 AND status = 'disponivel' RETURNING id",
      [nomeId]
    );

    if (upd.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.json({ success: false, error: 'Nome não disponível' });
    }

    // 2) inserir pedido
    const insert = await client.query(
      `INSERT INTO pedidos (nome_id, cliente_nome, telefone, status)
       VALUES ($1, $2, $3, 'pendente') RETURNING id`,
      [nomeId, usuarioNome, telefone]
    );

    await client.query('COMMIT');
    res.json({ success: true, pedidoId: insert.rows[0].id });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('/comprar error', err);
    res.status(500).json({ success: false, error: 'Erro ao criar pedido' });
  } finally {
    client.release();
  }
});

/*
 Listar pedidos (para admin)
 Mostra dados do pedido + nome do item
*/
app.get('/pedidos', async (req, res) => {
  try {
    const q = `
      SELECT p.id, p.nome_id, p.cliente_nome, p.telefone, p.status AS pedido_status, p.criado_em,
             n.nome AS nome, n.status AS nome_status, n.valor
      FROM pedidos p
      JOIN nomes n ON p.nome_id = n.id
      ORDER BY p.id DESC
    `;
    const result = await pool.query(q);
    // Normaliza para frontend esperado
    const rows = result.rows.map(r => ({
      id: r.id,
      nome_id: r.nome_id,
      cliente_nome: r.cliente_nome,
      telefone: r.telefone,
      status: r.pedido_status,
      criado_em: r.criado_em,
      nome: r.nome,
      nome_status: r.nome_status,
      valor: r.valor
    }));
    res.json(rows);
  } catch (err) {
    console.error('/pedidos error', err);
    res.status(500).json({ error: 'Erro ao buscar pedidos' });
  }
});

/*
 Confirmar pedido:
 - Muda nomes.status -> 'vendido' (apenas se estiver 'reservado')
 - Muda pedidos.status -> 'confirmado' (apenas se pedido existir)
 - Faz em transação
 - Recebe { nomeId, pedidoId } (pedidoId opcional; podemos marcar pedido relacionado)
*/
app.post('/confirmar', async (req, res) => {
  const { nomeId, pedidoId } = req.body;
  if (!nomeId) return res.status(400).json({ success: false, error: 'nomeId é obrigatório' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Atualiza nome
    const updNome = await client.query(
      "UPDATE nomes SET status = 'vendido' WHERE id = $1 AND status = 'reservado' RETURNING id",
      [nomeId]
    );
    if (updNome.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.json({ success: false, error: 'Nome não estava reservado ou não existe' });
    }

    // Atualiza pedido (se fornecido)
    if (pedidoId) {
      await client.query(
        "UPDATE pedidos SET status = 'confirmado' WHERE id = $1",
        [pedidoId]
      );
    } else {
      // se não deu pedidoId, tenta atualizar pedido pendente relacionado ao nome
      await client.query(
        "UPDATE pedidos SET status = 'confirmado' WHERE nome_id = $1 AND status = 'pendente'",
        [nomeId]
      );
    }

    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('/confirmar error', err);
    res.status(500).json({ success: false, error: 'Erro ao confirmar pagamento' });
  } finally {
    client.release();
  }
});

/*
 Cancelar reserva:
 - Muda nomes.status -> 'disponivel' (apenas se estiver 'reservado')
 - Muda pedidos.status -> 'cancelado' para pedido associado
 - Faz em transação
 - Recebe { nomeId, pedidoId } (pedidoId opcional)
*/
app.post('/cancelar', async (req, res) => {
  const { nomeId, pedidoId } = req.body;
  if (!nomeId) return res.status(400).json({ success: false, error: 'nomeId é obrigatório' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const updNome = await client.query(
      "UPDATE nomes SET status = 'disponivel' WHERE id = $1 AND status = 'reservado' RETURNING id",
      [nomeId]
    );
    if (updNome.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.json({ success: false, error: 'Nome não estava reservado ou não existe' });
    }

    if (pedidoId) {
      await client.query("UPDATE pedidos SET status = 'cancelado' WHERE id = $1", [pedidoId]);
    } else {
      await client.query("UPDATE pedidos SET status = 'cancelado' WHERE nome_id = $1 AND status = 'pendente'", [nomeId]);
    }

    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('/cancelar error', err);
    res.status(500).json({ success: false, error: 'Erro ao cancelar reserva' });
  } finally {
    client.release();
  }
});

/* Rota simples de saúde */
app.get('/', (req, res) => res.send('Rifa backend ok'));

/* Inicia servidor após init DB */
initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Server rodando na porta ${PORT}`);
    });
  })
  .catch(err => {
    console.error('Erro init DB:', err);
    process.exit(1);
  });
