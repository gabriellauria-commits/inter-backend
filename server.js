"use strict";
const express = require("express");
const axios = require("axios");
const https = require("https");
const crypto = require("crypto");
const db = require("./database");

const app = express();
app.use(express.json());

app.use(function(req, res, next) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
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
  const key  = parsePemEnv(process.env.INTER_KEY,  "INTER_KEY");
  if (!cert || !key) throw new Error("INTER_CERT ou INTER_KEY ausente.");
  return new https.Agent({ cert: cert, key: key, rejectUnauthorized: true });
}

async function gerarToken() {
  const clientId = process.env.INTER_CLIENT_ID;
  const clientSecret = process.env.INTER_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("Credenciais Inter ausentes.");
  const agent = criarAgent();
  const body = "client_id=" + encodeURIComponent(clientId) + "&client_secret=" + encodeURIComponent(clientSecret) + "&scope=extrato.read%20saldo.read&grant_type=client_credentials";
  const r = await axios.post("https://cdpj.partners.bancointer.com.br/oauth/v2/token", body,
    { httpsAgent: agent, headers: { "Content-Type": "application/x-www-form-urlencoded" }, timeout: 30000 });
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
    const r = await axios.get("https://cdpj.partners.bancointer.com.br/banking/v2/saldo",
      { httpsAgent: criarAgent(), headers: { Authorization: "Bearer " + token }, timeout: 30000 });
    res.json(r.data);
  } catch (e) { res.status(e.response ? e.response.status : 500).json({ error: e.message }); }
});

app.get("/extrato", async function(req, res) {
  try {
    const token = await gerarToken();
    const hoje = new Date();
    const fim = hoje.toISOString().split("T")[0];
    const ini = new Date(hoje.setDate(hoje.getDate() - 30)).toISOString().split("T")[0];
    const r = await axios.get("https://cdpj.partners.bancointer.com.br/banking/v2/extrato",
      { httpsAgent: criarAgent(), headers: { Authorization: "Bearer " + token }, params: { dataInicio: ini, dataFim: fim }, timeout: 30000 });
    res.json(r.data);
  } catch (e) { res.status(e.response ? e.response.status : 500).json({ error: e.message }); }
});

