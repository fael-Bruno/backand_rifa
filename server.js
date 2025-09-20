const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

const pool = new Pool({
  user: 'rifa_db_umol_user',
  host: 'backand-rifa-z2dj.onrender.com',
  database: 'rifa_db_umol',
  password: 'fwXKljEHd1OVoLbrgxlv516FqHAH1XGi',
  port: 5432
});

const JWT_SECRET = process.env.JWT_SECRET || 'supersecretkey';

// -----------------------
// Middlewares
// -----------------------
function authSuperAdmin(req,res,next){
  const token = req.headers['authorization']?.split(' ')[1];
  if(!token) return res.status(401).json({error:'Sem token'});
  try{
    const payload = jwt.verify(token, JWT_SECRET);
    if(!payload.isSuperAdmin) return res.status(403).json({error:'Acesso negado'});
    req.superadmin_id = payload.id;
    next();
  }catch(e){
    return res.status(401).json({error:'Token inválido'});
  }
}

function authBarbearia(req,res,next){
  const token = req.headers['authorization']?.split(' ')[1];
  if(!token) return res.status(401).json({error:'Sem token'});
  try{
    const payload = jwt.verify(token, JWT_SECRET);
    if(payload.isSuperAdmin) return res.status(403).json({error:'Acesso negado'});
    req.barbearia_id = payload.barbearia_id;
    next();
  }catch(e){
    return res.status(401).json({error:'Token inválido'});
  }
}

function authCliente(req,res,next){
  const token = req.headers['authorization']?.split(' ')[1];
  if(!token) return res.status(401).json({error:'Sem token'});
  try{
    const payload = jwt.verify(token, JWT_SECRET);
    if(payload.client_id == null) return res.status(403).json({error:'Acesso negado'});
    req.client_id = payload.client_id;
    req.barbearia_id = payload.barbearia_id; // client belongs to a barbearia
    next();
  }catch(e){
    return res.status(401).json({error:'Token inválido'});
  }
}

// -----------------------
// Superadmin routes (unchanged)
// -----------------------
app.post('/api/superadmin/login', async (req,res)=>{
  const {email, senha} = req.body;
  const admin = await pool.query('SELECT * FROM superadmins WHERE email=$1',[email]);
  if(admin.rowCount===0) return res.status(400).json({error:'Email não encontrado'});
  const valid = await bcrypt.compare(senha, admin.rows[0].senha);
  if(!valid) return res.status(400).json({error:'Senha incorreta'});
  const token = jwt.sign({id: admin.rows[0].id, isSuperAdmin:true}, JWT_SECRET, {expiresIn:'8h'});
  res.json({token, admin:{id:admin.rows[0].id, nome:admin.rows[0].nome}});
});

app.get('/api/superadmin/barbearias', authSuperAdmin, async (req,res)=>{
  const rows = await pool.query('SELECT id, nome, email, criado_em FROM barbearias ORDER BY criado_em DESC');
  res.json(rows.rows);
});

app.post('/api/superadmin/barbearias', authSuperAdmin, async (req,res)=>{
  const {nome,email,senha} = req.body;
  const hash = await bcrypt.hash(senha,10);
  const result = await pool.query('INSERT INTO barbearias(nome,email,senha) VALUES($1,$2,$3) RETURNING id,nome,email,criado_em',[nome,email,hash]);
  res.json(result.rows[0]);
});

app.delete('/api/superadmin/barbearias/:id', authSuperAdmin, async (req,res)=>{
  const {id} = req.params;
  await pool.query('DELETE FROM barbearias WHERE id=$1',[id]);
  res.json({success:true});
});

// -----------------------
// Barbearia (admin) routes
// -----------------------
app.post('/api/barbearias/login', async (req,res)=>{
  const {email,senha} = req.body;
  const barbearia = await pool.query('SELECT * FROM barbearias WHERE email=$1',[email]);
  if(barbearia.rowCount===0) return res.status(400).json({error:'Email não encontrado'});
  const valid = await bcrypt.compare(senha, barbearia.rows[0].senha);
  if(!valid) return res.status(400).json({error:'Senha incorreta'});
  const token = jwt.sign({barbearia_id: barbearia.rows[0].id}, JWT_SECRET, {expiresIn:'8h'});
  res.json({token, barbearia:{id:barbearia.rows[0].id, nome:barbearia.rows[0].nome}});
});

app.get('/api/clientes', authBarbearia, async (req,res)=>{
  const rows = await pool.query('SELECT id, nome, telefone, email, criado_em FROM clientes WHERE barbearia_id=$1',[req.barbearia_id]);
  res.json(rows.rows);
});

// allow barbearia to create clients (existing behavior)
app.post('/api/clientes', authBarbearia, async (req,res)=>{
  const {nome,telefone,email,senha} = req.body;
  const hash = await bcrypt.hash(senha,10);
  const result = await pool.query(
    'INSERT INTO clientes(nome,telefone,email,senha,barbearia_id) VALUES($1,$2,$3,$4,$5) RETURNING id,nome,telefone,email,criado_em',
    [nome,telefone,email,hash,req.barbearia_id]
  );
  res.json(result.rows[0]);
});

