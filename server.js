const express = require("express");
const axios = require("axios");
const https = require("https");
const crypto = require("crypto");
const db = require("./database");

const app = express();
app.use(express.json());

function parsePemEnv(value) {
  if (!value) return null;

  const trimmed = value.trim();

  if (
    trimmed.includes("-----BEGIN CERTIFICATE-----") ||
    trimmed.includes("-----BEGIN PRIVATE KEY-----") ||
    trimmed.includes("-----BEGIN RSA PRIVATE KEY-----")
  ) {
    return trimmed;
  }

  return Buffer.from(trimmed, "base64").toString("utf8");
}

const cert = parsePemEnv(process.env.INTER_CERT);
const key = parsePemEnv(process.env.INTER_KEY);

console.log("INTER_CLIENT_ID exists?", !!process.env.INTER_CLIENT_ID);
console.log("INTER_CLIENT_SECRET exists?", !!process.env.INTER_CLIENT_SECRET);
console.log("INTER_CERT exists?", !!process.env.INTER_CERT, "length:", process.env.INTER_CERT?.length || 0);
console.log("INTER_KEY exists?", !!process.env.INTER_KEY, "length:", process.env.INTER_KEY?.length || 0);

if (!process.env.INTER_CLIENT_ID || !process.env.INTER_CLIENT_SECRET) {
  throw new Error("Variáveis INTER_CLIENT_ID e/ou INTER_CLIENT_SECRET ausentes.");
}

if (!cert || !key) {
  throw new Error("Variáveis INTER_CERT e/ou INTER_KEY ausentes ou inválidas.");
}

const agent = new https.Agent({
  cert,
  key,
  rejectUnauthorized: true,
});

async function gerarToken() {
  try {
    const body =
      `client_id=${encodeURIComponent(process.env.INTER_CLIENT_ID)}` +
      `&client_secret=${encodeURIComponent(process.env.INTER_CLIENT_SECRET)}` +
      `&scope=extrato.read` +
      `&grant_type=client_credentials`;

    const response = await axios.post(
      "https://cdpj.partners.bancointer.com.br/oauth/v2/token",
      body,
      {
        httpsAgent: agent,
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        timeout: 30000,
      }
    );

    return response.data.access_token;
  } catch (error) {
    console.error("ERRO AO GERAR TOKEN:");
    console.error("message:", error.message);
    console.error("status:", error.response?.status);
    console.error("data:", error.response?.data);
    throw error;
  }
}

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "inter-backend",
    certLoaded: !!cert,
    keyLoaded: !!key,
    clientIdLoaded: !!process.env.INTER_CLIENT_ID,
    clientSecretLoaded: !!process.env.INTER_CLIENT_SECRET,
  });
});

app.get("/saldo", async (req, res) => {
  try {
    const token = await gerarToken();

    const response = await axios.get(
      "https://cdpj.partners.bancointer.com.br/banking/v2/saldo",
      {
        httpsAgent: agent,
        headers: {
          Authorization: `Bearer ${token}`,
        },
        timeout: 30000,
      }
    );

    res.json(response.data);
  } catch (error) {
    console.error("ERRO NA ROTA /saldo:");
    console.error("message:", error.message);
    console.error("status:", error.response?.status);
    console.error("data:", error.response?.data);

    res.status(error.response?.status || 500).json({
      error: true,
      route: "/saldo",
      message: error.message,
      status: error.response?.status || 500,
      details: error.response?.data || null,
    });
  }
});

app.get("/extrato", async (req, res) => {
  try {
    const token = await gerarToken();

    const hoje = new Date();
    const seteDiasAtras = new Date();
    seteDiasAtras.setDate(hoje.getDate() - 7);

    const dataInicio = seteDiasAtras.toISOString().split("T")[0];
    const dataFim = hoje.toISOString().split("T")[0];

    const response = await axios.get(
      `https://cdpj.partners.bancointer.com.br/banking/v2/extrato?dataInicio=${dataInicio}&dataFim=${dataFim}`,
      {
        httpsAgent: agent,
        headers: {
          Authorization: `Bearer ${token}`,
        },
        timeout: 30000,
      }
    );

    res.json(response.data);
  } catch (error) {
    console.error("ERRO NA ROTA /extrato:");
    console.error("message:", error.message);
    console.error("status:", error.response?.status);
    console.error("data:", error.response?.data);

    res.status(error.response?.status || 500).json({
      error: true,
      route: "/extrato",
      message: error.message,
      status: error.response?.status || 500,
      details: error.response?.data || null,
    });
  }
});

app.get("/sync", async (req, res) => {
  try {
    const token = await gerarToken();

    const hoje = new Date();
    const seteDiasAtras = new Date();
    seteDiasAtras.setDate(hoje.getDate() - 7);

    const dataInicio = seteDiasAtras.toISOString().split("T")[0];
    const dataFim = hoje.toISOString().split("T")[0];

    const response = await axios.get(
      `https://cdpj.partners.bancointer.com.br/banking/v2/extrato?dataInicio=${dataInicio}&dataFim=${dataFim}`,
      {
        httpsAgent: agent,
        headers: {
          Authorization: `Bearer ${token}`,
        },
        timeout: 30000,
      }
    );

    const transacoes = response.data.transacoes || [];
    let inseridas = 0;

    for (const t of transacoes) {
      const hash = crypto
        .createHash("sha256")
        .update(`${t.dataEntrada}|${t.valor}|${t.descricao}`)
        .digest("hex");

      db.run(
        `INSERT OR IGNORE INTO transacoes
         (data, tipo_operacao, tipo_transacao, valor, descricao, hash)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          t.dataEntrada,
          t.tipoOperacao,
          t.tipoTransacao,
          parseFloat(t.valor),
          t.descricao,
          hash,
        ],
        function (err) {
          if (!err && this.changes > 0) inseridas++;
        }
      );
    }

    res.json({
      message: "Sync concluído",
      total: transacoes.length,
      inseridas,
    });
  } catch (error) {
    console.error("ERRO NA ROTA /sync:");
    console.error("message:", error.message);
    console.error("status:", error.response?.status);
    console.error("data:", error.response?.data);

    res.status(error.response?.status || 500).json({
      error: true,
      route: "/sync",
      message: error.message,
      status: error.response?.status || 500,
      details: error.response?.data || null,
    });
  }
});

app.get("/transacoes", (req, res) => {
  db.all("SELECT * FROM transacoes ORDER BY data DESC", [], (err, rows) => {
    if (err) {
      console.error("ERRO NA ROTA /transacoes:", err.message);
      return res.status(500).json({ error: true, message: err.message });
    }
    res.json(rows);
  });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});