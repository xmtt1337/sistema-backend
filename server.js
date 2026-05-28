require("dotenv").config();

const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const { google } = require("googleapis");
const sql = require("./db");

const ORIGENS_PERMITIDAS = [
  "https://xmtt1337.github.io",
  "http://localhost:5500",   // Live Server local
  "http://127.0.0.1:5500"
];

const app = express();
app.use(express.json());
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || ORIGENS_PERMITIDAS.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error("CORS: origem não permitida — " + origin));
    }
  }
}));

app.get("/", (req, res) => {
  res.send("Servidor rodando 🚀");
});

function verificarToken(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: "Token não fornecido" });
  const token = authHeader.split(" ")[1];
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    return res.status(403).json({ error: "Token inválido" });
  }
}

function verificarAdmin(req, res, next) {
  if (req.user.role !== "admin") return res.status(403).json({ error: "Acesso negado" });
  next();
}

app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  try {
    const user = await sql`SELECT * FROM users WHERE username = ${username}`;
    if (!user.length || password !== user[0].password) {
      return res.json({ success: false });
    }
    const token = jwt.sign(
      { id: user[0].id, username: user[0].username, role: user[0].role },
      process.env.JWT_SECRET,
      { expiresIn: "8h" }
    );
    const require_password_change = user[0].password === "GC2026";
    res.json({ success: true, token, username: user[0].username, require_password_change });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/perfil", verificarToken, (req, res) => {
  res.json({ message: "Acesso permitido ✅", usuario: req.user });
});

