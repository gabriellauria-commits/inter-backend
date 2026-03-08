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

app.get("/debug-cert", function(req, res) {
  const cert = parsePemEnv(process.env.INTER_CERT, "INTER_CERT");
  const key = parsePemEnv(process.env.INTER_KEY, "INTER_KEY");
  res.json({ cert_ok: !!cert, key_ok: !!key });
});

function criarAgent() {
  const cert = parsePemEnv(process.env.INTER_CERT, "INTER_CERT");
  const key = parsePemEnv(process.env.INTER_KEY, "INTER_KEY");
  if (!cert || !key) throw new Error("INTER_CERT ou INTER_KEY ausente.");
  return new https.Agent({ cert, key, rejectUnauthorized: true });
}

async function gerarToken() {
  const clientId = process.env.INTER_CLIENT_ID;
  const clientSecret = process.env.INTER_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("INTER_CLIENT_ID ou INTER_CLIENT_SECRET ausente.");
  const agent = criarAgent();
  const body = "client_id=" + encodeURIComponent(clientId) + "&client_secret=" + encodeURIComponent(clientSecret) + "&scope=extrato.read%20saldo.read&grant_type=client_credentials";
  const r = await axios.post("https://cdpj.partners.bancointer.com.br/oauth/v2/token", body,
    { httpsAgent: agent, headers: { "Content-Type": "application/x-www-form-urlencoded" }, timeout: 30000 });
  return r.data.access_token;
}

app.get("/health", function(req, res) {
  const vars = { INTER_CLIENT_ID: !!process.env.INTER_CLIENT_ID, INTER_CLIENT_SECRET: !!process.env.INTER_CLIENT_SECRET, INTER_CERT: !!process.env.INTER_CERT, INTER_KEY: !!process.env.INTER_KEY };
  res.status(Object.values(vars).every(Boolean) ? 200 : 500).json({ status: Object.values(vars).every(Boolean) ? "ok" : "missing_vars", vars });
});

app.get("/saldo", async function(req, res) {
  try {
    const token = await gerarToken(); const agent = criarAgent();
    const r = await axios.get("https://cdpj.partners.bancointer.com.br/banking/v2/saldo", { httpsAgent: agent, headers: { Authorization: "Bearer " + token }, timeout: 30000 });
    res.json(r.data);
  } catch (e) { res.status(e.response ? e.response.status : 500).json({ error: e.message }); }
});

app.get("/extrato", async function(req, res) {
  try {
    const token = await gerarToken(); const agent = criarAgent();
    const hoje = new Date(); const fim = hoje.toISOString().split("T")[0];
    const ini = new Date(hoje.setDate(hoje.getDate() - 30)).toISOString().split("T")[0];
    const r = await axios.get("https://cdpj.partners.bancointer.com.br/banking/v2/extrato",
      { httpsAgent: agent, headers: { Authorization: "Bearer " + token }, params: { dataInicio: ini, dataFim: fim }, timeout: 30000 });
    res.json(r.data);
  } catch (e) { res.status(e.response ? e.response.status : 500).json({ error: e.message }); }
});

app.get("/sync", async function(req, res) {
  try {
    const token = await gerarToken(); const agent = criarAgent();
    const hoje = new Date(); const fim = hoje.toISOString().split("T")[0];
    const ini = new Date(hoje.setDate(hoje.getDate() - 30)).toISOString().split("T")[0];
    const r = await axios.get("https://cdpj.partners.bancointer.com.br/banking/v2/extrato",
      { httpsAgent: agent, headers: { Authorization: "Bearer " + token }, params: { dataInicio: ini, dataFim: fim }, timeout: 30000 });
    const transacoes = r.data.transacoes || []; let inseridas = 0;
    for (const t of transacoes) {
      const hash = crypto.createHash("sha256").update(t.dataEntrada + "|" + t.valor + "|" + t.descricao).digest("hex");
      db.run("INSERT OR IGNORE INTO transacoes (data, tipo_operacao, tipo_transacao, valor, descricao, hash) VALUES (?, ?, ?, ?, ?, ?)",
        [t.dataEntrada, t.tipoOperacao, t.tipoTransacao, parseFloat(t.valor), t.descricao, hash],
        function(err) { if (!err && this.changes > 0) inseridas++; });
    }
    res.json({ message: "Sync concluido", total: transacoes.length, inseridas });
  } catch (e) { res.status(e.response ? e.response.status : 500).json({ error: e.message }); }
});

