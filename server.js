// Cadastro de admin
app.post("/admin/cadastrar", async (req, res) => {
  const { email, senha } = req.body;
  if (!email || !senha) {
    return res.status(400).json({ error: "Email e senha são obrigatórios" });
  }

  try {
    const result = await pool.query(
      "INSERT INTO public.admins (email, senha) VALUES ($1, $2) RETURNING id, email",
      [email, senha]
    );
    res.json({ success: true, admin: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: "Erro ao cadastrar admin", details: err.message });
  }
});

// Login de admin
app.post("/admin/login", async (req, res) => {
  const { email, senha } = req.body;
  if (!email || !senha) {
    return res.status(400).json({ error: "Email e senha obrigatórios" });
  }

  try {
    const result = await pool.query(
      "SELECT * FROM public.admins WHERE email = $1 AND senha = $2",
      [email, senha]
    );

    if (result.rowCount === 0) {
      return res.status(401).json({ error: "Email ou senha incorretos" });
    }

    res.json({ success: true, message: "Login bem-sucedido" });
  } catch (err) {
    res.status(500).json({ error: "Erro ao logar admin", details: err.message });
  }
});
