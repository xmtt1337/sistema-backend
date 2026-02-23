require("dotenv").config();

const express = require("express");
const cors = require("cors");
const pool = require("./db");

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
   TESTE DE CONEXÃO COM O BANCO
================================= */
app.get("/test-db", async (req, res) => {
  try {
    const result = await pool.query("SELECT NOW()");
    res.json({
      success: true,
      serverTime: result.rows[0],
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/* ===============================
   LOGIN (ainda simples - temporário)
================================= */
app.post("/login", (req, res) => {
  const { username, password } = req.body;

  if (username === "admin" && password === "1234") {
    res.json({ success: true });
  } else {
    res.status(401).json({ success: false });
  }
});

/* ===============================
   START SERVER
================================= */
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Servidor rodando na porta " + PORT);
});