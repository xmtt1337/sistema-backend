require("dotenv").config();

const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const { google } = require("googleapis");
const { Pool } = require("pg");
const sql = require("./db");

const pgPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function bulkInsertPacotes(arquivoId, transportadora, pacotes) {
  const validos = pacotes.filter(p => p.codigo_barras || p.id_pacote);
  if (!validos.length) return 0;
  const CHUNK = 500;
  const client = await pgPool.connect();
  try {
    await client.query("BEGIN");
    for (let i = 0; i < validos.length; i += CHUNK) {
      const chunk = validos.slice(i, i + CHUNK);
      const placeholders = chunk.map((_, j) => {
        const b = j * 8;
        return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8})`;
      }).join(",");
      const values = chunk.flatMap(p => [
        arquivoId, transportadora,
        p.codigo_barras || null, p.id_pacote || null,
        p.cidade || null, p.regiao || null,
        p.cep || null, p.destinatario || null
      ]);
      await client.query(
        `INSERT INTO alimentar_pacotes
         (arquivo_id,transportadora,codigo_barras,id_pacote,cidade,regiao,cep,destinatario)
         VALUES ${placeholders}`,
        values
      );
    }
    await client.query("COMMIT");
    return validos.length;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

const ORIGENS_PERMITIDAS = [
  "https://xmtt1337.github.io",
  "http://localhost:5500",   // Live Server local
  "http://127.0.0.1:5500"
];

const app = express();
app.use(express.json({ limit: '50mb' }));
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

// Nomes excluídos de todos os resultados que vêm das planilhas
const NOMES_IGNORADOS = new Set([
  "lucas teixeira neto - curitibanos",
]);
function nomeIgnorado(nome) {
  return NOMES_IGNORADOS.has(normNome(nome));
}

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

    // ── ESQUEMA DE MATCH CHAVE PIX ──
    // 1. RESUMO (col NOME) = usuario do sistema ex: "Deinisi Vendramini Lima - Caçador"
    // 2. TERCEIRIZADOS col A (USUARIOS) = mesmo nome do sistema → col E (NOME) = nome real
    // 3. nome real bate com trampay_entregadores.nome → pega chave_pix e tipo_pix da Trampay
    // 4. documento vem da col DOCUMENTO do TERCEIRIZADOS

    const [{ resumo }, cadastroRows, trampayRows] = await Promise.all([
      lerPlanilha(planilha[0].spreadsheet_id),
      lerCadastroPix(),
      sql`SELECT nome, chave_pix, tipo_pix FROM trampay_entregadores`
    ]);

    // ── Planilha de fechamento ──
    const cabF = (resumo[1] || []).map(c => String(c || "").trim().replace(/\n/g, " ").replace(/  +/g, " "));
    const nomeIdxF  = cabF.indexOf("NOME");
    const totalIdxF = cabF.indexOf("TOTAL A RECEBER");
    if (nomeIdxF < 0) return res.status(500).json({ error: "Coluna NOME não encontrada na planilha de fechamento." });

    // ── Planilha TERCEIRIZADOS ──
    // Col A (USUARIOS) = nome do sistema | Col E (NOME) = nome real (igual ao da Trampay)
    let cabC = [], linhasC = [];
    for (let i = 0; i < Math.min(5, cadastroRows.length); i++) {
      if (cadastroRows[i]?.some(c => c && String(c).trim())) {
        cabC    = cadastroRows[i].map(c => String(c || "").trim().toUpperCase());
        linhasC = cadastroRows.slice(i + 1);
        break;
      }
    }
    const findCol    = (keys) => cabC.findIndex(c => keys.some(k => c.includes(k)));
    const usuarioIdx = findCol(["USUARIO", "USUARIOS"]);
    const nomeRealIdx= findCol(["NOME"]);
    const docIdx     = findCol(["DOCUMENTO", "CPF", "CNPJ", "DOC"]);

    // cadMap: usuario normalizado → { documento, nomeReal }
    const cadMap = {};
    linhasC.forEach(l => {
      const usuario = usuarioIdx >= 0 ? String(l[usuarioIdx] || "").trim() : "";
      if (!usuario) return;
      cadMap[normNome(usuario)] = {
        documento: docIdx      >= 0 ? String(l[docIdx]      || "").trim() : "",
        nomeReal:  nomeRealIdx >= 0 ? String(l[nomeRealIdx] || "").trim() : "",
      };
    });

    // trampayMap: nome real normalizado → { chave_pix, tipo_pix }
    function normBasico(s) {
      return String(s || "").trim()
        .normalize("NFD").replace(/[̀-ͯ]/g, "")
        .toLowerCase().replace(/\s+/g, " ");
    }
    const trampayMap = {};
    trampayRows.forEach(t => {
      trampayMap[normBasico(t.nome)] = { chave_pix: t.chave_pix || "", tipo_pix: t.tipo_pix || "" };
    });

    const result = resumo.slice(2)
      .map(l => {
        const nome = String(l[nomeIdxF] || "").trim();
        if (!nome || nomeIgnorado(nome)) return null;
        const totalNum = totalIdxF >= 0 ? num(String(l[totalIdxF] || "")) : 0;
        if (totalNum <= 0) return null;
        const cad      = cadMap[normNome(nome)] || {};
        const trampay  = trampayMap[normBasico(cad.nomeReal || nome)] || {};
        return {
          nome,
          total:     moeda(totalNum),
          total_num: totalNum,
          documento: cad.documento    || "",
          chave_pix: trampay.chave_pix || "",
          tipo_pix:  trampay.tipo_pix  || "",
        };
      })
      .filter(Boolean);

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/admin/pagamentos/csv", verificarToken, verificarAdmin, async (req, res) => {
  try {
    const { mes, ano, quinzena } = req.query;
    const planilha = await sql`
      SELECT spreadsheet_id FROM planilhas_quinzena
      WHERE mes = ${parseInt(mes)} AND ano = ${parseInt(ano)} AND quinzena = ${parseInt(quinzena)}
      LIMIT 1
    `;
    if (!planilha.length) return res.status(404).json({ error: "Nenhum fechamento encontrado para este período." });

    const [{ resumo }, cadastroRows, trampayRows] = await Promise.all([
      lerPlanilha(planilha[0].spreadsheet_id),
      lerCadastroPix(),
      sql`SELECT nome, id_externo, chave_pix, tipo_pix FROM trampay_entregadores`
    ]);

    const cabF      = (resumo[1] || []).map(c => String(c || "").trim().replace(/\n/g, " ").replace(/  +/g, " "));
    const nomeIdxF  = cabF.indexOf("NOME");
    const totalIdxF = cabF.indexOf("TOTAL A RECEBER");
    if (nomeIdxF < 0) return res.status(500).json({ error: "Coluna NOME não encontrada." });

    // ── Lê planilha TERCEIRIZADOS ──
    // Coluna "usuarios" (A) = nome do sistema (igual ao da planilha RESUMO)
    // Coluna "Nome" (E)     = nome real igual ao cadastrado na Trampay
    let cabC = [], linhasC = [];
    for (let i = 0; i < Math.min(5, cadastroRows.length); i++) {
      if (cadastroRows[i]?.some(c => c && String(c).trim())) {
        cabC    = cadastroRows[i].map(c => String(c || "").trim().toUpperCase());
        linhasC = cadastroRows.slice(i + 1);
        break;
      }
    }
    const findCol    = (keys) => cabC.findIndex(c => keys.some(k => c.includes(k)));
    const usuarioIdx = findCol(["USUARIO","USUARIOS"]);
    const nomeRealIdx= findCol(["NOME"]);
    const docIdx     = findCol(["DOCUMENTO","CPF","CNPJ","DOC"]);

    // cadMap: chave = usuario normalizado → { documento, nomeReal }
    const cadMap = {};
    linhasC.forEach(l => {
      const usuario = usuarioIdx >= 0 ? String(l[usuarioIdx] || "").trim() : "";
      if (!usuario) return;
      cadMap[normNome(usuario)] = {
        documento: docIdx      >= 0 ? String(l[docIdx]      || "").trim() : "",
        nomeReal:  nomeRealIdx >= 0 ? String(l[nomeRealIdx] || "").trim() : "",
      };
    });

    function normBasico(s) {
      return String(s || "").trim()
        .normalize("NFD").replace(/[̀-ͯ]/g, "")
        .toLowerCase().replace(/\s+/g, " ");
    }

    // trampayMap: chave = nome real normalizado → { id_externo, chave_pix, tipo_pix }
    const trampayMap = {};
    trampayRows.forEach(t => {
      trampayMap[normBasico(t.nome)] = {
        id_externo: t.id_externo || "",
        chave_pix:  t.chave_pix  || "",
        tipo_pix:   t.tipo_pix   || ""
      };
    });

    const MESES    = ["Janeiro","Fevereiro","Março","Abril","Maio","Junho","Julho","Agosto","Setembro","Outubro","Novembro","Dezembro"];
    const nomeMes  = MESES[(parseInt(mes) || 1) - 1] || "";
    const ordQ     = parseInt(quinzena) === 1 ? "primeira" : "segunda";
    const descricao = `Serviços prestados last mile ${ordQ} quinzena de ${nomeMes}`;

    const rows = resumo.slice(2).map(l => {
      const titulo = String(l[nomeIdxF] || "").trim();
      if (!titulo || nomeIgnorado(titulo)) return null;
      const totalNum = totalIdxF >= 0 ? num(String(l[totalIdxF] || "")) : 0;
      if (totalNum <= 0) return null;

      // Busca no TERCEIRIZADOS pelo nome do sistema → pega nomeReal e documento
      const cad        = cadMap[normNome(titulo)] || {};
      const nomeTrampay = cad.nomeReal || titulo;

      // Busca na Trampay pelo nomeReal
      const trampay = trampayMap[normBasico(nomeTrampay)] || {};

      return {
        titulo,
        documento:      cad.documento     || "",
        valor:          totalNum.toFixed(2).replace(".", ","),
        descricao,
        chave_pix:      trampay.chave_pix  || "",
        chave_pix_tipo: trampay.tipo_pix   || "",
        id:             trampay.id_externo || "",
      };
    }).filter(Boolean);

    const txt  = v => `"${String(v).replace(/"/g,'""')}"`;
    const num_ = v => v ? `="${String(v).replace(/"/g,'""')}"` : `""`;

    const header   = ["titulo","documento","valor","descricao","chave_pix","chave_pix_tipo","id"];
    const csvLines = [
      header.join(";"),
      ...rows.map(r => [
        txt(r.titulo),
        num_(r.documento),
        txt(r.valor),
        txt(r.descricao),
        num_(r.chave_pix),
        txt(r.chave_pix_tipo),
        num_(r.id),
      ].join(";"))
    ];

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="pagamentos_${mes}_${ano}_q${quinzena}.csv"`);
    res.send("﻿" + csvLines.join("\r\n"));
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
        if (!nome || nomeIgnorado(nome)) return null;
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
      SELECT mes, quinzena, spreadsheet_id, ignora_nf
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
          mes: p.mes, quinzena: p.quinzena, ignora_nf: p.ignora_nf || false,
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
      if (!nome || nomeIgnorado(nome)) return null;
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
    const { active, role } = req.body;
    if (role !== undefined) {
      const validRoles = ["admin", "finance", "sac", "user", "entregador"];
      if (!validRoles.includes(role)) return res.status(400).json({ error: "Role inválido." });
      await sql`UPDATE users SET role = ${role} WHERE id = ${id}`;
    }
    if (active !== undefined) {
      await sql`UPDATE users SET active = ${active} WHERE id = ${id}`;
    }
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

    let atualizados = 0, novos = 0;
    for (const e of entregadores) {
      if (!e.nome) continue;
      const existing = await sql`
        SELECT id FROM trampay_entregadores WHERE nome = ${e.nome}
      `;
      if (existing.length) {
        await sql`
          UPDATE trampay_entregadores
          SET documento    = ${e.documento      || null},
              id_externo   = ${e.id_externo     || null},
              chave_pix    = ${e.chave_pix      || null},
              tipo_pix     = ${e.chave_pix_tipo || null},
              data_criacao = ${e.data_criacao   || null},
              updated_at   = NOW()
          WHERE nome = ${e.nome}
        `;
        atualizados++;
      } else {
        await sql`
          INSERT INTO trampay_entregadores (nome, documento, id_externo, chave_pix, tipo_pix, data_criacao)
          VALUES (${e.nome}, ${e.documento || null}, ${e.id_externo || null},
                  ${e.chave_pix || null}, ${e.chave_pix_tipo || null}, ${e.data_criacao || null})
        `;
        novos++;
      }
    }
    res.json({ success: true, atualizados, novos });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/admin/trampay/entregadores", verificarToken, verificarAdmin, async (req, res) => {
  try {
    const rows = await sql`
      SELECT id, nome, documento, id_externo, chave_pix, tipo_pix, data_criacao,
             (SELECT MAX(updated_at) FROM trampay_entregadores) AS last_import
      FROM trampay_entregadores
      ORDER BY nome ASC
    `;
    res.json(rows);
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

function verificarNaoEntregador(req, res, next) {
  if (req.user.role === 'entregador') return res.status(403).json({ error: 'Acesso negado' });
  next();
}

// ───── ALIMENTAR ─────

app.get("/alimentar/arquivos", verificarToken, verificarNaoEntregador, async (req, res) => {
  try {
    const { transportadora } = req.query;
    const rows = transportadora
      ? await sql`SELECT id, transportadora, nome_arquivo, mime_type, tamanho_bytes, uploaded_at FROM alimentar_arquivos WHERE transportadora = ${transportadora} ORDER BY uploaded_at DESC`
      : await sql`SELECT id, transportadora, nome_arquivo, mime_type, tamanho_bytes, uploaded_at FROM alimentar_arquivos ORDER BY transportadora, uploaded_at DESC`;
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/alimentar/upload", verificarToken, verificarNaoEntregador, async (req, res) => {
  try {
    const { transportadora, nome_arquivo, conteudo_base64, mime_type, pacotes } = req.body;
    if (!transportadora || !nome_arquivo || !conteudo_base64)
      return res.status(400).json({ error: "Dados incompletos." });
    const validas = ['loggi', 'anjun', 'jt', 'imile'];
    if (!validas.includes(transportadora))
      return res.status(400).json({ error: "Transportadora inválida." });
    const tamanho_bytes = Math.round(conteudo_base64.length * 0.75);
    // Remove arquivo anterior da mesma transportadora (um por transportadora)
    const existentes = await sql`SELECT id FROM alimentar_arquivos WHERE transportadora = ${transportadora}`;
    for (const e of existentes) {
      await sql`DELETE FROM alimentar_pacotes WHERE arquivo_id = ${e.id}`;
      await sql`DELETE FROM alimentar_arquivos WHERE id = ${e.id}`;
    }

    const rows = await sql`
      INSERT INTO alimentar_arquivos (transportadora, nome_arquivo, conteudo_base64, mime_type, tamanho_bytes, uploaded_by)
      VALUES (${transportadora}, ${nome_arquivo}, ${conteudo_base64}, ${mime_type || null}, ${tamanho_bytes}, ${req.user.id})
      RETURNING id, transportadora, nome_arquivo, mime_type, tamanho_bytes, uploaded_at
    `;
    const arquivoId = rows[0].id;
    const pacotes_inseridos = Array.isArray(pacotes) && pacotes.length
      ? await bulkInsertPacotes(arquivoId, transportadora, pacotes)
      : 0;
    res.json({ success: true, arquivo: rows[0], pacotes_inseridos });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/alimentar/download/:id", verificarToken, verificarNaoEntregador, async (req, res) => {
  try {
    const rows = await sql`SELECT nome_arquivo, conteudo_base64, mime_type FROM alimentar_arquivos WHERE id = ${parseInt(req.params.id)}`;
    if (!rows.length) return res.status(404).json({ error: "Arquivo não encontrado" });
    const { nome_arquivo, conteudo_base64, mime_type } = rows[0];
    const buffer = Buffer.from(conteudo_base64, 'base64');
    res.setHeader('Content-Type', mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(nome_arquivo)}"`);
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/alimentar/:id", verificarToken, verificarNaoEntregador, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    await sql`DELETE FROM alimentar_pacotes WHERE arquivo_id = ${id}`;
    await sql`DELETE FROM alimentar_arquivos WHERE id = ${id}`;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ───── BIPAGENS ─────

