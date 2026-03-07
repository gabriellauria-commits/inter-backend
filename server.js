"use strict";

const express = require("express");
const axios = require("axios");
const https = require("https");
const crypto = require("crypto");
const db = require("./database");

const app = express();
app.use(express.json());

function parsePemEnv(value, label) {
    if (!value) { console.warn("[WARN] " + label + " nao definido."); return null; }
    const trimmed = value.trim();
    if (trimmed.includes("-----BEGIN")) {
          console.log("[INFO] " + label + " PEM bruto (" + trimmed.length + " chars).");
          return trimmed.replace(/\\n/g, "\n");
    }
    try {
          const decoded = Buffer.from(trimmed, "base64").toString("utf8");
          console.log("[INFO] " + label + " decodificado base64 (" + decoded.length + " chars).");
          return decoded;
    } catch (e) {
          console.error("[ERROR] Falha decode " + label + ":", e.message);
          return null;
    }
}

function criarAgent() {
    const cert = parsePemEnv(process.env.INTER_CERT, "INTER_CERT");
    const key  = parsePemEnv(process.env.INTER_KEY,  "INTER_KEY");
    if (!cert || !key) throw new Error("INTER_CERT ou INTER_KEY ausente/invalido.");
    return new https.Agent({ cert, key, rejectUnauthorized: true });
}

async function gerarToken() {
    const clientId     = process.env.INTER_CLIENT_ID;
    const clientSecret = process.env.INTER_CLIENT_SECRET;
    if (!clientId || !clientSecret) throw new Error("INTER_CLIENT_ID ou INTER_CLIENT_SECRET ausente.");
    const agent = criarAgent();
    const body =
          "client_id=" + encodeURIComponent(clientId) +
          "&client_secret=" + encodeURIComponent(clientSecret) +
          "&scope=extrato.read%20saldo.read" +
          "&grant_type=client_credentials";
    const response = await axios.post(
          "https://cdpj.partners.bancointer.com.br/oauth/v2/token",
          body,
      { httpsAgent: agent, headers: { "Content-Type": "application/x-www-form-urlencoded" }, timeout: 30000 }
        );
    console.log("[INFO] Token gerado.");
    return response.data.access_token;
}

app.get("/health", (req, res) => {
    const vars = {
          INTER_CLIENT_ID:     !!process.env.INTER_CLIENT_ID,
          INTER_CLIENT_SECRET: !!process.env.INTER_CLIENT_SECRET,
          INTER_CERT:          !!process.env.INTER_CERT,
          INTER_KEY:           !!process.env.INTER_KEY,
    };
    const allOk = Object.values(vars).every(Boolean);
    console.log("[HEALTH]", vars);
    res.status(allOk ? 200 : 500).json({ status: allOk ? "ok" : "missing_vars", vars });
});

app.get("/saldo", async (req, res) => {
    try {
          const token = await gerarToken();
          const agent = criarAgent();
          const response = await axios.get(
                  "https://cdpj.partners.bancointer.com.br/banking/v2/saldo",
            { httpsAgent: agent, headers: { Authorization: "Bearer " + token }, timeout: 30000 }
                );
          res.json(response.data);
    } catch (error) {
          const status = error.response?.status ?? 500;
          const data   = error.response?.data   ?? null;
          console.error("[ERROR /saldo]", { status, message: error.message, data });
          res.status(status).json({ error: error.message, detail: data });
    }
});

app.get("/extrato", async (req, res) => {
    try {
          const token = await gerarToken();
          const agent = criarAgent();
          const hoje = new Date();
          const fim  = hoje.toISOString().split("T")[0];
          const ini  = new Date(hoje.setDate(hoje.getDate() - 30)).toISOString().split("T")[0];
          const response = await axios.get(
                  "https://cdpj.partners.bancointer.com.br/banking/v2/extrato",
            { httpsAgent: agent, headers: { Authorization: "Bearer " + token }, params: { dataInicio: ini, dataFim: fim }, timeout: 30000 }
                );
          res.json(response.data);
    } catch (error) {
          const status = error.response?.status ?? 500;
          const data   = error.response?.data   ?? null;
          console.error("[ERROR /extrato]", { status, message: error.message, data });
          res.status(status).json({ error: error.message, detail: data });
    }
});

app.get("/sync", async (req, res) => {
    try {
          const token = await gerarToken();
          const agent = criarAgent();
          const hoje = new Date();
          const fim  = hoje.toISOString().split("T")[0];
          const ini  = new Date(hoje.setDate(hoje.getDate() - 30)).toISOString().split("T")[0];
          const response = await axios.get(
                  "https://cdpj.partners.bancointer.com.br/banking/v2/extrato",
            { httpsAgent: agent, headers: { Authorization: "Bearer " + token }, params: { dataInicio: ini, dataFim: fim }, timeout: 30000 }
                );
          const transacoes = response.data.transacoes || [];
          let inseridas = 0;
          for (const t of transacoes) {
                  const hash = crypto.createHash("sha256").update(t.dataEntrada + "|" + t.valor + "|" + t.descricao).digest("hex");
                  db.run(
                            "INSERT OR IGNORE INTO transacoes (data, tipo_operacao, tipo_transacao, valor, descricao, hash) VALUES (?, ?, ?, ?, ?, ?)",
                            [t.dataEntrada, t.tipoOperacao, t.tipoTransacao, parseFloat(t.valor), t.descricao, hash],
                            function(err) { if (!err && this.changes > 0) inseridas++; }
                          );
          }
          res.json({ message: "Sync concluido", total: transacoes.length, inseridas });
    } catch (error) {
          const status = error.response?.status ?? 500;
          const data   = error.response?.data   ?? null;
          console.error("[ERROR /sync]", { status, message: error.message, data });
          res.status(status).json({ error: error.message, detail: data });
    }
});

app.get("/transacoes", (req, res) => {
    db.all("SELECT * FROM transacoes ORDER BY data DESC", [], (err, rows) => {
          if (err) { console.error("[ERROR /transacoes]", err.message); return res.status(500).json({ error: err.message }); }
          res.json(rows);
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log("[INFO] Servidor rodando na porta " + PORT);
    console.log("[INFO] Variaveis:", {
          INTER_CLIENT_ID:     !!process.env.INTER_CLIENT_ID,
          INTER_CLIENT_SECRET: !!process.env.INTER_CLIENT_SECRET,
          INTER_CERT:          !!process.env.INTER_CERT,
          INTER_KEY:           !!process.env.INTER_KEY,
    });
});
