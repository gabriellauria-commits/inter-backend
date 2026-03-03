const express = require("express");
const axios = require("axios");
const https = require("https");
const fs = require("fs");
const crypto = require("crypto");
const db = require("./database");

const app = express();

const cert = fs.readFileSync("./certificado.crt");
const key = fs.readFileSync("./chave.key");

const agent = new https.Agent({
  cert,
  key,
  rejectUnauthorized: true
});

async function gerarToken() {
  const response = await axios.post(
    "https://cdpj.partners.bancointer.com.br/oauth/v2/token",
    `client_id=${process.env.INTER_CLIENT_ID}&client_secret=${process.env.INTER_CLIENT_SECRET}&scope=extrato.read&grant_type=client_credentials`,
    {
      httpsAgent: agent,
      headers: { "Content-Type": "application/x-www-form-urlencoded" }
    }
  );

  return response.data.access_token;
}

/* ================= SALDO ================= */

app.get("/saldo", async (req, res) => {
  try {
    const token = await gerarToken();

    const response = await axios.get(
      "https://cdpj.partners.bancointer.com.br/banking/v2/saldo",
      {
        httpsAgent: agent,
        headers: { Authorization: `Bearer ${token}` }
      }
    );

    res.json(response.data);
  } catch (error) {
    res.status(500).json(error.response?.data || error.message);
  }
});

/* ================= EXTRATO ================= */

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
        headers: { Authorization: `Bearer ${token}` }
      }
    );

    res.json(response.data);

  } catch (error) {
    res.status(500).json(error.response?.data || error.message);
  }
});

/* ================= SYNC PARA BANCO ================= */

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
        headers: { Authorization: `Bearer ${token}` }
      }
    );

    const transacoes = response.data.transacoes;
    let inseridas = 0;

    for (const t of transacoes) {

      const hash = crypto
        .createHash("sha256")
        .update(t.dataEntrada + t.valor + t.descricao)
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
          hash
        ],
        function (err) {
          if (!err && this.changes > 0) {
            inseridas++;
          }
        }
      );
    }

    res.json({
      message: "Sync concluído",
      inseridas
    });

  } catch (error) {
    res.status(500).json(error.response?.data || error.message);
  }
});

/* ================= LISTAR DO BANCO ================= */

app.get("/transacoes", (req, res) => {
  db.all("SELECT * FROM transacoes ORDER BY data DESC", [], (err, rows) => {
    if (err) {
      return res.status(500).json(err.message);
    }
    res.json(rows);
  });
});

/* ================= SERVIDOR ================= */

app.listen(3000, () => {
  console.log("Servidor rodando em http://localhost:3000");
});