const CEP_SHEET_ID = "1igX7HiJSM8v9VjvbO4ZeXPo8U062xOMKyBFjK9K4XU8";

let _cepCache    = null;
let _cepCacheAt  = 0;
const CEP_CACHE_TTL = 5 * 60 * 1000;

async function lerTodasAbasCeps() {
  if (_cepCache && Date.now() - _cepCacheAt < CEP_CACHE_TTL) return _cepCache;

  const creds  = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  const auth   = new google.auth.GoogleAuth({ credentials: creds, scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"] });
  const sheets = google.sheets({ version: "v4", auth });

  const meta = await sheets.spreadsheets.get({ spreadsheetId: CEP_SHEET_ID });
  const abas  = meta.data.sheets.map(s => s.properties.title);

  const resultado = [];
  const errosAbas = [];
  for (const aba of abas) {
    try {
      const r    = await sheets.spreadsheets.values.get({ spreadsheetId: CEP_SHEET_ID, range: `'${aba}'!A:Z` });
      const rows = r.data.values || [];
      if (rows.length < 2) { errosAbas.push(`${aba}: menos de 2 linhas`); continue; }

      // Procura a linha de cabeçalho nas primeiras 5 linhas
      let headerRowIdx = -1;
      let header = [];
      for (let r = 0; r < Math.min(5, rows.length); r++) {
        const h = rows[r].map(c => String(c || "").trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, ""));
        if (h.some(c => c === "cep" || c.startsWith("cep"))) {
          headerRowIdx = r;
          header = h;
          break;
        }
      }
      if (headerRowIdx < 0) {
        errosAbas.push(`${aba}: cabeçalho CEP não encontrado nas 5 primeiras linhas. Linha 1: [${rows[0].join("|")}]`);
        continue;
      }

      const cepIdx = header.findIndex(h => h === "cep" || h.startsWith("cep"));
      const entIdx = header.findIndex(h => h.includes("entregador"));
      const cidIdx = header.findIndex(h => h.includes("cidade"));
      const baiIdx = header.findIndex(h => h.includes("bairro"));
      const ruaIdx = header.findIndex(h => h.includes("rua"));
      const sigIdx = header.findIndex(h => h.includes("sigla"));

      for (let i = headerRowIdx + 1; i < rows.length; i++) {
        const row = rows[i];
        if (row.some(c => String(c).includes("#REF"))) continue;
        const cep = String(row[cepIdx] || "").replace(/\D/g, "");
        if (cep.length < 5) continue;
        resultado.push({
          cep,
          entregador: entIdx >= 0 ? String(row[entIdx] || "").trim() : "",
          cidade:     cidIdx >= 0 ? String(row[cidIdx] || "").trim() : "",
          bairro:     baiIdx >= 0 ? String(row[baiIdx] || "").trim() : "",
          rua:        ruaIdx >= 0 ? String(row[ruaIdx] || "").trim() : "",
          sigla:      sigIdx >= 0 ? String(row[sigIdx] || "").trim() : "",
          aba,
        });
      }
    } catch (err) {
      errosAbas.push(`${aba}: ${err.message}`);
    }
  }
  if (errosAbas.length) console.warn("Abas com erro no sync:", errosAbas);

  resultado._erros  = errosAbas;
  _cepCache   = resultado;
  _cepCacheAt = Date.now();
  return resultado;
}

function normalizarAba(aba) {
  const s = String(aba).toLowerCase().trim();
  if (s.includes("loggi"))  return "loggi";
  if (s.includes("anjun"))  return "anjun";
  if (s.includes("j&t") || s.includes("jt")) return "jt";
  if (s.includes("imile"))  return "imile";
  if (s.includes("shopee")) return "shopee";
  return aba;
}

async function buscarEntregadorPorCep(cep, transportadora) {
  try {
    const cepNorm = String(cep).replace(/\D/g, "").padStart(8, "0");

    // Tenta primeiro no banco (rápido)
    const total = await sql`SELECT COUNT(*) AS n FROM cep_entregadores`;
    if (parseInt(total[0].n) > 0) {
      const rows = transportadora
        ? await sql`SELECT * FROM cep_entregadores WHERE cep = ${cepNorm} AND transportadora = ${transportadora} LIMIT 1`
        : await sql`SELECT * FROM cep_entregadores WHERE cep = ${cepNorm} LIMIT 1`;
      if (rows[0]) return rows[0];
    }

    // Fallback: busca direto na planilha (mais lento, usado antes do sync)
    const linhas = await lerTodasAbasCeps();
    const candidatos = transportadora
      ? linhas.filter(l => normalizarAba(l.aba) === transportadora)
      : linhas;
    const match = candidatos.find(l => l.cep.padStart(8, "0") === cepNorm);
    if (!match) return null;
    return { ...match, transportadora: normalizarAba(match.aba) };
  } catch (err) {
    console.error("Erro ao buscar CEP:", err.message);
    return null;
  }
}

app.post("/bipagem/registrar", verificarToken, verificarNaoEntregador, async (req, res) => {
  try {
    const { codigo, entregador, transportadora, cidade, cep } = req.body;
    if (!codigo) return res.status(400).json({ error: "Código obrigatório." });
    const usuario_nome = req.user.name || req.user.username || null;
    await sql`
      INSERT INTO bipagens_log (codigo, entregador, transportadora, cidade, cep, user_id, usuario_nome)
      VALUES (${codigo}, ${entregador || null}, ${transportadora || null}, ${cidade || null}, ${cep || null}, ${req.user.id}, ${usuario_nome})
    `;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/bipagem/buscar-cep", verificarToken, verificarNaoEntregador, async (req, res) => {
  try {
    const { cep } = req.query;
    if (!cep) return res.status(400).json({ error: "CEP não informado." });
    const cepNorm = String(cep).replace(/\D/g, "").padStart(8, "0");

    let rows = await sql`
      SELECT entregador, cidade, bairro, rua, sigla, transportadora
      FROM cep_entregadores
      WHERE cep = ${cepNorm}
      ORDER BY transportadora
    `;

    // Fallback planilha se banco vazio
    if (!rows.length) {
      const linhas = await lerTodasAbasCeps();
      const matches = linhas.filter(l => l.cep.padStart(8, "0") === cepNorm);
      rows = matches.map(l => ({ ...l, transportadora: normalizarAba(l.aba) }));
    }

    if (!rows.length) return res.status(404).json({ error: "CEP não encontrado em nenhuma transportadora." });
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/bipagem/cep-status", verificarToken, verificarNaoEntregador, async (req, res) => {
  try {
    const r = await sql`SELECT COUNT(*) AS total FROM cep_entregadores`;
    res.json({ total: parseInt(r[0].total) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/admin/sincronizar-ceps", verificarToken, verificarAdmin, async (req, res) => {
  try {
    const linhas = await lerTodasAbasCeps();
    if (!linhas.length) return res.status(404).json({ error: "Nenhum dado encontrado na planilha." });

    const client = await pgPool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM cep_entregadores");
      const CHUNK = 500;
      for (let i = 0; i < linhas.length; i += CHUNK) {
        const chunk = linhas.slice(i, i + CHUNK);
        const placeholders = chunk.map((_, j) => {
          const b = j * 7;
          return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7})`;
        }).join(",");
        const values = chunk.flatMap(l => [
          l.cep.padStart(8, "0"),
          l.entregador    || null,
          l.cidade        || null,
          l.bairro        || null,
          l.rua           || null,
          l.sigla         || null,
          normalizarAba(l.aba)
        ]);
        await client.query(
          `INSERT INTO cep_entregadores (cep,entregador,cidade,bairro,rua,sigla,transportadora) VALUES ${placeholders}`,
          values
        );
      }
      await client.query("COMMIT");
      _cepCache = null;
      const porAba = linhas.reduce((acc, l) => {
        const k = normalizarAba(l.aba);
        acc[k] = (acc[k] || 0) + 1;
        return acc;
      }, {});
      res.json({ success: true, total: linhas.length, por_transportadora: porAba, erros: linhas._erros || [] });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/admin/debug-ceps", verificarToken, verificarAdmin, async (req, res) => {
  try {
    // Lê diretamente do Google Sheets e mostra estrutura de cada aba
    const creds  = JSON.parse(process.env.GOOGLE_CREDENTIALS);
    const auth   = new google.auth.GoogleAuth({ credentials: creds, scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"] });
    const sheets = google.sheets({ version: "v4", auth });
    const meta   = await sheets.spreadsheets.get({ spreadsheetId: CEP_SHEET_ID });
    const abas   = meta.data.sheets.map(s => s.properties.title);

    const resultado = [];
    for (const aba of abas) {
      try {
        const r    = await sheets.spreadsheets.values.get({ spreadsheetId: CEP_SHEET_ID, range: `'${aba}'!A1:Z5` });
        const rows = r.data.values || [];
        resultado.push({ aba, total_linhas: rows.length, primeiras_3: rows.slice(0, 3) });
      } catch (err) {
        resultado.push({ aba, erro: err.message });
      }
    }

    const porTransp = await sql`SELECT transportadora, COUNT(*) AS total FROM cep_entregadores GROUP BY transportadora ORDER BY transportadora`;
    res.json({ abas_sheets: resultado, banco: porTransp });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/bipagem/buscar", verificarToken, verificarNaoEntregador, async (req, res) => {
  try {
    const { codigo } = req.query;
    if (!codigo || !codigo.trim()) return res.status(400).json({ error: "Código não informado." });
    const c = codigo.trim();

    const rows = await sql`
      SELECT transportadora, codigo_barras, id_pacote, cidade, regiao, destinatario, cep
      FROM alimentar_pacotes
      WHERE UPPER(TRIM(codigo_barras)) = UPPER(${c})
         OR UPPER(TRIM(id_pacote))     = UPPER(${c})
      LIMIT 1
    `;

    if (!rows.length) {
      // Se tem 8 dígitos, pode ser CEP digitado direto — redireciona para busca por CEP
      const soDigitos = c.replace(/\D/g, "");
      if (soDigitos.length === 8) {
        const cepNorm = soDigitos.padStart(8, "0");
        let cepRows = await sql`
          SELECT entregador, cidade, bairro, rua, sigla, transportadora
          FROM cep_entregadores WHERE cep = ${cepNorm} ORDER BY transportadora
        `;
        if (!cepRows.length) {
          const linhas = await lerTodasAbasCeps();
          cepRows = linhas
            .filter(l => l.cep.padStart(8, "0") === cepNorm)
            .map(l => ({ ...l, transportadora: normalizarAba(l.aba) }));
        }
        if (cepRows.length) return res.json({ tipo: "cep", resultados: cepRows });
      }
      return res.status(404).json({ error: "Código não encontrado em nenhum arquivo alimentado." });
    }

    const p = rows[0];

    // Se o código tem 8 dígitos, sem cep e sem transportadora úteis,
    // é provável que foi salvo errado (CEP no lugar do barcode). Trata como CEP.
    const soDigitos = c.replace(/\D/g, "");
    if (soDigitos.length === 8 && !p.cep && !p.transportadora) {
      const cepNorm2 = soDigitos.padStart(8, "0");
      let cepRows = await sql`
        SELECT entregador, cidade, bairro, rua, sigla, transportadora
        FROM cep_entregadores WHERE cep = ${cepNorm2} ORDER BY transportadora
      `;
      if (!cepRows.length) {
        const linhas = await lerTodasAbasCeps();
        cepRows = linhas
          .filter(l => l.cep.padStart(8, "0") === cepNorm2)
          .map(l => ({ ...l, transportadora: normalizarAba(l.aba) }));
      }
      if (cepRows.length) return res.json({ tipo: "cep", resultados: cepRows });
    }

    let entregador = null;
    let cidadeMatch = p.cidade;
    let transpMatch = p.transportadora;
    let bairro = null, sigla = null, rua = null;

    if (p.cep) {
      const match = await buscarEntregadorPorCep(p.cep, p.transportadora);
      if (match) {
        if (match.entregador)     entregador  = match.entregador;
        if (match.cidade)         cidadeMatch = match.cidade;
        if (match.transportadora) transpMatch = match.transportadora;
        bairro = match.bairro || null;
        sigla  = match.sigla  || null;
        rua    = match.rua    || null;
      }
    }

    res.json({
      transportadora: transpMatch,
      cidade:         cidadeMatch,
      bairro,
      rua,
      sigla,
      cep:            p.cep,
      destinatario:   p.destinatario,
      entregador
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function initDB() {
  await sql`CREATE EXTENSION IF NOT EXISTS unaccent`;
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
  await sql`ALTER TABLE planilhas_quinzena ADD COLUMN IF NOT EXISTS ignora_nf BOOLEAN DEFAULT false`;
  await sql`
    UPDATE planilhas_quinzena SET ignora_nf = true
    WHERE spreadsheet_id IN (
      '18GBldV9YE0lQXxabIzsn0rAZq57F9h_MgeAnoBDloPk',
      '1XjmtzeSTxOuJvvsIkiaIF3XvPEC-k1fVTM9R9ZG5B9Y'
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS trampay_entregadores (
      id            SERIAL PRIMARY KEY,
      nome          TEXT NOT NULL,
      documento     TEXT,
      id_externo    TEXT,
      chave_pix     TEXT,
      tipo_pix      TEXT,
      data_criacao  TEXT,
      created_at    TIMESTAMP DEFAULT NOW(),
      updated_at    TIMESTAMP DEFAULT NOW()
    )
  `;
  await sql`CREATE TABLE IF NOT EXISTS seeds_run (seed_name TEXT PRIMARY KEY, ran_at TIMESTAMP DEFAULT NOW())`;
  await sql`
    CREATE TABLE IF NOT EXISTS alimentar_pacotes (
      id              SERIAL PRIMARY KEY,
      arquivo_id      INTEGER NOT NULL,
      transportadora  TEXT NOT NULL,
      codigo_barras   TEXT,
      id_pacote       TEXT,
      cidade          TEXT,
      regiao          TEXT,
      cep             TEXT,
      destinatario    TEXT,
      created_at      TIMESTAMP DEFAULT NOW()
    )
  `;
  await sql`ALTER TABLE alimentar_pacotes ADD COLUMN IF NOT EXISTS cep TEXT`;
  await sql`
    CREATE TABLE IF NOT EXISTS cep_entregadores (
      id             SERIAL PRIMARY KEY,
      cep            TEXT NOT NULL,
      entregador     TEXT,
      cidade         TEXT,
      bairro         TEXT,
      rua            TEXT,
      sigla          TEXT,
      transportadora TEXT
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_cep_ent ON cep_entregadores(cep)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_alim_pac_barcode ON alimentar_pacotes (UPPER(codigo_barras))`;
  await sql`
    CREATE TABLE IF NOT EXISTS bipagens_log (
      id              SERIAL PRIMARY KEY,
      codigo          TEXT NOT NULL,
      entregador      TEXT,
      transportadora  TEXT,
      cidade          TEXT,
      cep             TEXT,
      user_id         INTEGER,
      bipado_em       TIMESTAMP DEFAULT NOW()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_bip_log_em ON bipagens_log (bipado_em DESC)`;
  await sql`ALTER TABLE bipagens_log ADD COLUMN IF NOT EXISTS usuario_nome TEXT`;
  await sql`CREATE INDEX IF NOT EXISTS idx_alim_pac_idpac ON alimentar_pacotes (UPPER(id_pacote))`;
  await sql`
    CREATE TABLE IF NOT EXISTS alimentar_arquivos (
      id              SERIAL PRIMARY KEY,
      transportadora  TEXT NOT NULL,
      nome_arquivo    TEXT NOT NULL,
      conteudo_base64 TEXT NOT NULL,
      mime_type       TEXT,
      tamanho_bytes   INTEGER,
      uploaded_by     INTEGER,
      uploaded_at     TIMESTAMP DEFAULT NOW()
    )
  `;

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