app.get("/sync", async function(req, res) {
  try {
    const token = await gerarToken();
    const hoje = new Date();
    const fim = hoje.toISOString().split("T")[0];
    const ini = new Date(hoje.setDate(hoje.getDate() - 30)).toISOString().split("T")[0];
    const r = await axios.get("https://cdpj.partners.bancointer.com.br/banking/v2/extrato",
      { httpsAgent: criarAgent(), headers: { Authorization: "Bearer " + token }, params: { dataInicio: ini, dataFim: fim }, timeout: 30000 });
    const tx = r.data.transacoes || [];
    let inseridas = 0;
    for (const t of tx) {
      const hash = crypto.createHash("sha256").update(t.dataEntrada + "|" + t.valor + "|" + t.descricao).digest("hex");
      db.run("INSERT OR IGNORE INTO transacoes (data,tipo_operacao,tipo_transacao,valor,descricao,hash) VALUES (?,?,?,?,?,?)",
        [t.dataEntrada, t.tipoOperacao, t.tipoTransacao, parseFloat(t.valor), t.descricao, hash],
        function(err) { if (!err && this.changes > 0) inseridas++; });
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

// CLINICORP
const BASE = "https://api.clinicorp.com/rest/v1";

function cHeaders() {
  const u = process.env.CLINICORP_USER, t = process.env.CLINICORP_TOKEN;
  if (!u || !t) throw new Error("CLINICORP_USER/TOKEN ausente.");
  return { Authorization: "Basic " + Buffer.from(u + ":" + t).toString("base64"), "Content-Type": "application/json" };
}
function sid() {
  const id = process.env.CLINICORP_SUBSCRIBER;
  if (!id) throw new Error("CLINICORP_SUBSCRIBER ausente.");
  return id;
}
function bid() {
  const id = process.env.CLINICORP_BUSINESS_ID;
  if (!id) throw new Error("CLINICORP_BUSINESS_ID nao configurado.");
  return id;
}
function toArr(d) {
  if (Array.isArray(d)) return d;
  if (d && typeof d === "object" && !d.Error && !d.error && d.PatientId) return [d];
  if (d && typeof d === "object" && !d.Error && !d.error && !d.PatientId) {
    // pode ser outro objeto valido
    const keys = Object.keys(d);
    if (keys.length > 0 && !keys.includes("Error")) return [d];
  }
  return [];
}

async function cGet(path, params) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== null && v !== "") qs.append(k, v);
  const url = BASE + path + (qs.toString() ? "?" + qs.toString() : "");
  console.log("[CLINICORP] GET", url);
  return (await axios.get(url, { headers: cHeaders(), timeout: 30000 })).data;
}

// Cache de profissionais para join
let _profCache = null;
let _profCacheTs = 0;
async function getProfissionaisMap() {
  const now = Date.now();
  if (_profCache && now - _profCacheTs < 5 * 60 * 1000) return _profCache;
  try {
    const data = await cGet("/professional/list_all_professionals", { subscriber_id: sid() });
    const map = {};
    const list = Array.isArray(data) ? data : [];
    for (const p of list) { map[String(p.id)] = p.name || ""; }
    _profCache = map;
    _profCacheTs = now;
    console.log("[CLINICORP] Profissionais carregados:", list.length);
  } catch (e) {
    console.warn("[CLINICORP] Nao foi possivel carregar profissionais:", e.message);
    _profCache = {};
  }
  return _profCache;
}

app.get("/clinicorp/health", function(req, res) {
  const v = { CLINICORP_USER: !!process.env.CLINICORP_USER, CLINICORP_TOKEN: !!process.env.CLINICORP_TOKEN, CLINICORP_SUBSCRIBER: !!process.env.CLINICORP_SUBSCRIBER, CLINICORP_BUSINESS_ID: !!process.env.CLINICORP_BUSINESS_ID };
  res.status(Object.values(v).every(Boolean) ? 200 : 500).json({ status: Object.values(v).every(Boolean) ? "ok" : "missing_vars", vars: v });
});

// PACIENTES — busca exata por nome completo, CPF ou telefone
app.get("/clinicorp/pacientes", async function(req, res) {
  try {
    const { name, cpf, phone, email, patientId } = req.query;
    if (!name && !cpf && !phone && !email && !patientId)
      return res.status(400).json({ error: "Informe: name (nome completo), cpf, phone ou patientId." });
    const data = await cGet("/patient/get", {
      subscriber_id:   sid(),
      PatientId:       patientId  || undefined,
      Name:            name       || undefined,
      OtherDocumentId: cpf        || undefined,
      Phone:           phone      || undefined,
      Email:           email      || undefined,
    });
    // API retorna objeto unico ou erro
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

// PAGAMENTOS
app.get("/clinicorp/pagamentos", async function(req, res) {
  try {
    const { from, to, dateType } = req.query;
    if (!from || !to) return res.status(400).json({ error: "from e to obrigatorios." });
    const data = await cGet("/payment/list", { subscriber_id: sid(), from, to, date_type: dateType || undefined, include_total_amount: "X" });
    res.json(data);
  } catch (err) { res.status(err.response ? err.response.status : 500).json({ error: err.message, detail: err.response ? err.response.data : null }); }
});

// AGENDAMENTOS com join de profissional pelo Dentist_PersonId
app.get("/clinicorp/agendamentos", async function(req, res) {
  try {
    const { from, to, patientId, includeCanceled } = req.query;
    if (!from || !to) return res.status(400).json({ error: "from e to obrigatorios." });
    const [data, profMap] = await Promise.all([
      cGet("/appointment/list", {
        subscriber_id:   sid(),
        from, to,
        businessId:      bid(),
        patientId:       patientId || undefined,
        includeCanceled: includeCanceled === "true" ? "true" : undefined,
      }),
      getProfissionaisMap()
    ]);
    const lista = Array.isArray(data) ? data : (data ? [data] : []);
    // Adicionar ProfessionalName via join
    const result = lista.map(function(a) {
      return Object.assign({}, a, {
        ProfessionalName: profMap[String(a.Dentist_PersonId)] || "",
      });
    });
    res.json(result);
  } catch (err) { res.status(err.response ? err.response.status : 500).json({ error: err.message, detail: err.response ? err.response.data : null }); }
});

// PROCEDIMENTOS
app.get("/clinicorp/procedimentos", async function(req, res) {
  try { res.json(await cGet("/procedures/list", {})); }
  catch (err) { res.status(err.response ? err.response.status : 500).json({ error: err.message }); }
});

// PROFISSIONAIS
app.get("/clinicorp/profissionais", async function(req, res) {
  try { res.json(await cGet("/professional/list_all_professionals", { subscriber_id: sid() })); }
  catch (err) { res.status(err.response ? err.response.status : 500).json({ error: err.message }); }
});

// RECEITAS POR ESPECIALIDADE
app.get("/clinicorp/receitas-especialidade", async function(req, res) {
  try {
    const { from, to } = req.query;
    if (!from || !to) return res.status(400).json({ error: "from e to obrigatorios." });
    res.json(await cGet("/sales/expertise_revenue", { subscriber_id: sid(), from, to, businessId: process.env.CLINICORP_BUSINESS_ID || undefined }));
  } catch (err) { res.status(err.response ? err.response.status : 500).json({ error: err.message }); }
});

// RECEITAS POR PROFISSIONAL — join agendamentos + profissionais
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
      mapa[prof].atendimentos.push({
        paciente:        a.PatientName || "",
        data:            a.date ? a.date.split("T")[0] : "",
        horaInicio:      a.fromTime || "",
        horaFim:         a.toTime || "",
        profissional:    prof,
        categoria:       a.CategoryDescription || "",
        observacoes:     a.Notes || "",
        telefone:        a.MobilePhone || "",
      });
      mapa[prof].totalAtendimentos++;
    }
    res.json({ periodo: { from, to }, porProfissional: Object.values(mapa), totalAtendimentos: lista.length });
  } catch (err) { res.status(err.response ? err.response.status : 500).json({ error: err.message, detail: err.response ? err.response.data : null }); }
});

// RESUMO FINANCEIRO
app.get("/clinicorp/resumo", async function(req, res) {
  try {
    const { from, to } = req.query;
    if (!from || !to) return res.status(400).json({ error: "from e to obrigatorios." });
    res.json(await cGet("/financial/list_summary", { subscriber_id: sid(), from, to, business_id: process.env.CLINICORP_BUSINESS_ID || undefined }));
  } catch (err) { res.status(err.response ? err.response.status : 500).json({ error: err.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, function() {
  console.log("[INFO] Porta", PORT);
  console.log("[INFO] CLINICORP_BUSINESS_ID:", process.env.CLINICORP_BUSINESS_ID ? "OK" : "NAO CONFIGURADO");
});