app.get("/transacoes", function(req, res) {
  db.all("SELECT * FROM transacoes ORDER BY data DESC", [], function(err, rows) {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

const CLINICORP_BASE = "https://api.clinicorp.com/rest/v1";

function clinicorpHeaders() {
  const user = process.env.CLINICORP_USER; const token = process.env.CLINICORP_TOKEN;
  if (!user || !token) throw new Error("CLINICORP_USER ou CLINICORP_TOKEN ausente.");
  return { Authorization: "Basic " + Buffer.from(user + ":" + token).toString("base64"), "Content-Type": "application/json" };
}
function subscriberId() {
  const id = process.env.CLINICORP_SUBSCRIBER;
  if (!id) throw new Error("CLINICORP_SUBSCRIBER ausente.");
  return id;
}
function businessId() {
  const id = process.env.CLINICORP_BUSINESS_ID;
  if (!id) throw new Error("CLINICORP_BUSINESS_ID nao configurado — obrigatorio para agendamentos.");
  return id;
}

async function clinicorpGet(path, params) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null && v !== "") qs.append(k, v);
  }
  const url = CLINICORP_BASE + path + (qs.toString() ? "?" + qs.toString() : "");
  console.log("[CLINICORP] GET " + url);
  const resp = await axios.get(url, { headers: clinicorpHeaders(), timeout: 30000 });
  return resp.data;
}

app.get("/clinicorp/health", function(req, res) {
  const vars = { CLINICORP_USER: !!process.env.CLINICORP_USER, CLINICORP_TOKEN: !!process.env.CLINICORP_TOKEN, CLINICORP_SUBSCRIBER: !!process.env.CLINICORP_SUBSCRIBER, CLINICORP_BUSINESS_ID: !!process.env.CLINICORP_BUSINESS_ID };
  res.status(Object.values(vars).every(Boolean) ? 200 : 500).json({ status: Object.values(vars).every(Boolean) ? "ok" : "missing_vars", vars });
});

app.get("/clinicorp/pacientes", async function(req, res) {
  try {
    const { name, cpf, phone, email, patientId } = req.query;
    const params = { subscriber_id: subscriberId() };
    if (patientId) params.PatientId = patientId;
    if (name) params.Name = name;
    if (cpf) params.OtherDocumentId = cpf;
    if (phone) params.Phone = phone;
    if (email) params.Email = email;
    const data = await clinicorpGet("/patient/get", params);
    res.json(data);
  } catch (err) {
    console.error("[PACIENTES] Erro:", err.message, err.response ? JSON.stringify(err.response.data) : "");
    res.status(err.response ? err.response.status : 500).json({ error: err.message, detail: err.response ? err.response.data : null });
  }
});

app.get("/clinicorp/pacientes/:patientId/agendamentos", async function(req, res) {
  try {
    const data = await clinicorpGet("/patient/list_appointments", { subscriber_id: subscriberId(), PatientId: req.params.patientId });
    res.json(data);
  } catch (err) { res.status(err.response ? err.response.status : 500).json({ error: err.message }); }
});

app.get("/clinicorp/pacientes/:patientId/orcamentos", async function(req, res) {
  try {
    const data = await clinicorpGet("/patient/list_estimates", { subscriber_id: subscriberId(), PatientId: req.params.patientId });
    res.json(data);
  } catch (err) { res.status(err.response ? err.response.status : 500).json({ error: err.message }); }
});

app.get("/clinicorp/pagamentos", async function(req, res) {
  try {
    const { from, to, dateType } = req.query;
    if (!from || !to) return res.status(400).json({ error: "Parametros 'from' e 'to' obrigatorios." });
    const data = await clinicorpGet("/payment/list", {
      subscriber_id: subscriberId(), from, to,
      date_type: dateType || undefined, include_total_amount: "X",
    });
    res.json(data);
  } catch (err) {
    console.error("[PAGAMENTOS] Erro:", err.message, err.response ? JSON.stringify(err.response.data) : "");
    res.status(err.response ? err.response.status : 500).json({ error: err.message, detail: err.response ? err.response.data : null });
  }
});

app.get("/clinicorp/agendamentos", async function(req, res) {
  try {
    const { from, to, patientId, includeCanceled } = req.query;
    if (!from || !to) return res.status(400).json({ error: "Parametros 'from' e 'to' obrigatorios." });
    const bid = businessId();
    const params = { subscriber_id: subscriberId(), from, to, businessId: bid };
    if (patientId) params.patientId = patientId;
    if (includeCanceled === "true") params.includeCanceled = "true";
    const data = await clinicorpGet("/appointment/list", params);
    res.json(data);
  } catch (err) {
    console.error("[AGENDAMENTOS] Erro:", err.message, err.response ? JSON.stringify(err.response.data) : "");
    res.status(err.response ? err.response.status : 500).json({ error: err.message, detail: err.response ? err.response.data : null });
  }
});

app.get("/clinicorp/procedimentos", async function(req, res) {
  try {
    const data = await clinicorpGet("/procedures/list", { subscriber_id: subscriberId() });
    res.json(data);
  } catch (err) { res.status(err.response ? err.response.status : 500).json({ error: err.message }); }
});

app.get("/clinicorp/receitas-especialidade", async function(req, res) {
  try {
    const { from, to } = req.query;
    if (!from || !to) return res.status(400).json({ error: "Parametros 'from' e 'to' obrigatorios." });
    const data = await clinicorpGet("/sales/expertise_revenue", { subscriber_id: subscriberId(), from, to, businessId: businessId() });
    res.json(data);
  } catch (err) { res.status(err.response ? err.response.status : 500).json({ error: err.message }); }
});

app.get("/clinicorp/resumo", async function(req, res) {
  try {
    const { from, to } = req.query;
    if (!from || !to) return res.status(400).json({ error: "Parametros 'from' e 'to' obrigatorios." });
    const data = await clinicorpGet("/financial/list_summary", { subscriber_id: subscriberId(), from, to, business_id: businessId() });
    res.json(data);
  } catch (err) { res.status(err.response ? err.response.status : 500).json({ error: err.message }); }
});

app.get("/clinicorp/receitas-profissional", async function(req, res) {
  try {
    const { from, to } = req.query;
    if (!from || !to) return res.status(400).json({ error: "Parametros 'from' e 'to' obrigatorios." });
    const data = await clinicorpGet("/appointment/list", { subscriber_id: subscriberId(), from, to, businessId: businessId() });
    res.json(data);
  } catch (err) {
    console.error("[RECEITAS-PROF] Erro:", err.message, err.response ? JSON.stringify(err.response.data) : "");
    res.status(err.response ? err.response.status : 500).json({ error: err.message, detail: err.response ? err.response.data : null });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, function() {
  console.log("[INFO] Servidor na porta " + PORT);
  console.log("[INFO] Clinicorp business_id:", process.env.CLINICORP_BUSINESS_ID || "NAO CONFIGURADO");
});