app.post("/redefinir-senha", async (req, res) => {
  const { username, senha_atual, senha_nova } = req.body;
  if (!username || !senha_atual || !senha_nova) {
    return res.status(400).json({ success: false, error: "Preencha todos os campos." });
  }
  if (senha_nova.length < 4) {
    return res.status(400).json({ success: false, error: "A senha nova deve ter pelo menos 4 caracteres." });
  }
  if (senha_nova === "GC2026") {
    return res.status(400).json({ success: false, error: "Esta senha não pode ser utilizada. Escolha uma senha diferente." });
  }
  try {
    const user = await sql`SELECT * FROM users WHERE username = ${username}`;
    if (!user.length || senha_atual !== user[0].password) {
      return res.status(401).json({ success: false, error: "Usuário ou senha atual incorretos." });
    }
    await sql`UPDATE users SET password = ${senha_nova} WHERE username = ${username}`;
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

function num(valor) {
  if (valor === null || valor === undefined || valor === "") return 0;
  let s = String(valor)
    .replace(/R\$\s?/g, "")
    .replace(/\./g, "")
    .replace(",", ".")
    .replace("−", "-")
    .replace("–", "-")
    .trim();
  const neg = s.startsWith("-");
  s = s.replace(/-/g, "");
  const n = parseFloat(s) || 0;
  return neg ? -n : n;
}

function moeda(valor) {
  const n = typeof valor === "number" ? valor : num(valor);
  return "R$ " + n.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function inteiro(valor) {
  const n = Math.round(num(valor));
  return isNaN(n) ? "0" : n.toLocaleString("pt-BR");
}

function parsePeriodo(codigo) {
  const meses = {
    jan: [1, "Janeiro"], fev: [2, "Fevereiro"], mar: [3, "Março"],
    abr: [4, "Abril"],   mai: [5, "Maio"],       jun: [6, "Junho"],
    jul: [7, "Julho"],   ago: [8, "Agosto"],      set: [9, "Setembro"],
    out: [10, "Outubro"], nov: [11, "Novembro"], dez: [12, "Dezembro"]
  };
  const match = String(codigo || "").trim().match(/^Q([12])([A-Za-z]{3})/);
  if (!match) return codigo || "—";
  const [, quinzena, mesCod] = match;
  const info = meses[mesCod.toLowerCase()];
  if (!info) return codigo;
  const [numMes, nomeMes] = info;
  const ano = new Date().getFullYear();
  const ultimoDia = new Date(ano, numMes, 0).getDate();
  return quinzena === "1"
    ? `01 – 15 / ${nomeMes} / ${ano}`
    : `16 – ${String(ultimoDia).padStart(2, "0")} / ${nomeMes} / ${ano}`;
}

function extrairSpreadsheetId(url) {
  const match = String(url).match(/\/d\/([a-zA-Z0-9-_]+)/);
  return match ? match[1] : url;
}

async function lerPlanilha(spreadsheetId) {
  const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"]
  });
  const sheets = google.sheets({ version: "v4", auth });
  const [r1, r2] = await Promise.all([
    sheets.spreadsheets.values.get({ spreadsheetId, range: "RESUMO!A:Z" }),
    sheets.spreadsheets.values.get({ spreadsheetId, range: "Extravios!A:Z" })
  ]);
  return { resumo: r1.data.values || [], extravios: r2.data.values || [] };
}

app.get("/painel", verificarToken, async (req, res) => {
  try {
    const { mes, ano, quinzena } = req.query;
    const nomeEntregador = req.user.username;

    const planilha = await sql`
      SELECT spreadsheet_id FROM planilhas_quinzena
      WHERE mes = ${parseInt(mes)} AND ano = ${parseInt(ano)} AND quinzena = ${parseInt(quinzena)}
      LIMIT 1
    `;
    if (!planilha.length) {
      return res.status(404).json({ error: "Nenhum fechamento encontrado para este período." });
    }

    const { resumo, extravios } = await lerPlanilha(planilha[0].spreadsheet_id);

    const cabecalho = (resumo[1] || []).map(c =>
      String(c || "").trim().replace(/\n/g, " ").replace(/  +/g, " ")
    );
    const linhas = resumo.slice(2);
    const nomeIdx = cabecalho.indexOf("NOME");

    const linha = linhas.find(l =>
      String(l[nomeIdx] || "").trim().toLowerCase() === nomeEntregador.toLowerCase()
    );
    if (!linha) {
      return res.status(404).json({ error: `Entregador "${nomeEntregador}" não encontrado na planilha.` });
    }

    const get = col => {
      const idx = cabecalho.indexOf(col);
      return idx >= 0 ? String(linha[idx] || "") : "";
    };

    const extCab = (extravios[0] || []).map(c => String(c || "").trim());
    const extLinhas = extravios.slice(1);
    const extCabLower = extCab.map(c => c.toLowerCase());

    const findCol = name => {
      const exact = extCab.indexOf(name);
      return exact >= 0 ? exact : extCabLower.indexOf(name.toLowerCase());
    };

    const colValorCandidates = ["VALOR", "VLR", "VALOR DO PRODUTO", "VALOR PRODUTO"];
    const colValorIdx = colValorCandidates.reduce((f, c) => f >= 0 ? f : findCol(c), -1);

    const statusIdx = findCol("STATUS");
    const respIdx   = findCol("Responsavel");
    const transpIdx = findCol("TRANSPORTADORA");
    const codIdx    = findCol("CÓDIGO");
    const endIdx    = findCol("Endereço");
    const datIdx    = findCol("Data do desconto");

    const nome_lower = nomeEntregador.toLowerCase();
    const extravioslst = [];
    const multaslst    = [];
    let codigoPeriodo  = "";

    extLinhas.forEach(row => {
      if (!codigoPeriodo && datIdx >= 0 && row[datIdx] && row[datIdx].trim()) {
        codigoPeriodo = row[datIdx].trim();
      }
      const status   = String(row[statusIdx] || "").trim().toLowerCase();
      const resp     = String(row[respIdx]   || "").trim();
      const nomeResp = resp.split(" - ")[0].trim().toLowerCase();
      if (!nome_lower.includes(nomeResp) && !nomeResp.includes(nome_lower)) return;

      const valorRaw = colValorIdx >= 0 ? String(row[colValorIdx] || "") : "";
      const valorNum = num(valorRaw);
      const item = {
        transportadora: String(row[transpIdx] || "—").trim(),
        codigo:         String(row[codIdx]    || "—").trim(),
        endereco:       String(row[endIdx]    || "—").trim(),
        valor:          valorNum ? moeda(valorNum) : "R$ 0,00",
        tem_valor:      valorNum !== 0
      };
      if (status === "multa") multaslst.push(item);
      else extravioslst.push(item);
    });

    const multas_valor      = num(get("MULTAS"));
    const extravios_valor   = num(get("EXTRAVIOS"));
    const total_receber_num = num(get("TOTAL A RECEBER"));

    res.json({
      nome:             nomeEntregador,
      periodo:          parsePeriodo(codigoPeriodo),
      total_receber:    moeda(total_receber_num),
      total_receber_num,
      total_entregues:  inteiro(get("TOTAL ENTREGUES")),
      adicional:        moeda(num(get("ADICIONAL ------ ACERTO"))),
      deslocamento:     moeda(num(get("DESLOCAMENTO"))),
      valor_grandes:    moeda(num(get("VALOR A PAGAR PACOTES GRANDES"))),
      desconto_ticket:  moeda(num(get("DESCONTO CARTÃO TICKET LOG"))),
      descontos:        moeda(extravios_valor + multas_valor),
      multas:           moeda(multas_valor),
      valor_loggi:      moeda(num(get("VALOR LOGGI"))),
      entregues_loggi:  inteiro(get("ENTREGUES NO PRAZO LOGGI")),
      valor_jt:         moeda(num(get("VALOR J&T"))),
      entregues_jt:     inteiro(get("ENTREGUES J&T")),
      valor_imile:      moeda(num(get("VALOR IMILE"))),
      qtd_imile:        inteiro(get("QTD IMILE")),
      valor_anjun:      moeda(num(get("VALOR ANJUN"))),
      entregues_anjun:  inteiro(get("ENTREGUES NO PRAZO ANJUN")),
      valor_shopee:     moeda(num(get("VALOR SHOPEE"))),
      entregues_shopee: inteiro(get("PACOTES ENTREGUES SPX")),
      extravios_linhas: extravioslst,
      multas_linhas:    multaslst,
      multas_tem_valor: multas_valor !== 0
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/admin/entregadores", verificarToken, verificarAdmin, async (req, res) => {
  try {
    const { mes, ano, quinzena } = req.query;

    const planilha = await sql`
      SELECT spreadsheet_id FROM planilhas_quinzena
      WHERE mes = ${parseInt(mes)} AND ano = ${parseInt(ano)} AND quinzena = ${parseInt(quinzena)}
      LIMIT 1
    `;
    if (!planilha.length) {
      return res.status(404).json({ error: "Nenhum fechamento encontrado para este período." });
    }

    const { resumo } = await lerPlanilha(planilha[0].spreadsheet_id);

    const cabecalho = (resumo[1] || []).map(c =>
      String(c || "").trim().replace(/\n/g, " ").replace(/  +/g, " ")
    );
    const linhas = resumo.slice(2);
    const nomeIdx = cabecalho.indexOf("NOME");

    if (nomeIdx < 0) {
      return res.status(500).json({ error: "Coluna NOME não encontrada na planilha." });
    }

    const totalIdx = cabecalho.indexOf("TOTAL A RECEBER");

    const entregadores = linhas
      .map(l => {
        const nome = String(l[nomeIdx] || "").trim();
        if (!nome) return null;
        const totalRaw = totalIdx >= 0 ? String(l[totalIdx] || "") : "";
        const totalNum = num(totalRaw);
        return { nome, total_receber: moeda(totalNum), total_receber_num: totalNum };
      })
      .filter(Boolean);

    res.json({ entregadores });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/admin/painel", verificarToken, verificarAdmin, async (req, res) => {
  try {
    const { mes, ano, quinzena, entregador } = req.query;

    if (!entregador) {
      return res.status(400).json({ error: "Informe o usuário do entregador." });
    }

    const nomeEntregador = entregador;

    const planilha = await sql`
      SELECT spreadsheet_id FROM planilhas_quinzena
      WHERE mes = ${parseInt(mes)} AND ano = ${parseInt(ano)} AND quinzena = ${parseInt(quinzena)}
      LIMIT 1
    `;
    if (!planilha.length) {
      return res.status(404).json({ error: "Nenhum fechamento encontrado para este período." });
    }

    const { resumo, extravios } = await lerPlanilha(planilha[0].spreadsheet_id);

    const cabecalho = (resumo[1] || []).map(c =>
      String(c || "").trim().replace(/\n/g, " ").replace(/  +/g, " ")
    );
    const linhas = resumo.slice(2);
    const nomeIdx = cabecalho.indexOf("NOME");

    const linha = linhas.find(l =>
      String(l[nomeIdx] || "").trim().toLowerCase() === nomeEntregador.toLowerCase()
    );
    if (!linha) {
      return res.status(404).json({ error: `Entregador "${nomeEntregador}" não encontrado na planilha.` });
    }

    const get = col => {
      const idx = cabecalho.indexOf(col);
      return idx >= 0 ? String(linha[idx] || "") : "";
    };

    const extCab = (extravios[0] || []).map(c => String(c || "").trim());
    const extLinhas = extravios.slice(1);
    const extCabLower = extCab.map(c => c.toLowerCase());

    const findCol = name => {
      const exact = extCab.indexOf(name);
      return exact >= 0 ? exact : extCabLower.indexOf(name.toLowerCase());
    };

    const colValorCandidates = ["VALOR", "VLR", "VALOR DO PRODUTO", "VALOR PRODUTO"];
    const colValorIdx = colValorCandidates.reduce((f, c) => f >= 0 ? f : findCol(c), -1);

    const statusIdx = findCol("STATUS");
    const respIdx   = findCol("Responsavel");
    const transpIdx = findCol("TRANSPORTADORA");
    const codIdx    = findCol("CÓDIGO");
    const endIdx    = findCol("Endereço");
    const datIdx    = findCol("Data do desconto");

    const nome_lower = nomeEntregador.toLowerCase();
    const extravioslst = [];
    const multaslst    = [];
    let codigoPeriodo  = "";

    extLinhas.forEach(row => {
      if (!codigoPeriodo && datIdx >= 0 && row[datIdx] && row[datIdx].trim()) {
        codigoPeriodo = row[datIdx].trim();
      }
      const status   = String(row[statusIdx] || "").trim().toLowerCase();
      const resp     = String(row[respIdx]   || "").trim();
      const nomeResp = resp.split(" - ")[0].trim().toLowerCase();
      if (!nome_lower.includes(nomeResp) && !nomeResp.includes(nome_lower)) return;

      const valorRaw = colValorIdx >= 0 ? String(row[colValorIdx] || "") : "";
      const valorNum = num(valorRaw);
      const item = {
        transportadora: String(row[transpIdx] || "—").trim(),
        codigo:         String(row[codIdx]    || "—").trim(),
        endereco:       String(row[endIdx]    || "—").trim(),
        valor:          valorNum ? moeda(valorNum) : "R$ 0,00",
        tem_valor:      valorNum !== 0
      };
      if (status === "multa") multaslst.push(item);
      else extravioslst.push(item);
    });

    const multas_valor      = num(get("MULTAS"));
    const extravios_valor   = num(get("EXTRAVIOS"));
    const total_receber_num = num(get("TOTAL A RECEBER"));

    res.json({
      nome:             nomeEntregador,
      periodo:          parsePeriodo(codigoPeriodo),
      total_receber:    moeda(total_receber_num),
      total_receber_num,
      total_entregues:  inteiro(get("TOTAL ENTREGUES")),
      adicional:        moeda(num(get("ADICIONAL ------ ACERTO"))),
      deslocamento:     moeda(num(get("DESLOCAMENTO"))),
      valor_grandes:    moeda(num(get("VALOR A PAGAR PACOTES GRANDES"))),
      desconto_ticket:  moeda(num(get("DESCONTO CARTÃO TICKET LOG"))),
      descontos:        moeda(extravios_valor + multas_valor),
      multas:           moeda(multas_valor),
      valor_loggi:      moeda(num(get("VALOR LOGGI"))),
      entregues_loggi:  inteiro(get("ENTREGUES NO PRAZO LOGGI")),
      valor_jt:         moeda(num(get("VALOR J&T"))),
      entregues_jt:     inteiro(get("ENTREGUES J&T")),
      valor_imile:      moeda(num(get("VALOR IMILE"))),
      qtd_imile:        inteiro(get("QTD IMILE")),
      valor_anjun:      moeda(num(get("VALOR ANJUN"))),
      entregues_anjun:  inteiro(get("ENTREGUES NO PRAZO ANJUN")),
      valor_shopee:     moeda(num(get("VALOR SHOPEE"))),
      entregues_shopee: inteiro(get("PACOTES ENTREGUES SPX")),
      extravios_linhas: extravioslst,
      multas_linhas:    multaslst,
      multas_tem_valor: multas_valor !== 0
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/admin/resumo-quinzena", verificarToken, verificarAdmin, async (req, res) => {
  try {
    const { mes, ano, quinzena } = req.query;

    const planilha = await sql`
      SELECT spreadsheet_id FROM planilhas_quinzena
      WHERE mes = ${parseInt(mes)} AND ano = ${parseInt(ano)} AND quinzena = ${parseInt(quinzena)}
      LIMIT 1
    `;
    if (!planilha.length) {
      return res.status(404).json({ error: "Nenhum fechamento encontrado para este período." });
    }

    const { resumo } = await lerPlanilha(planilha[0].spreadsheet_id);

    const cabecalho = (resumo[1] || []).map(c =>
      String(c || "").trim().replace(/\n/g, " ").replace(/  +/g, " ")
    );
    const nomeIdx = cabecalho.indexOf("NOME");
    const linhas  = resumo.slice(2).filter(l => String(l[nomeIdx] || "").trim());

    const somaNum = colNome => {
      const idx = cabecalho.indexOf(colNome);
      return linhas.reduce((s, l) => s + num(idx >= 0 ? l[idx] : ""), 0);
    };

    res.json({
      entregadores:    linhas.length,
      total_geral:     moeda(somaNum("TOTAL A RECEBER")),
      total_geral_num: somaNum("TOTAL A RECEBER"),
      total_entregues: Math.round(somaNum("TOTAL ENTREGUES")),
      loggi:  { valor_num: somaNum("VALOR LOGGI"),  qtd: Math.round(somaNum("ENTREGUES NO PRAZO LOGGI")) },
      jt:     { valor_num: somaNum("VALOR J&T"),    qtd: Math.round(somaNum("ENTREGUES J&T")) },
      imile:  { valor_num: somaNum("VALOR IMILE"),  qtd: Math.round(somaNum("QTD IMILE")) },
      anjun:  { valor_num: somaNum("VALOR ANJUN"),  qtd: Math.round(somaNum("ENTREGUES NO PRAZO ANJUN")) },
      shopee: { valor_num: somaNum("VALOR SHOPEE"), qtd: Math.round(somaNum("PACOTES ENTREGUES SPX")) },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/admin/planilhas", verificarToken, verificarAdmin, async (req, res) => {
  const rows = await sql`
    SELECT * FROM planilhas_quinzena ORDER BY ano DESC, mes DESC, quinzena DESC
  `;
  res.json(rows);
});

app.post("/admin/planilhas", verificarToken, verificarAdmin, async (req, res) => {
  const { mes, ano, quinzena, spreadsheet_url } = req.body;
  const spreadsheet_id = extrairSpreadsheetId(spreadsheet_url);
  await sql`
    INSERT INTO planilhas_quinzena (mes, ano, quinzena, spreadsheet_id)
    VALUES (${parseInt(mes)}, ${parseInt(ano)}, ${parseInt(quinzena)}, ${spreadsheet_id})
    ON CONFLICT (mes, ano, quinzena)
    DO UPDATE SET spreadsheet_id = EXCLUDED.spreadsheet_id
  `;
  res.json({ success: true });
});

app.delete("/admin/planilhas/:id", verificarToken, verificarAdmin, async (req, res) => {
  await sql`DELETE FROM planilhas_quinzena WHERE id = ${req.params.id}`;
  res.json({ success: true });
});

app.get("/admin/historico", verificarToken, verificarAdmin, async (req, res) => {
  try {
    const { ano } = req.query;
    const planilhas = await sql`
      SELECT mes, quinzena, spreadsheet_id
      FROM planilhas_quinzena
      WHERE ano = ${parseInt(ano)}
      ORDER BY mes ASC, quinzena ASC
    `;
    if (!planilhas.length) return res.json([]);

    const resultados = await Promise.all(planilhas.map(async p => {
      try {
        const { resumo } = await lerPlanilha(p.spreadsheet_id);
        const cabecalho = (resumo[1] || []).map(c => String(c || "").trim().replace(/\n/g, " ").replace(/  +/g, " "));
        const nomeIdx   = cabecalho.indexOf("NOME");
        const linhas    = resumo.slice(2).filter(l => String(l[nomeIdx] || "").trim());
        const somaNum   = col => {
          const idx = cabecalho.indexOf(col);
          return linhas.reduce((s, l) => s + num(idx >= 0 ? l[idx] : ""), 0);
        };
        return {
          mes: p.mes, quinzena: p.quinzena,
          total_entregues: Math.round(somaNum("TOTAL ENTREGUES")),
          loggi:  { qtd: Math.round(somaNum("ENTREGUES NO PRAZO LOGGI")) },
          jt:     { qtd: Math.round(somaNum("ENTREGUES J&T")) },
          imile:  { qtd: Math.round(somaNum("QTD IMILE")) },
          anjun:  { qtd: Math.round(somaNum("ENTREGUES NO PRAZO ANJUN")) },
          shopee: { qtd: Math.round(somaNum("PACOTES ENTREGUES SPX")) },
        };
      } catch { return null; }
    }));

    res.json(resultados.filter(Boolean));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/historico", verificarToken, async (req, res) => {
  try {
    const { ano } = req.query;
    const nomeEntregador = req.user.username;

    const planilhas = await sql`
      SELECT mes, quinzena, spreadsheet_id
      FROM planilhas_quinzena
      WHERE ano = ${parseInt(ano)}
      ORDER BY mes ASC, quinzena ASC
    `;
    if (!planilhas.length) return res.json([]);

    const resultados = await Promise.all(planilhas.map(async p => {
      try {
        const { resumo } = await lerPlanilha(p.spreadsheet_id);
        const cabecalho = (resumo[1] || []).map(c => String(c || "").trim().replace(/\n/g, " ").replace(/  +/g, " "));
        const nomeIdx   = cabecalho.indexOf("NOME");
        const linha     = resumo.slice(2).find(l =>
          String(l[nomeIdx] || "").trim().toLowerCase() === nomeEntregador.toLowerCase()
        );
        if (!linha) return null;
        const get = col => { const i = cabecalho.indexOf(col); return i >= 0 ? String(linha[i] || "") : ""; };
        return {
          mes: p.mes, quinzena: p.quinzena,
          total_receber_num: num(get("TOTAL A RECEBER")),
          total_entregues:   Math.round(num(get("TOTAL ENTREGUES"))),
          entregues_loggi:   Math.round(num(get("ENTREGUES NO PRAZO LOGGI"))),
          entregues_jt:      Math.round(num(get("ENTREGUES J&T"))),
          qtd_imile:         Math.round(num(get("QTD IMILE"))),
          entregues_anjun:   Math.round(num(get("ENTREGUES NO PRAZO ANJUN"))),
          entregues_shopee:  Math.round(num(get("PACOTES ENTREGUES SPX"))),
        };
      } catch { return null; }
    }));

    res.json(resultados.filter(Boolean));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/test-db", async (req, res) => {
  try {
    const result = await sql`SELECT NOW()`;
    res.json({ success: true, serverTime: result[0] });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Servidor rodando na porta " + PORT));
