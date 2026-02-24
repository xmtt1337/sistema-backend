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
   LOGIN SEGURO
================================= */
app.post("/login", async (req, res) => {
  const { username, password } = req.body;

  console.log("Username recebido:", username);
  console.log("Password recebida:", password);

  try {
    const user = await sql`
      SELECT * FROM users
      WHERE username = ${username}
    `;

    console.log("Resultado da busca:", user);

    if (user.length === 0) {
      console.log("Usuário NÃO encontrado");
      return res.json({ success: false });
    }

    console.log("Senha no banco:", user[0].password);

    if (password !== user[0].password) {
      console.log("Senha NÃO confere");
      return res.json({ success: false });
    }

    console.log("Login OK");

    res.json({ success: true });

  } catch (error) {
    console.log("Erro:", error);
    res.status(500).json({ error: error.message });
  }
});


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