"use strict";
const express = require("express");
const axios = require("axios");
const https = require("https");
const crypto = require("crypto");
const db = require("./database");

const app = express();
app.use(express.json());

function parsePemEnv(value, label) {
    if (!value) {
          console.warn("[WARN] " + label + " nao definido.");
          return null;
    }

  let pem = value.trim();

  // Se nao tem header PEM, tentar decodificar base64
  if (!pem.includes("-----BEGIN")) {
        try {
                pem = Buffer.from(pem, "base64").toString("utf8").trim();
                console.log("[INFO] " + label + " decodificado de base64.");
        } catch (e) {
                console.error("[ERROR] Falha decode base64 " + label + ":", e.message);
                return null;
        }
  }

  // Normaliza \n literais em quebras reais
  pem = pem.replace(/\\n/g, "\n");

  // Reconstroi o PEM linha a linha garantindo formato correto
  const lines = pem.split("\n").map(function(l) { return l.trim(); }).filter(Boolean);
    const normalized = lines.join("\n") + "\n";

  console.log("[INFO] " + label + " PEM pronto (" + normalized.length + " chars). Linhas: " + lines.length);
    return normalized;
}

app.get("/debug-cert", function(req, res) {
    const cert = parsePemEnv(process.env.INTER_CERT, "INTER_CERT");
    const key  = parsePemEnv(process.env.INTER_KEY,  "INTER_KEY");
    res.json({
          cert_ok:        !!cert,
          cert_starts:    cert ? cert.substring(0, 80) : null,
          cert_ends:      cert ? cert.substring(cert.length - 80) : null,
          cert_has_begin: cert ? cert.includes("-----BEGIN") : false,
          cert_has_end:   cert ? cert.includes("-----END") : false,
          cert_lines:     cert ? cert.split("\n").length : 0,
          key_ok:         !!key,
          key_starts:     key ? key.substring(0, 80) : null,
          key_has_begin:  key ? key.includes("-----BEGIN") : false,
          key_lines:      key ? key.split("\n").length : 0,
    });
});

function criarAgent() {
    const cert = parsePemEnv(process.env.INTER_CERT, "INTER_CERT");
    const key  = parsePemEnv(process.env.INTER_KEY,  "INTER_KEY");
    if (!cert || !key) throw new Error("INTER_CERT ou INTER_KEY ausente/invalido.");
    return new https.Agent({ cert: cert, key: key, rejectUnauthorized: true });
}

async function gerarToken() {
    const clientId     = process.env.INTER_CLIENT_ID;
    const clientSecret = process.env.INTER_CLIENT_SECRET;
    if (!clientId || !clientSecret) throw new Error("INTER_CLIENT_ID ou INTER_CLIENT_SECRET ausente.");
    const agent = criarAgent();
    const body = "client_id=" + encodeURIComponent(clientId) +
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

app.get("/health", function(req, res) {
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

app.get("/saldo", async function(req, res) {
    try {
          const token = await gerarToken();
          const agent = criarAgent();
          const response = await axios.get(
                  "https://cdpj.partners.bancointer.com.br/banking/v2/saldo",
            { httpsAgent: agent, headers: { Authorization: "Bearer " + token }, timeout: 30000 }
                );
          res.json(response.data);
    } catch (error) {
          const status = error.response ? error.response.status : 500;
          const data   = error.response ? error.response.data : null;
          console.error("[ERROR /saldo]", { status: status, message: error.message, data: data });
          res.status(status).json({ error: error.message, detail: data });
    }
});

app.get("/extrato", async function(req, res) {
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
          const status = error.response ? error.response.status : 500;
          const data   = error.response ? error.response.data : null;
          console.error("[ERROR /extrato]", { status: status, message: error.message, data: data });
          res.status(status).json({ error: error.message, detail: data });
    }
});

app.get("/sync", async function(req, res) {
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
                  const hash = crypto.createHash("sha256")
                    .update(t.dataEntrada + "|" + t.valor + "|" + t.descricao)
                    .digest("hex");
                  db.run(
                            "INSERT OR IGNORE INTO transacoes (data, tipo_operacao, tipo_transacao, valor, descricao, hash) VALUES (?, ?, ?, ?, ?, ?)",
                            [t.dataEntrada, t.tipoOperacao, t.tipoTransacao, parseFloat(t.valor), t.descricao, hash],
                            function(err) { if (!err && this.changes > 0) inseridas++; }
                          );
          }
          res.json({ message: "Sync concluido", total: transacoes.length, inseridas: inseridas });
    } catch (error) {
          const status = error.response ? error.response.status : 500;
          const data   = error.response ? error.response.data : null;
          console.error("[ERROR /sync]", { status: status, message: error.message, data: data });
          res.status(status).json({ error: error.message, detail: data });
    }
});

app.get("/transacoes", function(req, res) {
    db.all("SELECT * FROM transacoes ORDER BY data DESC", [], function(err, rows) {
          if (err) {
                  console.error("[ERROR /transacoes]", err.message);
                  return res.status(500).json({ error: err.message });
          }
          res.json(rows);
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, function() {
    console.log("[INFO] Servidor rodando na porta " + PORT);
    console.log("[INFO] Variaveis:", {
          INTER_CLIENT_ID:     !!process.env.INTER_CLIENT_ID,
          INTER_CLIENT_SECRET: !!process.env.INTER_CLIENT_SECRET,
          INTER_CERT:          !!process.env.INTER_CERT,
          INTER_KEY:           !!process.env.INTER_KEY,
    });
});
});
});
