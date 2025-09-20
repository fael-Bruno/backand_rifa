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

const JWT_SECRET = 'supersecretkey';

// -----------------------
// Middleware Superadmin
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

// -----------------------
// Middleware Barbearia
// -----------------------
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

// -----------------------
// Rotas Superadmin
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

// Listar barbearias
app.get('/api/superadmin/barbearias', authSuperAdmin, async (req,res)=>{
  const rows = await pool.query('SELECT * FROM barbearias ORDER BY criado_em DESC');
  res.json(rows.rows);
});

// Criar barbearia
app.post('/api/superadmin/barbearias', authSuperAdmin, async (req,res)=>{
  const {nome,email,senha} = req.body;
  const hash = await bcrypt.hash(senha,10);
  const result = await pool.query('INSERT INTO barbearias(nome,email,senha) VALUES($1,$2,$3) RETURNING *',[nome,email,hash]);
  res.json(result.rows[0]);
});

// Deletar barbearia
app.delete('/api/superadmin/barbearias/:id', authSuperAdmin, async (req,res)=>{
  const {id} = req.params;
  await pool.query('DELETE FROM barbearias WHERE id=$1',[id]);
  res.json({success:true});
});

// -----------------------
// Rotas Barbearia
// -----------------------

// Login barbearia
app.post('/api/barbearias/login', async (req,res)=>{
  const {email,senha} = req.body;
  const barbearia = await pool.query('SELECT * FROM barbearias WHERE email=$1',[email]);
  if(barbearia.rowCount===0) return res.status(400).json({error:'Email não encontrado'});
  const valid = await bcrypt.compare(senha, barbearia.rows[0].senha);
  if(!valid) return res.status(400).json({error:'Senha incorreta'});
  const token = jwt.sign({barbearia_id: barbearia.rows[0].id}, JWT_SECRET, {expiresIn:'8h'});
  res.json({token, barbearia:{id:barbearia.rows[0].id, nome:barbearia.rows[0].nome}});
});

// Clientes
app.get('/api/clientes', authBarbearia, async (req,res)=>{
  const rows = await pool.query('SELECT * FROM clientes WHERE barbearia_id=$1',[req.barbearia_id]);
  res.json(rows.rows);
});

app.post('/api/clientes/cadastro', authBarbearia, async (req,res)=>{
  const {nome,telefone,email,senha} = req.body;
  const hash = await bcrypt.hash(senha,10);
  const result = await pool.query(
    'INSERT INTO clientes(nome,telefone,email,senha,barbearia_id) VALUES($1,$2,$3,$4,$5) RETURNING *',
    [nome,telefone,email,hash,req.barbearia_id]
  );
  res.json(result.rows[0]);
});

// Serviços
app.get('/api/servicos', authBarbearia, async (req,res)=>{
  const rows = await pool.query('SELECT * FROM servicos WHERE barbearia_id=$1',[req.barbearia_id]);
  res.json(rows.rows);
});

// Agendamentos
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

// Atualizar status do agendamento
app.put('/api/agendamentos/:id/status', authBarbearia, async (req,res)=>{
  const {id} = req.params;
  const {status} = req.body;
  await pool.query('UPDATE agendamentos SET status=$1 WHERE id=$2 AND barbearia_id=$3', [status,id,req.barbearia_id]);
  res.json({success:true});
});

app.listen(process.env.PORT || 3000, ()=>console.log('Backend rodando'));
