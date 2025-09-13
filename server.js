require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DB_SSL === "true" ? { rejectUnauthorized: false } : false
});

// Criação das tabelas
async function initDB() {
  try {
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

    await pool.query(`
      CREATE TABLE IF NOT EXISTS admins (
        id SERIAL PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        senha TEXT NOT NULL
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS config (
        id SERIAL PRIMARY KEY,
        valor_rifa NUMERIC DEFAULT 0,
        premio TEXT DEFAULT '',
        usuario_id INT REFERENCES usuarios(id) ON DELETE CASCADE
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS nomes (
        id SERIAL PRIMARY KEY,
        nome TEXT NOT NULL,
        status TEXT DEFAULT 'disponivel',
        premiado BOOLEAN DEFAULT FALSE,
        usuario_id INT REFERENCES usuarios(id) ON DELETE CASCADE
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS pedidos (
        id SERIAL PRIMARY KEY,
        nome_id INT REFERENCES nomes(id) ON DELETE CASCADE,
        cliente_nome TEXT,
        telefone TEXT,
        status TEXT DEFAULT 'reservado',
        usuario_id INT REFERENCES usuarios(id) ON DELETE CASCADE
      );
    `);

    await pool.query(`
      INSERT INTO admins (email, senha)
      VALUES ('admin@local', '123')
      ON CONFLICT (email) DO NOTHING;
    `);

    console.log("Banco inicializado.");
  } catch (err) {
    console.error("Erro initDB:", err);
    process.exit(1);
  }
}
initDB();

// ---------------- ROTAS ----------------

function parseNumber(v){ if(!v) return null; return parseFloat(String(v).replace(",", ".")) }

// Admin geral
app.post("/admin/login", async (req,res)=>{
  const {email,senha}=req.body;
  try{
    const r=await pool.query("SELECT * FROM admins WHERE email=$1 AND senha=$2",[email,senha]);
    if(r.rowCount===0) return res.status(401).json({error:"Credenciais inválidas"});
    res.json({success:true});
  }catch(e){console.error(e);res.status(500).json({error:"Erro no login"});}
});

// Registro organizador
app.post("/usuarios/registro", async (req,res)=>{
  const {nome,email,senha}=req.body;
  try{
    const r=await pool.query("INSERT INTO usuarios (nome,email,senha) VALUES ($1,$2,$3) RETURNING id",[nome,email,senha]);
    await pool.query("INSERT INTO config (usuario_id) VALUES ($1)",[r.rows[0].id]);
    res.json({success:true,message:"Conta criada, aguarde ativação."});
  }catch(e){console.error(e);res.status(500).json({error:"Erro no cadastro"});}
});

// Login organizador
app.post("/usuarios/login", async (req,res)=>{
  const {email,senha}=req.body;
  try{
    const r=await pool.query("SELECT id,nome,ativo FROM usuarios WHERE email=$1 AND senha=$2",[email,senha]);
    if(r.rowCount===0) return res.status(401).json({error:"Credenciais inválidas"});
    if(!r.rows[0].ativo) return res.status(403).json({error:"Conta aguardando ativação"});
    res.json({success:true,usuarioId:r.rows[0].id,nome:r.rows[0].nome});
  }catch(e){console.error(e);res.status(500).json({error:"Erro no login"});}
});

// Listar / ativar usuários
app.get("/usuarios", async (req,res)=>{
  try{const r=await pool.query("SELECT * FROM usuarios ORDER BY criado_em DESC");res.json(r.rows);}
  catch(e){console.error(e);res.status(500).json({error:"Erro"});}
});
app.post("/usuarios/ativar", async (req,res)=>{
  const {usuarioId,ativo}=req.body;
  try{await pool.query("UPDATE usuarios SET ativo=$1 WHERE id=$2",[ativo,usuarioId]);res.json({success:true});}
  catch(e){console.error(e);res.status(500).json({error:"Erro"});}
});

