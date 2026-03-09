"use strict";
const express = require("express");
const axios = require("axios");
const https = require("https");
const crypto = require("crypto");
const db = require("./database");
const multer = require("multer");

const app = express();
app.use(express.json());
const upload = multer({ storage: multer.memoryStorage() });

app.use(function(req, res, next) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

function parsePemEnv(value, label) {
  if (!value) { console.warn("[WARN] " + label + " nao definido."); return null; }
  let pem = value.trim();
  if (!pem.includes("-----BEGIN")) {
    try { pem = Buffer.from(pem, "base64").toString("utf8").trim(); } catch (e) { return null; }
  }
  pem = pem.replace(/\\n/g, "\n");
  const lines = pem.split("\n").map(function(l) { return l.trim(); }).filter(Boolean);
  return lines.join("\n") + "\n";
}

function criarAgent() {
  const cert = parsePemEnv(process.env.INTER_CERT, "INTER_CERT");
  const key = parsePemEnv(process.env.INTER_KEY, "INTER_KEY");
  if (!cert || !key) throw new Error("INTER_CERT ou INTER_KEY ausente.");
  return new https.Agent({ cert: cert, key: key, rejectUnauthorized: true });
}

async function gerarToken() {
  const clientId = process.env.INTER_CLIENT_ID;
  const clientSecret = process.env.INTER_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("Credenciais Inter ausentes.");
  const agent = criarAgent();
  const body = "client_id=" + encodeURIComponent(clientId) + "&client_secret=" + encodeURIComponent(clientSecret) + "&scope=extrato.read%20saldo.read&grant_type=client_credentials";
  const r = await axios.post("https://cdpj.partners.bancointer.com.br/oauth/v2/token", body, { httpsAgent: agent, headers: { "Content-Type": "application/x-www-form-urlencoded" }, timeout: 30000 });
  return r.data.access_token;
}

app.get("/health", function(req, res) {
  const v = { INTER_CLIENT_ID: !!process.env.INTER_CLIENT_ID, INTER_CLIENT_SECRET: !!process.env.INTER_CLIENT_SECRET, INTER_CERT: !!process.env.INTER_CERT, INTER_KEY: !!process.env.INTER_KEY };
  res.status(Object.values(v).every(Boolean) ? 200 : 500).json({ status: Object.values(v).every(Boolean) ? "ok" : "missing_vars", vars: v });
});

app.get("/debug-cert", function(req, res) {
  res.json({ cert_ok: !!parsePemEnv(process.env.INTER_CERT, "x"), key_ok: !!parsePemEnv(process.env.INTER_KEY, "x") });
});

app.get("/saldo", async function(req, res) {
  try {
    const token = await gerarToken();
    const r = await axios.get("https://cdpj.partners.bancointer.com.br/banking/v2/saldo", { httpsAgent: criarAgent(), headers: { Authorization: "Bearer " + token }, timeout: 30000 });
    res.json(r.data);
  } catch (e) { res.status(e.response ? e.response.status : 500).json({ error: e.message }); }
});

app.get("/extrato", async function(req, res) {
  try {
    const token = await gerarToken();
    const hoje = new Date();
    const fim = hoje.toISOString().split("T")[0];
    const ini = new Date(hoje.setDate(hoje.getDate() - 30)).toISOString().split("T")[0];
    const r = await axios.get("https://cdpj.partners.bancointer.com.br/banking/v2/extrato", { httpsAgent: criarAgent(), headers: { Authorization: "Bearer " + token }, params: { dataInicio: ini, dataFim: fim }, timeout: 30000 });
    res.json(r.data);
  } catch (e) { res.status(e.response ? e.response.status : 500).json({ error: e.message }); }
});

app.get("/sync", async function(req, res) {
  try {
    const token = await gerarToken();
    const hoje = new Date();
    const fim = hoje.toISOString().split("T")[0];
    const ini = new Date(hoje.setDate(hoje.getDate() - 30)).toISOString().split("T")[0];
    const r = await axios.get("https://cdpj.partners.bancointer.com.br/banking/v2/extrato", { httpsAgent: criarAgent(), headers: { Authorization: "Bearer " + token }, params: { dataInicio: ini, dataFim: fim }, timeout: 30000 });
    const tx = r.data.transacoes || [];
    let inseridas = 0;
    for (const t of tx) {
      const hash = crypto.createHash("sha256").update(t.dataEntrada + "|" + t.valor + "|" + t.descricao).digest("hex");
      db.run("INSERT OR IGNORE INTO transacoes (data,tipo_operacao,tipo_transacao,valor,descricao,hash) VALUES (?,?,?,?,?,?)", [t.dataEntrada, t.tipoOperacao, t.tipoTransacao, parseFloat(t.valor), t.descricao, hash], function(err) { if (!err && this.changes > 0) inseridas++; });
    }
    res.json({ message: "Sync concluido", total: tx.length, inseridas });
  } catch (e) { res.status(e.response ? e.response.status : 500).json({ error: e.message }); }
});

app.get("/transacoes", function(req, res) {
  db.all("SELECT * FROM transacoes ORDER BY data DESC", [], function(err, rows) {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// ================================================================
// CLINICORP
// ================================================================
const BASE = "https://api.clinicorp.com/rest/v1";
function cHeaders() {
  const u = process.env.CLINICORP_USER, t = process.env.CLINICORP_TOKEN;
  if (!u || !t) throw new Error("CLINICORP_USER/TOKEN ausente.");
  return { Authorization: "Basic " + Buffer.from(u + ":" + t).toString("base64"), "Content-Type": "application/json" };
}
function sid() { const id = process.env.CLINICORP_SUBSCRIBER; if (!id) throw new Error("CLINICORP_SUBSCRIBER ausente."); return id; }
function bid() { const id = process.env.CLINICORP_BUSINESS_ID; if (!id) throw new Error("CLINICORP_BUSINESS_ID nao configurado."); return id; }
async function cGet(path, params) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== null && v !== "") qs.append(k, v);
  const url = BASE + path + (qs.toString() ? "?" + qs.toString() : "");
  console.log("[CLINICORP] GET", url);
  return (await axios.get(url, { headers: cHeaders(), timeout: 30000 })).data;
}
let _profCache = null, _profCacheTs = 0;
async function getProfissionaisMap() {
  const now = Date.now();
  if (_profCache && now - _profCacheTs < 5 * 60 * 1000) return _profCache;
  try {
    const data = await cGet("/professional/list_all_professionals", { subscriber_id: sid() });
    const map = {};
    const list = Array.isArray(data) ? data : [];
    for (const p of list) { map[String(p.id)] = p.name || ""; }
    _profCache = map; _profCacheTs = now;
  } catch (e) { console.warn("[CLINICORP] Profissionais:", e.message); _profCache = {}; }
  return _profCache;
}

app.get("/clinicorp/health", function(req, res) {
  const v = { CLINICORP_USER: !!process.env.CLINICORP_USER, CLINICORP_TOKEN: !!process.env.CLINICORP_TOKEN, CLINICORP_SUBSCRIBER: !!process.env.CLINICORP_SUBSCRIBER, CLINICORP_BUSINESS_ID: !!process.env.CLINICORP_BUSINESS_ID };
  res.status(Object.values(v).every(Boolean) ? 200 : 500).json({ status: Object.values(v).every(Boolean) ? "ok" : "missing_vars", vars: v });
});

app.get("/clinicorp/pacientes", async function(req, res) {
  try {
    const { name, cpf, phone, email, patientId } = req.query;
    if (!name && !cpf && !phone && !email && !patientId) return res.status(400).json({ error: "Informe: name, cpf, phone ou patientId." });
    const data = await cGet("/patient/get", { subscriber_id: sid(), PatientId: patientId || undefined, Name: name || undefined, OtherDocumentId: cpf || undefined, Phone: phone || undefined, Email: email || undefined });
    if (!data || data.Error || data.error) return res.json([]);
    const result = Array.isArray(data) ? data : [data];
    res.json(result.filter(function(p) { return p && p.PatientId; }));
  } catch (err) { res.status(err.response ? err.response.status : 500).json({ error: err.message, detail: err.response ? err.response.data : null }); }
});

app.get("/clinicorp/pacientes/:patientId/agendamentos", async function(req, res) {
  try {
    const data = await cGet("/patient/list_appointments", { PatientId: req.params.patientId });
    res.json(Array.isArray(data) ? data : (data ? [data] : []));
  } catch (err) { res.status(err.response ? err.response.status : 500).json({ error: err.message }); }
});

app.get("/clinicorp/pacientes/:patientId/orcamentos", async function(req, res) {
  try {
    const data = await cGet("/patient/list_estimates", { subscriber_id: sid(), PatientId: req.params.patientId });
    res.json(Array.isArray(data) ? data : (data ? [data] : []));
  } catch (err) { res.status(err.response ? err.response.status : 500).json({ error: err.message }); }
});

app.get("/clinicorp/pagamentos", async function(req, res) {
  try {
    const { from, to, dateType } = req.query;
    if (!from || !to) return res.status(400).json({ error: "from e to obrigatorios." });
    const data = await cGet("/payment/list", { subscriber_id: sid(), from, to, date_type: dateType || undefined, include_total_amount: "X" });
    res.json(data);
  } catch (err) { res.status(err.response ? err.response.status : 500).json({ error: err.message, detail: err.response ? err.response.data : null }); }
});

app.get("/clinicorp/agendamentos", async function(req, res) {
  try {
    const { from, to, patientId, includeCanceled } = req.query;
    if (!from || !to) return res.status(400).json({ error: "from e to obrigatorios." });
    const [data, profMap] = await Promise.all([
      cGet("/appointment/list", { subscriber_id: sid(), from, to, businessId: bid(), patientId: patientId || undefined, includeCanceled: includeCanceled === "true" ? "true" : undefined }),
      getProfissionaisMap()
    ]);
    const lista = Array.isArray(data) ? data : (data ? [data] : []);
    res.json(lista.map(function(a) { return Object.assign({}, a, { ProfessionalName: profMap[String(a.Dentist_PersonId)] || "" }); }));
  } catch (err) { res.status(err.response ? err.response.status : 500).json({ error: err.message, detail: err.response ? err.response.data : null }); }
});

app.get("/clinicorp/procedimentos", async function(req, res) {
  try { res.json(await cGet("/procedures/list", {})); }
  catch (err) { res.status(err.response ? err.response.status : 500).json({ error: err.message }); }
});

app.get("/clinicorp/profissionais", async function(req, res) {
  try { res.json(await cGet("/professional/list_all_professionals", { subscriber_id: sid() })); }
  catch (err) { res.status(err.response ? err.response.status : 500).json({ error: err.message }); }
});

app.get("/clinicorp/receitas-especialidade", async function(req, res) {
  try {
    const { from, to } = req.query;
    if (!from || !to) return res.status(400).json({ error: "from e to obrigatorios." });
    res.json(await cGet("/sales/expertise_revenue", { subscriber_id: sid(), from, to, businessId: process.env.CLINICORP_BUSINESS_ID || undefined }));
  } catch (err) { res.status(err.response ? err.response.status : 500).json({ error: err.message }); }
});

app.get("/clinicorp/receitas-profissional", async function(req, res) {
  try {
    const { from, to } = req.query;
    if (!from || !to) return res.status(400).json({ error: "from e to obrigatorios." });
    const [data, profMap] = await Promise.all([
      cGet("/appointment/list", { subscriber_id: sid(), from, to, businessId: bid() }),
      getProfissionaisMap()
    ]);
    const lista = Array.isArray(data) ? data : (data ? [data] : []);
    const mapa = {};
    for (const a of lista) {
      const prof = profMap[String(a.Dentist_PersonId)] || "Sem profissional";
      if (!mapa[prof]) mapa[prof] = { profissional: prof, totalAtendimentos: 0, atendimentos: [] };
      mapa[prof].atendimentos.push({ paciente: a.PatientName || "", data: a.date ? a.date.split("T")[0] : "", horaInicio: a.fromTime || "", horaFim: a.toTime || "", profissional: prof, categoria: a.CategoryDescription || "", observacoes: a.Notes || "", telefone: a.MobilePhone || "" });
      mapa[prof].totalAtendimentos++;
    }
    res.json({ periodo: { from, to }, porProfissional: Object.values(mapa), totalAtendimentos: lista.length });
  } catch (err) { res.status(err.response ? err.response.status : 500).json({ error: err.message, detail: err.response ? err.response.data : null }); }
});

app.get("/clinicorp/resumo", async function(req, res) {
  try {
    const { from, to } = req.query;
    if (!from || !to) return res.status(400).json({ error: "from e to obrigatorios." });
    res.json(await cGet("/financial/list_summary", { subscriber_id: sid(), from, to, business_id: process.env.CLINICORP_BUSINESS_ID || undefined }));
  } catch (err) { res.status(err.response ? err.response.status : 500).json({ error: err.message }); }
});

// ================================================================
// SAFRA — CONCILIACAO DL SPACE
// ================================================================
function parseBrFloat(s) {
  if (!s) return 0;
  s = String(s).trim().replace(/^'+/, "");
  s = s.replace(/^0+(\d)/, "$1");
  s = s.replace(",", ".");
  return parseFloat(s) || 0;
}

function parseDateBrToISO(s) {
  if (!s) return null;
  const m = s.trim().match(/^(\d{2})[\/\.](\d{2})[\/\.](\d{4})$/);
  return m ? m[3] + "-" + m[2] + "-" + m[1] : null;
}

function parseSafraCsv(buffer) {
  const text = buffer.toString("latin1");
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n").filter(function(l) { return l.trim(); });
  if (lines.length < 2) return [];
  const header = lines[0].split(";").map(function(h) { return h.trim(); });
  return lines.slice(1).map(function(line) {
    const cols = line.split(";").map(function(c) { return c.trim(); });
    const obj = {};
    header.forEach(function(h, i) { obj[h] = cols[i] || ""; });
    return obj;
  });
}

function parseOfxBuffer(buffer) {
  const text = buffer.toString("latin1");
  const blocks = text.match(/<STMTTRN>[\s\S]*?<\/STMTTRN>/g) || [];
  return blocks.map(function(b) {
    function tag(t) { const m = b.match(new RegExp("<" + t + ">\\s*([^\\n<]+")); return m ? m[1].trim() : ""; }
    const dtRaw = tag("DTPOSTED");
    const dm = dtRaw.match(/^(\d{4})(\d{2})(\d{2})/);
    const memos = (b.match(/<MEMO>\s*([^\n<]+)/g) || []).map(function(m) { return m.replace(/<MEMO>\s*/, "").trim(); });
    return { tipo: tag("TRNTYPE"), data_lancamento: dm ? dm[1] + "-" + dm[2] + "-" + dm[3] : null, valor: parseFloat(tag("TRNAMT")) || 0, fitid: tag("FITID"), memo: memos.join(" | ") };
  });
}

function formaCompat(formaClin, produtoSafra, modalidadeSafra) {
  const normalize = function(s) { return (s || "").toUpperCase().normalize("NFD").replace(/[\u0300-\u036f]/g, ""); };
  const f = normalize(formaClin), p = normalize(produtoSafra), m = normalize(modalidadeSafra);
  if ((f.includes("PIX") || f.includes("DEBITO INSTANT")) && p.includes("PIX")) return true;
  if ((f.includes("CRED") || f.includes("CARTAO CRED")) && m.includes("CRED")) return true;
  if ((f.includes("DEB") || f.includes("CARTAO DEB")) && m.includes("DEBIT")) return true;
  return false;
}

// POST /safra/parse-vendas
app.post("/safra/parse-vendas", upload.single("arquivo"), function(req, res) {
  try {
    if (!req.file) return res.status(400).json({ error: "Arquivo nao enviado." });
    const rows = parseSafraCsv(req.file.buffer);
    const result = rows.map(function(r) {
      const vb = parseBrFloat(r["VALOR BRUTO"]);
      const vl = parseBrFloat(r["VALOR LIQUIDO"]);
      return {
        mes_ref: r["AAAAMM"] || "",
        data_venda: parseDateBrToISO(r["DATA VENDA"]),
        hora: (r["HORA"] || "").trim(),
        nsu: (r["NSU"] || "").replace(/^'+/, "").trim(),
        terminal: (r["TERMINAL"] || "").trim(),
        produto: (r["PRODUTO"] || "").trim(),
        modalidade: (r["MODALIDADE"] || "").trim(),
        num_parcelas: parseInt(r["PL"]) || 1,
        num_cartao: (r["NCAR"] || "").trim(),
        valor_bruto: vb,
        taxa_pct: parseBrFloat(r["TAXA ADMN"]) / 100,
        valor_taxa: parseFloat((vb - vl).toFixed(2)),
        valor_liquido: vl,
        status_conciliacao: "PENDENTE"
      };
    });
    res.json({ ok: true, total: result.length, vendas: result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /safra/parse-ofx
app.post("/safra/parse-ofx", upload.single("arquivo"), function(req, res) {
  try {
    if (!req.file) return res.status(400).json({ error: "Arquivo nao enviado." });
    const transacoes = parseOfxBuffer(req.file.buffer);
    const entradas = transacoes.filter(function(t) { return t.valor > 0; }).reduce(function(s, t) { return s + t.valor; }, 0);
    const saidas = transacoes.filter(function(t) { return t.valor < 0; }).reduce(function(s, t) { return s + t.valor; }, 0);
    res.json({ ok: true, total: transacoes.length, entradas: parseFloat(entradas.toFixed(2)), saidas: parseFloat(saidas.toFixed(2)), saldo: parseFloat((entradas + saidas).toFixed(2)), transacoes: transacoes });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /safra/conciliar
app.post("/safra/conciliar", async function(req, res) {
  try {
    const { vendas, mes_ref } = req.body;
    if (!vendas || !Array.isArray(vendas)) return res.status(400).json({ error: "vendas[] obrigatorio." });
    const ano = mes_ref ? mes_ref.substring(0, 4) : "";
    const mes = mes_ref ? mes_ref.substring(4, 6) : "";
    const from = ano + "-" + mes + "-01";
    const lastDay = new Date(parseInt(ano), parseInt(mes), 0).getDate();
    const to = ano + "-" + mes + "-" + String(lastDay).padStart(2, "0");
    const clinicorpData = await cGet("/payment/list", { subscriber_id: sid(), from: from, to: to, include_total_amount: "X" });
    const pagamentos = Array.isArray(clinicorpData) ? clinicorpData : (clinicorpData && clinicorpData.payments ? clinicorpData.payments : (clinicorpData && clinicorpData.data ? clinicorpData.data : []));
    const usados = new Set();
    const resultado = vendas.map(function(venda) {
      function tryMatch(tolerDias) {
        return pagamentos.find(function(p) {
          if (usados.has(p.id || p.Id)) return false;
          const pDate = new Date(p.date || p.payment_date || p.data || "");
          const vDate = new Date(venda.data_venda);
          const diffDias = Math.abs((pDate - vDate) / 86400000);
          const pVal = parseFloat(p.value || p.amount || p.valor || 0);
          const pParc = parseInt(p.installments || p.parcelas || p.num_parcelas || 1);
          return diffDias <= tolerDias && Math.abs(pVal - venda.valor_bruto) < 0.02 && pParc === venda.num_parcelas && formaCompat(p.payment_method || p.forma_pagamento || p.paymentMethod || "", venda.produto, venda.modalidade);
        });
      }
      let match = tryMatch(0);
      let status = match ? "CONCILIADO" : null;
      if (!match) { match = tryMatch(1); status = match ? "CONCILIADO_PROVAVEL" : "DIVERGENTE"; }
      if (match) usados.add(match.id || match.Id);
      return Object.assign({}, venda, {
        status_conciliacao: status,
        id_pagamento_clinicorp: match ? (match.id || match.Id || null) : null,
        nome_paciente: match ? (match.patient_name || match.PatientName || match.nome_paciente || null) : null,
        procedimento: match ? (match.procedure_name || match.ProcedureName || match.procedimento || null) : null,
        profissional: match ? (match.professional_name || match.ProfessionalName || match.profissional || null) : null
      });
    });
    const conciliados = resultado.filter(function(r) { return r.status_conciliacao === "CONCILIADO"; }).length;
    const provaveis = resultado.filter(function(r) { return r.status_conciliacao === "CONCILIADO_PROVAVEL"; }).length;
    const divergentes = resultado.filter(function(r) { return r.status_conciliacao === "DIVERGENTE"; }).length;
    res.json({ ok: true, mes_ref: mes_ref, total: resultado.length, conciliados: conciliados, provaveis: provaveis, divergentes: divergentes, resultado: resultado });
  } catch (err) { res.status(err.response ? err.response.status : 500).json({ error: err.message, detail: err.response ? err.response.data : null }); }
});

// GET /safra/health
app.get("/safra/health", function(req, res) {
  res.json({ status: "ok", versao: "1.0", rotas: ["POST /safra/parse-vendas", "POST /safra/parse-ofx", "POST /safra/conciliar", "GET /safra/health"] });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, function() {
  console.log("[INFO] Porta", PORT);
  console.log("[INFO] CLINICORP_BUSINESS_ID:", process.env.CLINICORP_BUSINESS_ID ? "OK" : "NAO CONFIGURADO");
});
