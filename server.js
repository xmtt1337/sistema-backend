require("dotenv").config();

const express = require("express");
const cors = require("cors");
const sql = require("./db"); // <- IMPORTANTE: sql, não pool

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
   LOGIN (temporário ainda)
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
   LISTAR USERS (exemplo real)
================================= */
app.get("/users", async (req, res) => {
  try {
    const users = await sql`SELECT * FROM users`;
    res.json(users);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/* ===============================
   START SERVER
================================= */
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Servidor rodando na porta " + PORT);
});