// Config
app.get("/config",async(req,res)=>{
  const usuarioId=req.query.usuarioId;
  try{const r=await pool.query("SELECT valor_rifa,premio FROM config WHERE usuario_id=$1",[usuarioId]);res.json(r.rows[0]||{});}
  catch(e){console.error(e);res.status(500).json({error:"Erro"});}
});
app.post("/config",async(req,res)=>{
  const {valor_rifa,premio,usuarioId}=req.body;
  try{
    const v=parseNumber(valor_rifa);
    const r=await pool.query("SELECT id FROM config WHERE usuario_id=$1",[usuarioId]);
    if(r.rowCount>0) await pool.query("UPDATE config SET valor_rifa=$1,premio=$2 WHERE usuario_id=$3",[v,premio,usuarioId]);
    else await pool.query("INSERT INTO config (valor_rifa,premio,usuario_id) VALUES ($1,$2,$3)",[v,premio,usuarioId]);
    res.json({success:true});
  }catch(e){console.error(e);res.status(500).json({error:"Erro"});}
});

// Nomes
app.get("/nomes",async(req,res)=>{
  const usuarioId=req.query.usuarioId;
  try{const r=await pool.query("SELECT * FROM nomes WHERE usuario_id=$1",[usuarioId]);res.json(r.rows);}
  catch(e){console.error(e);res.status(500).json({error:"Erro"});}
});
app.post("/nomes",async(req,res)=>{
  const {nome,usuarioId}=req.body;
  try{await pool.query("INSERT INTO nomes (nome,usuario_id) VALUES ($1,$2)",[nome,usuarioId]);res.json({success:true});}
  catch(e){console.error(e);res.status(500).json({error:"Erro"});}
});

// Pedidos
app.get("/pedidos",async(req,res)=>{
  const usuarioId=req.query.usuarioId;
  try{const r=await pool.query("SELECT p.*,n.nome FROM pedidos p JOIN nomes n ON n.id=p.nome_id WHERE p.usuario_id=$1",[usuarioId]);res.json(r.rows);}
  catch(e){console.error(e);res.status(500).json({error:"Erro"});}
});
app.post("/comprar",async(req,res)=>{
  const {nomeId,cliente_nome,telefone,usuarioId}=req.body;
  try{
    await pool.query("UPDATE nomes SET status='reservado' WHERE id=$1",[nomeId]);
    await pool.query("INSERT INTO pedidos (nome_id,cliente_nome,telefone,usuario_id) VALUES ($1,$2,$3,$4)",[nomeId,cliente_nome,telefone,usuarioId]);
    res.json({success:true});
  }catch(e){console.error(e);res.status(500).json({error:"Erro"});}
});
app.post("/confirmar",async(req,res)=>{
  const {nomeId}=req.body;
  try{
    await pool.query("UPDATE nomes SET status='vendido' WHERE id=$1",[nomeId]);
    await pool.query("UPDATE pedidos SET status='confirmado' WHERE nome_id=$1",[nomeId]);
    res.json({success:true});
  }catch(e){console.error(e);res.status(500).json({error:"Erro"});}
});
app.post("/cancelar",async(req,res)=>{
  const {nomeId}=req.body;
  try{
    await pool.query("UPDATE nomes SET status='disponivel' WHERE id=$1",[nomeId]);
    await pool.query("DELETE FROM pedidos WHERE nome_id=$1",[nomeId]);
    res.json({success:true});
  }catch(e){console.error(e);res.status(500).json({error:"Erro"});}
});

app.post("/resetar",async(req,res)=>{
  const {usuarioId}=req.body;
  try{
    await pool.query("DELETE FROM pedidos WHERE usuario_id=$1",[usuarioId]);
    await pool.query("UPDATE nomes SET status='disponivel', premiado=false WHERE usuario_id=$1",[usuarioId]);
    res.json({success:true});
  }catch(e){console.error(e);res.status(500).json({error:"Erro"});}
});

// Sorteio
app.get("/sorteio",async(req,res)=>{
  const usuarioId=req.query.usuarioId;
  try{
    const r=await pool.query("SELECT p.*,n.nome FROM pedidos p JOIN nomes n ON n.id=p.nome_id WHERE p.usuario_id=$1 AND p.status='confirmado' ORDER BY RANDOM() LIMIT 1",[usuarioId]);
    if(r.rowCount===0) return res.status(404).json({error:"Nenhum confirmado"});
    res.json(r.rows[0]);
  }catch(e){console.error(e);res.status(500).json({error:"Erro"});}
});

app.listen(process.env.PORT||3000,()=>console.log("Servidor ativo"));
