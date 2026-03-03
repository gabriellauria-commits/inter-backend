const sqlite3 = require("sqlite3").verbose();

const db = new sqlite3.Database("./finance.db");

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS transacoes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      data TEXT,
      tipo_operacao TEXT,
      tipo_transacao TEXT,
      valor REAL,
      descricao TEXT,
      categoria TEXT,
      tipo_classificacao TEXT,
      reconciliado INTEGER DEFAULT 0,
      hash TEXT UNIQUE
    )
  `);
});

module.exports = db;