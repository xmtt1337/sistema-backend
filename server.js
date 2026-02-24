require("dotenv").config();

const express = require("express");
const cors = require("cors");
const bcrypt = require("bcrypt");
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
   TESTE DE CONEXÃO
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