// Barbearia services (for admin)
app.get('/api/servicos', authBarbearia, async (req,res)=>{
  const rows = await pool.query('SELECT * FROM servicos WHERE barbearia_id=$1',[req.barbearia_id]);
  res.json(rows.rows);
});

// Agendamentos (admin creates on behalf of clients)
app.post('/api/agendamentos', authBarbearia, async (req,res)=>{
  const {cliente_id,servico_id,barbeiro,data,hora} = req.body;
  const result = await pool.query(
    'INSERT INTO agendamentos(cliente_id,servico_id,barbeiro,data,hora,barbearia_id) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',
    [cliente_id || null, servico_id, barbeiro, data, hora, req.barbearia_id]
  );
  res.json(result.rows[0]);
});

app.get('/api/agendamentos/meus', authBarbearia, async (req,res)=>{
  const rows = await pool.query(
    `SELECT a.*, s.nome as servico_nome, c.nome as cliente_nome
     FROM agendamentos a
     LEFT JOIN servicos s ON s.id=a.servico_id
     LEFT JOIN clientes c ON c.id=a.cliente_id
     WHERE a.barbearia_id=$1`, [req.barbearia_id]
  );
  res.json(rows.rows);
});

// Update status (used by admin panel)
app.put('/api/agendamentos/:id/status', authBarbearia, async (req,res)=>{
  const {id} = req.params;
  const {status} = req.body;
  await pool.query('UPDATE agendamentos SET status=$1 WHERE id=$2 AND barbearia_id=$3', [status,id,req.barbearia_id]);
  res.json({success:true});
});

// -----------------------
// Public endpoints for clients
// -----------------------
// List barbearias (for client to choose)
app.get('/api/public/barbearias', async (req,res)=>{
  const rows = await pool.query('SELECT id, nome FROM barbearias ORDER BY nome');
  res.json(rows.rows);
});

// List services for a barbearia (public)
app.get('/api/public/servicos', async (req,res)=>{
  const barbearia_id = req.query.barbearia_id;
  if(!barbearia_id) return res.status(400).json({error:'barbearia_id é obrigatório'});
  const rows = await pool.query('SELECT id, nome, duracao, preco FROM servicos WHERE barbearia_id=$1',[barbearia_id]);
  res.json(rows.rows);
});

// Client register (public)
app.post('/api/clientes/register', async (req,res)=>{
  const {nome,telefone,email,senha,barbearia_id} = req.body;
  if(!nome || !email || !senha || !barbearia_id) return res.status(400).json({error:'Campos obrigatórios faltando'});
  const hash = await bcrypt.hash(senha,10);
  const result = await pool.query(
    'INSERT INTO clientes(nome,telefone,email,senha,barbearia_id) VALUES($1,$2,$3,$4,$5) RETURNING id,nome,telefone,email,criado_em,barbearia_id',
    [nome,telefone,email,hash,barbearia_id]
  );
  res.json(result.rows[0]);
});

// Client login (public) -> returns token for client actions
app.post('/api/clientes/login', async (req,res)=>{
  const {email,senha} = req.body;
  const cliente = await pool.query('SELECT * FROM clientes WHERE email=$1',[email]);
  if(cliente.rowCount===0) return res.status(400).json({error:'Email não encontrado'});
  const valid = await bcrypt.compare(senha, cliente.rows[0].senha);
  if(!valid) return res.status(400).json({error:'Senha incorreta'});
  const token = jwt.sign({client_id: cliente.rows[0].id, barbearia_id: cliente.rows[0].barbearia_id}, JWT_SECRET, {expiresIn:'8h'});
  res.json({token, cliente:{id:cliente.rows[0].id, nome:cliente.rows[0].nome, barbearia_id: cliente.rows[0].barbearia_id}});
});

// Client: create appointment for their barbearia
app.post('/api/cliente/agendamentos', authCliente, async (req,res)=>{
  const {servico_id,barbeiro,data,hora} = req.body;
  const result = await pool.query(
    'INSERT INTO agendamentos(cliente_id,servico_id,barbeiro,data,hora,barbearia_id) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',
    [req.client_id, servico_id, barbeiro, data, hora, req.barbearia_id]
  );
  res.json(result.rows[0]);
});

app.get('/api/cliente/agendamentos/meus', authCliente, async (req,res)=>{
  const rows = await pool.query(
    `SELECT a.*, s.nome as servico_nome
     FROM agendamentos a
     LEFT JOIN servicos s ON s.id=a.servico_id
     WHERE a.cliente_id=$1`, [req.client_id]
  );
  res.json(rows.rows);
});

// Update appointment status by client is NOT allowed (clients can't confirm/cancel on behalf of barbearia)
// -----------------------

app.listen(process.env.PORT || 3000, ()=>console.log('Backend rodando'));