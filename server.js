require("dotenv").config();

const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const sql = require("./db");

const app = express();

app.use(express.json());
app.use(cors());

/* ===============================
   ROTA PRINCIPAL
================================= */
app.get("/", (req, res) => {
  res.send("Servidor rodando 🚀");
});

/* ===============================
   MIDDLEWARE DE VERIFICAÇÃO TOKEN
================================= */
function verificarToken(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return res.status(401).json({ error: "Token não fornecido" });
  }

  const token = authHeader.split(" ")[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(403).json({ error: "Token inválido" });
  }
}

/* ===============================
   LOGIN
================================= */
app.post("/login", async (req, res) => {
  const { username, password } = req.body;

  try {
    const user = await sql`
      SELECT * FROM users
      WHERE username = ${username}
    `;

    if (user.length === 0) {
      return res.json({ success: false });
    }

    if (password !== user[0].password) {
      return res.json({ success: false });
    }

    // 🔐 GERANDO TOKEN
    const token = jwt.sign(
      {
        id: user[0].id,
        username: user[0].username,
        role: user[0].role
      },
      process.env.JWT_SECRET,
      { expiresIn: "8h" }
    );

    res.json({
      success: true,
      token,
      username: user[0].username
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/* ===============================
   ROTA PROTEGIDA (EXEMPLO)
================================= */
app.get("/perfil", verificarToken, (req, res) => {
  res.json({
    message: "Acesso permitido ✅",
    usuario: req.user
  });
});

/* ===============================
   TESTE DE CONEXÃO DB
================================= */
app.get("/test-db", async (req, res) => {
  try {
    const result = await sql`SELECT NOW()`;
    res.json({
      success: true,
      serverTime: result[0],
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/* ===============================
   START SERVER
================================= */
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Servidor rodando na porta " + PORT);
});