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
    if (user[0].active === false) {
      return res.json({ success: false, inativo: true });
    }
    const token = jwt.sign(
      { id: user[0].id, username: user[0].username, name: user[0].name, role: user[0].role },
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

function normNome(s) {
  return String(s || "").trim()
    .replace(/[–—−‑]/g, "-")
    .replace(/\s*-\s*/g, " - ")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

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

const CADASTRO_PIX_ID = "1Udt_neQUNYHWFmndFHU7evg5fG62Ueh82aWUG8-l8xI";

async function lerCadastroPix() {
  const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  const auth  = new google.auth.GoogleAuth({ credentials: creds, scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"] });
  const sheets = google.sheets({ version: "v4", auth });
  const r = await sheets.spreadsheets.values.get({ spreadsheetId: CADASTRO_PIX_ID, range: "TERCEIRIZADOS!A:Z" });
  return r.data.values || [];
}

app.get("/admin/pagamentos", verificarToken, verificarAdmin, async (req, res) => {
  try {
    const { mes, ano, quinzena } = req.query;
    const planilha = await sql`
      SELECT spreadsheet_id FROM planilhas_quinzena
      WHERE mes = ${parseInt(mes)} AND ano = ${parseInt(ano)} AND quinzena = ${parseInt(quinzena)}
      LIMIT 1
    `;
    if (!planilha.length) return res.status(404).json({ error: "Nenhum fechamento encontrado para este período." });

    const [{ resumo }, cadastroRows] = await Promise.all([
      lerPlanilha(planilha[0].spreadsheet_id),
      lerCadastroPix()
    ]);

    // ── Planilha de fechamento ──
    const cabF = (resumo[1] || []).map(c => String(c || "").trim().replace(/\n/g, " ").replace(/  +/g, " "));
    const nomeIdxF  = cabF.indexOf("NOME");
    const totalIdxF = cabF.indexOf("TOTAL A RECEBER");
    if (nomeIdxF < 0) return res.status(500).json({ error: "Coluna NOME não encontrada na planilha de fechamento." });

    // ── Planilha de cadastro PIX ──
    // Encontra a linha de cabeçalho (primeira linha não vazia)
    let cabC = [], linhasC = [];
    for (let i = 0; i < Math.min(5, cadastroRows.length); i++) {
      if (cadastroRows[i]?.some(c => c && String(c).trim())) {
        cabC   = cadastroRows[i].map(c => String(c || "").trim().toUpperCase());
        linhasC = cadastroRows.slice(i + 1);
        break;
      }
    }
    const findCol = (keys) => cabC.findIndex(c => keys.some(k => c.includes(k)));
    const nomeIdxC = findCol(["USUARIO", "USUARIOS", "NOME", "ENTREGADOR"]);
    const docIdx   = findCol(["DOCUMENTO", "CPF", "CNPJ", "DOC"]);
    const pixIdx   = findCol(["CHAVE PIX", "CHAVE_PIX", "CHAVEPIX", "PIX"]);
    const tipoIdx  = findCol(["TIPO CHAVE", "TIPO PIX", "TIPO"]);

    const cadMap = {};
    linhasC.forEach(l => {
      const nome = nomeIdxC >= 0 ? String(l[nomeIdxC] || "").trim() : "";
      if (!nome) return;
      cadMap[normNome(nome)] = {
        documento: docIdx  >= 0 ? String(l[docIdx]  || "").trim() : "",
        chave_pix: pixIdx  >= 0 ? String(l[pixIdx]  || "").trim() : "",
        tipo_pix:  tipoIdx >= 0 ? String(l[tipoIdx] || "").trim() : "",
      };
    });

    const result = resumo.slice(2)
      .map(l => {
        const nome = String(l[nomeIdxF] || "").trim();
        if (!nome) return null;
        const totalNum = totalIdxF >= 0 ? num(String(l[totalIdxF] || "")) : 0;
        if (totalNum <= 0) return null;
        const cad = cadMap[normNome(nome)] || {};
        return { nome, total: moeda(totalNum), total_num: totalNum, ...cad };
      })
      .filter(Boolean);

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/painel", verificarToken, async (req, res) => {
  try {
    const { mes, ano, quinzena } = req.query;
    const nomeEntregador = req.user.name || req.user.username;

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

    const totalIdx        = cabecalho.indexOf("TOTAL A RECEBER");
    const entreguesIdx    = cabecalho.indexOf("TOTAL ENTREGUES");
    const loggiIdx        = cabecalho.indexOf("ENTREGUES NO PRAZO LOGGI");
    const jtIdx           = cabecalho.indexOf("ENTREGUES J&T");
    const imileIdx        = cabecalho.indexOf("QTD IMILE");
    const anjunIdx        = cabecalho.indexOf("ENTREGUES NO PRAZO ANJUN");
    const shopeeIdx       = cabecalho.indexOf("PACOTES ENTREGUES SPX");

    const col = (l, idx) => idx >= 0 ? (Math.round(num(String(l[idx] || ""))) || 0) : 0;

    const entregadores = linhas
      .map(l => {
        const nome = String(l[nomeIdx] || "").trim();
        if (!nome) return null;
        const totalNum = totalIdx >= 0 ? num(String(l[totalIdx] || "")) : 0;
        return {
          nome,
          total_receber:     moeda(totalNum),
          total_receber_num: totalNum,
          total_entregues:   col(l, entreguesIdx),
          qtd_loggi:         col(l, loggiIdx),
          qtd_jt:            col(l, jtIdx),
          qtd_imile:         col(l, imileIdx),
          qtd_anjun:         col(l, anjunIdx),
          qtd_shopee:        col(l, shopeeIdx),
        };
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
    const nomeEntregador = req.user.name || req.user.username;

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

app.get("/admin/conferencia", verificarToken, verificarAdmin, async (req, res) => {
  try {
    const { mes, ano, quinzena } = req.query;

    const planilha = await sql`
      SELECT spreadsheet_id FROM planilhas_quinzena
      WHERE mes = ${parseInt(mes)} AND ano = ${parseInt(ano)} AND quinzena = ${parseInt(quinzena)}
      LIMIT 1
    `;
    if (!planilha.length) return res.status(404).json({ error: "Nenhum fechamento encontrado para este período." });

    const [{ resumo }, cadastroRows] = await Promise.all([
      lerPlanilha(planilha[0].spreadsheet_id),
      lerCadastroPix()
    ]);

    const cabecalho = (resumo[1] || []).map(c => String(c || "").trim().replace(/\n/g, " ").replace(/  +/g, " "));
    const linhas    = resumo.slice(2);
    const nomeIdx   = cabecalho.indexOf("NOME");
    const totalIdx  = cabecalho.indexOf("TOTAL A RECEBER");
    if (nomeIdx < 0) return res.status(500).json({ error: "Coluna NOME não encontrada." });

    // ── Mapa de telefone da planilha de cadastro ──
    let cabC = [], linhasC = [];
    for (let i = 0; i < Math.min(5, cadastroRows.length); i++) {
      if (cadastroRows[i]?.some(c => c && String(c).trim())) {
        cabC    = cadastroRows[i].map(c => String(c || "").trim().toUpperCase());
        linhasC = cadastroRows.slice(i + 1);
        break;
      }
    }
    const findColC = (keys) => cabC.findIndex(c => keys.some(k => c.includes(k)));
    const nomeIdxC = findColC(["USUARIO", "USUARIOS", "NOME", "ENTREGADOR"]);
    const telIdx   = findColC(["TELEFONE", "CELULAR", "FONE", "WHATSAPP", "TEL"]);

    const cadTelMap = {};
    linhasC.forEach(l => {
      const nome = nomeIdxC >= 0 ? String(l[nomeIdxC] || "").trim() : "";
      if (!nome) return;
      cadTelMap[normNome(nome)] = telIdx >= 0 ? String(l[telIdx] || "").trim() : "";
    });

    // NFs ativas para o período (mais recente por entregador)
    const nfRows = await sql`
      SELECT DISTINCT ON (nf.user_id) nf.*, u.username, u.name AS user_name
      FROM notas_fiscais nf
      JOIN users u ON u.id = nf.user_id
      WHERE nf.mes = ${parseInt(mes)} AND nf.ano = ${parseInt(ano)} AND nf.quinzena = ${parseInt(quinzena)}
        AND (nf.deleted IS NULL OR nf.deleted = FALSE)
      ORDER BY nf.user_id, nf.id DESC
    `;
    const nfByName = {};
    nfRows.forEach(nf => { nfByName[normNome(nf.user_name || nf.username)] = nf; });

    const result = linhas.map(l => {
      const nome = String(l[nomeIdx] || "").trim();
      if (!nome) return null;
      const totalNum = totalIdx >= 0 ? num(String(l[totalIdx] || "")) : 0;
      const nf = nfByName[normNome(nome)] || null;
      let status = null;
      if (nf && totalNum > 0) {
        const nfNum = parseFloat(String(nf.valor || "").replace(/[R$\s.]/g, "").replace(",", ".")) || 0;
        if (nfNum > 0) status = Math.abs(nfNum - totalNum) < 0.02 ? "confere" : "diverge";
      }
      return {
        nome,
        total_receber: moeda(totalNum),
        total_receber_num: totalNum,
        emitiu_nf: !!nf,
        valor_nf: nf ? nf.valor : null,
        status,
        telefone: cadTelMap[normNome(nome)] || ""
      };
    }).filter(Boolean);

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/admin/notas", verificarToken, verificarAdmin, async (req, res) => {
  try {
    const { mes, ano, quinzena } = req.query;
    const rows = await sql`
      SELECT DISTINCT ON (nf.user_id) nf.*, u.username, u.name AS user_name
      FROM notas_fiscais nf
      JOIN users u ON u.id = nf.user_id
      WHERE nf.mes = ${parseInt(mes)} AND nf.ano = ${parseInt(ano)} AND nf.quinzena = ${parseInt(quinzena)}
        AND (nf.deleted IS NULL OR nf.deleted = FALSE)
      ORDER BY nf.user_id, nf.id DESC
    `;
    const result = rows.map(nf => {
      let status = nf.status;
      if (!status && nf.valor_fechamento && nf.valor) {
        const nfNum = parseFloat(String(nf.valor).replace(/[R$\s]/g, "").replace(/\./g, "").replace(",", ".")) || 0;
        const diff  = Math.abs(nfNum - parseFloat(nf.valor_fechamento));
        status = diff < 0.02 ? "confere" : "diverge";
      }
      return { ...nf, status };
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/minhas-notas", verificarToken, async (req, res) => {
  try {
    const rows = await sql`
      SELECT id, mes, ano, quinzena, emissao, cnpj, emissor, valor, tomador,
             status, numero_nf, chave_acesso, valor_fechamento
      FROM notas_fiscais
      WHERE user_id = ${req.user.id}
        AND (deleted IS NULL OR deleted = FALSE)
      ORDER BY ano DESC, mes DESC, quinzena DESC
    `;
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/nota", verificarToken, async (req, res) => {
  try {
    const { mes, ano, quinzena } = req.query;
    const rows = await sql`
      SELECT * FROM notas_fiscais
      WHERE user_id = ${req.user.id} AND mes = ${parseInt(mes)} AND ano = ${parseInt(ano)} AND quinzena = ${parseInt(quinzena)}
        AND (deleted IS NULL OR deleted = FALSE)
      ORDER BY id DESC
      LIMIT 1
    `;
    rows.length ? res.json(rows[0]) : res.status(404).json({ error: "Nenhuma nota encontrada" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/nota", verificarToken, async (req, res) => {
  try {
    const { mes, ano, quinzena, emissao, cnpj, emissor, valor, tomador,
            status, numero_nf, chave_acesso, valor_fechamento } = req.body;
    const vf = valor_fechamento ? parseFloat(valor_fechamento) : null;
    await sql`
      INSERT INTO notas_fiscais (user_id, mes, ano, quinzena, emissao, cnpj, emissor, valor, tomador,
                                 status, numero_nf, chave_acesso, valor_fechamento, deleted)
      VALUES (${req.user.id}, ${parseInt(mes)}, ${parseInt(ano)}, ${parseInt(quinzena)},
              ${emissao}, ${cnpj}, ${emissor}, ${valor}, ${tomador},
              ${status || null}, ${numero_nf || null}, ${chave_acesso || null}, ${vf}, FALSE)
    `;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/nota/verificar", verificarToken, async (req, res) => {
  try {
    const { chave_acesso, mes, ano, quinzena } = req.query;
    if (!chave_acesso) return res.json({ duplicata: false });
    const rows = await sql`
      SELECT nf.mes, nf.ano, nf.quinzena, u.username, u.name AS user_name
      FROM notas_fiscais nf
      JOIN users u ON u.id = nf.user_id
      WHERE nf.chave_acesso = ${chave_acesso}
        AND (nf.deleted IS NULL OR nf.deleted = FALSE)
        AND NOT (nf.user_id = ${req.user.id}
             AND nf.mes      = ${parseInt(mes)}
             AND nf.ano      = ${parseInt(ano)}
             AND nf.quinzena = ${parseInt(quinzena)})
    `;
    if (rows.length) {
      const r = rows[0];
      const meses = ["","Janeiro","Fevereiro","Março","Abril","Maio","Junho","Julho","Agosto","Setembro","Outubro","Novembro","Dezembro"];
      const detalhe = `${r.user_name || r.username} — ${r.quinzena}ª quinzena de ${meses[r.mes]}/${r.ano}`;
      res.json({ duplicata: true, detalhe });
    } else {
      res.json({ duplicata: false });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ───── ADMIN USUÁRIOS ─────
app.get("/admin/usuarios", verificarToken, verificarAdmin, async (req, res) => {
  try {
    const { role } = req.query;
    const rows = role
      ? await sql`SELECT id, username, name, role, COALESCE(active, TRUE) AS active FROM users WHERE role = ${role} ORDER BY name, username`
      : await sql`SELECT id, username, name, role, COALESCE(active, TRUE) AS active FROM users ORDER BY role, name, username`;
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/admin/usuarios", verificarToken, verificarAdmin, async (req, res) => {
  try {
    const { name, password, role } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: "O nome do entregador é obrigatório." });
    const senha = (password || "").trim() || process.env.DEFAULT_PASSWORD || "GC2026";
    let username;
    for (let i = 0; i < 10; i++) {
      const candidate = "GC" + String(Math.floor(1000000 + Math.random() * 9000000));
      const existing = await sql`SELECT id FROM users WHERE username = ${candidate}`;
      if (!existing.length) { username = candidate; break; }
    }
    if (!username) return res.status(500).json({ error: "Não foi possível gerar um ID único. Tente novamente." });
    const rows = await sql`
      INSERT INTO users (username, name, password, role, active)
      VALUES (${username}, ${name.trim()}, ${senha}, ${role || "entregador"}, TRUE)
      RETURNING id, username, name, role, active
    `;
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch("/admin/usuarios/:id", verificarToken, verificarAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (id === req.user.id) return res.status(400).json({ error: "Não é possível alterar sua própria conta." });
    const { active } = req.body;
    await sql`UPDATE users SET active = ${active} WHERE id = ${id}`;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put("/admin/usuarios/:id/reset-senha", verificarToken, verificarAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    await sql`UPDATE users SET password = ${process.env.DEFAULT_PASSWORD || "GC2026"} WHERE id = ${id}`;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put("/admin/usuarios/reset-todas-senhas", verificarToken, verificarAdmin, async (req, res) => {
  try {
    const result = await sql`
      UPDATE users SET password = ${process.env.DEFAULT_PASSWORD || "GC2026"}
      WHERE role = 'entregador'
    `;
    res.json({ success: true, total: result.count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/admin/trampay/importar", verificarToken, verificarAdmin, async (req, res) => {
  try {
    const { entregadores } = req.body;
    if (!Array.isArray(entregadores) || !entregadores.length)
      return res.status(400).json({ error: "Nenhum entregador no CSV." });

    let atualizados = 0;
    for (const e of entregadores) {
      if (!e.nome) continue;
      const result = await sql`
        UPDATE users
        SET documento     = ${e.documento     || null},
            id_externo    = ${e.id_externo    || null},
            chave_pix     = ${e.chave_pix     || null},
            tipo_pix      = ${e.chave_pix_tipo|| null}
        WHERE role = 'entregador'
          AND LOWER(UNACCENT(name)) = LOWER(UNACCENT(${e.nome}))
      `;
      if (result.count > 0) atualizados++;
    }
    res.json({ success: true, atualizados });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/admin/usuarios/:id", verificarToken, verificarAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (id === req.user.id) return res.status(400).json({ error: "Não é possível deletar sua própria conta." });
    await sql`DELETE FROM users WHERE id = ${id}`;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/nota", verificarToken, async (req, res) => {
  try {
    const { mes, ano, quinzena } = req.query;
    await sql`
      UPDATE notas_fiscais SET deleted = TRUE
      WHERE user_id = ${req.user.id} AND mes = ${parseInt(mes)} AND ano = ${parseInt(ano)} AND quinzena = ${parseInt(quinzena)}
    `;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function initDB() {
  await sql`
    CREATE TABLE IF NOT EXISTS notas_fiscais (
      id            SERIAL PRIMARY KEY,
      user_id       INTEGER NOT NULL,
      mes           INTEGER NOT NULL,
      ano           INTEGER NOT NULL,
      quinzena      INTEGER NOT NULL,
      emissao       TEXT,
      cnpj          TEXT,
      emissor       TEXT,
      valor         TEXT,
      tomador       TEXT,
      status        TEXT,
      numero_nf     TEXT,
      chave_acesso  TEXT,
      created_at    TIMESTAMP DEFAULT NOW(),
      updated_at    TIMESTAMP DEFAULT NOW(),
      UNIQUE (user_id, mes, ano, quinzena)
    )
  `;
  await sql`ALTER TABLE notas_fiscais ADD COLUMN IF NOT EXISTS status          TEXT`;
  await sql`ALTER TABLE notas_fiscais ADD COLUMN IF NOT EXISTS numero_nf       TEXT`;
  await sql`ALTER TABLE notas_fiscais ADD COLUMN IF NOT EXISTS chave_acesso    TEXT`;
  await sql`ALTER TABLE notas_fiscais ADD COLUMN IF NOT EXISTS valor_fechamento NUMERIC`;
  await sql`ALTER TABLE notas_fiscais ADD COLUMN IF NOT EXISTS deleted BOOLEAN DEFAULT FALSE`;
  await sql`ALTER TABLE notas_fiscais DROP CONSTRAINT IF EXISTS notas_fiscais_user_id_mes_ano_quinzena_key`;
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT TRUE`;
  await sql`UPDATE users SET active = TRUE WHERE active IS NULL`;
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS name TEXT`;
  await sql`CREATE TABLE IF NOT EXISTS seeds_run (seed_name TEXT PRIMARY KEY, ran_at TIMESTAMP DEFAULT NOW())`;

  // ── Seed entregadores 2026 v1 ──
  const seedCheck = await sql`SELECT seed_name FROM seeds_run WHERE seed_name = 'entregadores_2026_v1'`;
  if (!seedCheck.length) {
    await sql`DELETE FROM users WHERE role = 'entregador'`;
    const defaultPwd = process.env.DEFAULT_PASSWORD || "GC2026";
    const nomes = [
      "Adaiane da Silva - Videira","Adilson da Silva - Monte Carlo","Alvaro de Freitas - Videira",
      "Anderson de Andrade - Catanduvas","Anderson dos Santos Dolberth - Teixeira",
      "Andre Luis Sima Peixoto - Tangará","Andre Luiz Camargo - Caçador","Andre Luiz Preto - Jaborá",
      "Andre Ricardo Veiga - Caçador","Andrei de Siqueira - Videira","Andressa de Cassia Muller - Caçador",
      "Andressa Zuíla de Britto - Treze Tílias","Brunna Thais Dallago - Videira","Bruno Teixeira - Teixeira",
      "Claudicir Gonçalves dos Santos - Capinzal","Cleiton de Lima Sozo - Ponte Alta do Norte",
      "Cleiton Locatelli - Caçador","Cleyton Carlin Pires - Caçador","Crenilson Alves - Fraiburgo",
      "Daniele Ferreira dos Santos Cordeiro - Caçador","Deinisi Vendramini Lima - Caçador",
      "Denisa Zago Meneguzzi - Iomere","Didio Moto Entrega - Concórdia","Diego Luan Pessoa - Caçador",
      "Dionas Carlos Moreira - Videira","Edson da Silva Pereira - Fraiburgo",
      "Elton Susin Rodrigues - Campos Novos","Emanuel Ronan Lazzari - Videira",
      "Ewerlly Aires Cabral - Videira","Ezequiel de Maria - Herval D Oeste",
      "Fabio Junior Padilha Dos Santos - Teixeira","Fernando Gregory Padilha - Videira",
      "Fernando Junges - Joaçaba","Franciele Aparecida Correa - Caçador",
      "Gabriel Alves dos Santos - Videira","Gabriel Henrique Gomes Brandino - Pinheiro Preto/Ibiam",
      "Gabriel Lopes de Abreu - Ouro","Giezi luiz palavro - Erval Velho",
      "Giovane Dobner Sentenario - Caçador","Giseli Cristina Aires - Videira",
      "Guilherme Morais de Oliveira - Caçador","Guilherme Pereira Da Silva - Caçador",
      "Igor Aires Cabral - Videira","Itamar Locatelli - Macieira","Jaison Ferreira Franca - FJ",
      "Jean - Fraiburgo","Jhuan Richard Mendonca - Videira","João Maria Augusto Dave - Monte Carlo",
      "Joao Vitor Alves dos Santos - Calmon","Jocelio Moreira de Souza Junior - Caçador",
      "Jonathan Pereira de Lima - Caçador","Karine Mattos da Rosa - Caçador",
      "Kaue Henrique Do Prado Dos Santos - Videira","Kelin Maiara dos Santos - Caçador",
      "Kelvin Roberto Toffolo - Teixeira","Kristian de Mello Barbosa - Fraiburgo",
      "Laercio - Taquara Verde","Leonardo Brusco - Caçador","Leonardo Reitel - Concórdia",
      "Leonardo Vanin - Videira","Luana de Fatima Almeida - Videira","Lucas Teixeira Neto",
      "Lucas Teixeira Neto - Curitibanos","Luiz Augusto da Rosa Granemann - Timbó Grande",
      "Luiz Carlos dos santos - Rio das Antas","Luiz Carlos Moreira - Caçador",
      "Luiz Ricardo Maurílio - Curitibanos","Maicon Antonio Ribeiro - Campos Novos",
      "Marcelo Alves da Silva - Videira","Márcio Luiz da Cruz - Teixeira",
      "Marcos Vinicius Hahn - Luiz RDA","Mauro Cesar - Caçador",
      "Natanael De Oliveira Da Silva - Videira","Patricia Alves Schons Guzzi - Videira",
      "Patricia Dias Martins Ribeiro - Santa Cecilia","Paulo Cesar Dave - Teixeira",
      "Pedro Henrique Arruda Macedo - Lages","Rachel Simone Meneguzzi Manenti - Arroio Trinta",
      "Rafael Comunello - Videira","Rafael Paizano Lourenço - Caçador",
      "Rafaela Moraes Carneiro - Teixeira","Renato da Silva - Videira",
      "Renato Gelson Coito de Borba - Fraiburgo","Riquelme Douglas Zipperer - Caçador",
      "Ronaldo Recalcatti - Campos Novos","Samuel Mendes Guimaraes - Caçador",
      "Sandro Santos de Souza - Água Doce","Sueli Luz de Lima - Caçador",
      "Teresinha Fatima Borga de Almeida - Salto Veloso","Thalisson Diego Rizzo - Lebon Régis",
      "Uillian Miotto - Videira","Victor Gabriel Pasternak - Caçador",
      "William Marcos Neres - Videira","William Rodrigues - Teixeira",
      "Gleison de Almeida","Victor Gleison - Videira","Adalberto Alves de Souza - Caçador",
      "Giancarlo da Silva - Herval","Nilton Cezar Nascimento - Fraiburgo",
      "Gabriel Antonio dos Santos - Capinzal","Cleivan Marcos Calvi - Catanduvas",
      "Salete Borchardt - Fraiburgo"
    ];
    const existingIds = new Set((await sql`SELECT username FROM users`).map(u => u.username));
    for (const name of nomes) {
      let username;
      do { username = "GC" + String(Math.floor(1000000 + Math.random() * 9000000)); }
      while (existingIds.has(username));
      existingIds.add(username);
      await sql`INSERT INTO users (username, name, password, role, active) VALUES (${username}, ${name}, ${defaultPwd}, 'entregador', TRUE)`;
    }
    await sql`INSERT INTO seeds_run (seed_name) VALUES ('entregadores_2026_v1')`;
    console.log("Seed entregadores_2026_v1 aplicado:", nomes.length, "entregadores.");
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Servidor rodando na porta " + PORT);
  initDB().catch(err => console.error("Erro ao inicializar tabelas:", err));
});
