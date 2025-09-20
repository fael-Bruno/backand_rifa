const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } // necessário no Render
});

const JWT_SECRET = process.env.JWT_SECRET || 'segredo';

// --- CLIENTES ---
app.post('/api/clientes/cadastro', async (req,res) => {
  const {nome,telefone,email,senha} = req.body;
  if(!nome || !email || !senha) return res.status(400).json({error:'Campos obrigatórios'});
  const hash = await bcrypt.hash(senha,10);
  try{
    const r = await pool.query('INSERT INTO clientes(nome,telefone,email,senha) VALUES($1,$2,$3,$4) RETURNING *',[nome,telefone,email,hash]);
    res.json(r.rows[0]);
  }catch(e){
    res.status(400).json({error:'Email já cadastrado'});
  }
});

app.post('/api/clientes/login', async (req,res)=>{
  const {email,senha} = req.body;
  const r = await pool.query('SELECT * FROM clientes WHERE email=$1',[email]);
  if(r.rows.length===0) return res.status(400).json({error:'Usuário não encontrado'});
  const cliente = r.rows[0];
  const match = await bcrypt.compare(senha, cliente.senha);
  if(!match) return res.status(400).json({error:'Senha incorreta'});
  const token = jwt.sign({id:cliente.id},JWT_SECRET,{expiresIn:'12h'});
  res.json({token,cliente:{nome:cliente.nome,email:cliente.email,id:cliente.id}});
});

// Middleware auth cliente
function authCliente(req,res,next){
  const h = req.headers['authorization'];
  if(!h) return res.status(401).json({error:'Token necessário'});
  const token = h.split(' ')[1];
  try{
    const data = jwt.verify(token,JWT_SECRET);
    req.clienteId = data.id;
    next();
  }catch(e){
    res.status(401).json({error:'Token inválido'});
  }
}

// Servicos
app.get('/api/servicos', async (req,res)=>{
  const r = await pool.query('SELECT * FROM servicos');
  res.json(r.rows);
});

// Agendamentos
app.post('/api/agendamentos', authCliente, async (req,res)=>{
  const {servico_id,barbeiro,data,hora} = req.body;
  try{
    const r = await pool.query('INSERT INTO agendamentos(cliente_id,servico_id,barbeiro,data,hora) VALUES($1,$2,$3,$4,$5) RETURNING *',
      [req.clienteId,servico_id,barbeiro,data,hora]);
    res.json(r.rows[0]);
  }catch(e){
    res.status(400).json({error:'Erro ao criar agendamento'});
  }
});

app.get('/api/agendamentos/meus', authCliente, async (req,res)=>{
  const r = await pool.query(
    `SELECT a.*, s.nome as servico_nome 
     FROM agendamentos a 
     LEFT JOIN servicos s ON s.id = a.servico_id
     WHERE a.cliente_id=$1 ORDER BY a.data,a.hora`,
    [req.clienteId]);
  res.json(r.rows);
});

// --- ADMIN ---
app.post('/api/admin/login', async (req,res)=>{
  const {email,senha} = req.body;
  const r = await pool.query('SELECT * FROM admins WHERE email=$1',[email]);
  if(r.rows.length===0) return res.status(400).json({error:'Admin não encontrado'});
  const admin = r.rows[0];
  const match = await bcrypt.compare(senha,admin.senha);
  if(!match) return res.status(400).json({error:'Senha incorreta'});
  const token = jwt.sign({id:admin.id},JWT_SECRET,{expiresIn:'12h'});
  res.json({token,admin:{nome:admin.nome,email:admin.email,id:admin.id}});
});

function authAdmin(req,res,next){
  const h = req.headers['authorization'];
  if(!h) return res.status(401).json({error:'Token admin necessário'});
  const token = h.split(' ')[1];
  try{
    const data = jwt.verify(token,JWT_SECRET);
    req.adminId = data.id;
    next();
  }catch(e){
    res.status(401).json({error:'Token inválido'});
  }
}

// Listar clientes
app.get('/api/admin/clientes', authAdmin, async (req,res)=>{
  const r = await pool.query('SELECT * FROM clientes ORDER BY criado_em DESC');
  res.json(r.rows);
});

// Listar agendamentos
app.get('/api/admin/agendamentos', authAdmin, async (req,res)=>{
  const r = await pool.query(
    `SELECT a.*, s.nome as servico_nome, c.nome as cliente_nome 
     FROM agendamentos a 
     LEFT JOIN servicos s ON s.id=a.servico_id
     LEFT JOIN clientes c ON c.id=a.cliente_id
     ORDER BY a.data,a.hora`);
  res.json(r.rows);
});

// Confirmar/Cancelar
app.put('/api/admin/agendamentos/:id/confirmar', authAdmin, async (req,res)=>{
  const {id} = req.params;
  await pool.query('UPDATE agendamentos SET status=$1 WHERE id=$2',['confirmado',id]);
  res.json({ok:true});
});

app.put('/api/admin/agendamentos/:id/cancelar', authAdmin, async (req,res)=>{
  const {id} = req.params;
  await pool.query('UPDATE agendamentos SET status=$1 WHERE id=$2',['cancelado',id]);
  res.json({ok:true});
});

// Rodar servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT,()=>console.log(`Servidor rodando na porta ${PORT}`));
