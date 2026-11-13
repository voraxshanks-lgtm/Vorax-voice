
const express = require("express");
const {
  default: makeWASocket,
  DisconnectReason,
  downloadMediaMessage,
  normalizeMessageContent,
  initAuthCreds
} = require("@whiskeysockets/baileys");

const pino = require("pino");
const ffmpeg = require("ffmpeg-static");
const { execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";

const MAX_ACCOUNTS = 5;
const accounts = new Map();
const processed = new Set();

const tempDir = path.join(os.tmpdir(), "vorax-audio");
fs.mkdirSync(tempDir, { recursive: true });

app.use(express.json({ limit: "20kb" }));

const logger = pino({ level: "silent" });

const effects = {
  femme: {
    name: "VOIX AIGUË",
    filter: "asetrate=48000*1.20,aresample=48000,atempo=0.8333"
  },
  homme: {
    name: "VOIX GRAVE",
    filter: "asetrate=48000*0.85,aresample=48000,atempo=1.1765"
  },
  bebe: {
    name: "EFFET BÉBÉ",
    filter: "asetrate=48000*1.35,aresample=48000,atempo=0.7407"
  },
  vieux: {
    name: "EFFET ÂGÉ",
    filter: "asetrate=48000*0.90,aresample=48000,atempo=1.1111,tremolo=f=5:d=0.15"
  }
};

/* =========================================
   AUTHENTIFICATION ADMIN
========================================= */

function adminAuth(req, res, next) {
  if (!ADMIN_TOKEN) {
    return res.status(503).json({
      error: "ADMIN_TOKEN non configuré sur Render."
    });
  }

  const token = req.headers["x-admin-token"];

  if (typeof token !== "string") {
    return res.status(401).json({ error: "Accès refusé." });
  }

  const received = Buffer.from(token);
  const expected = Buffer.from(ADMIN_TOKEN);

  if (
    received.length !== expected.length ||
    !crypto.timingSafeEqual(received, expected)
  ) {
    return res.status(401).json({ error: "Accès refusé." });
  }

  next();
}

/* =========================================
   AUTHENTIFICATION BAILEYS EN MÉMOIRE
   AUCUN FICHIER DE SESSION
========================================= */

function createMemoryAuthState() {
  const creds = initAuthCreds();
  const keyStore = new Map();

  const keys = {
    get: async (type, ids) => {
      const result = {};

      for (const id of ids) {
        const storageKey = `${type}:${id}`;
        result[id] = keyStore.get(storageKey) || undefined;
      }

      return result;
    },

    set: async (data) => {
      for (const category of Object.keys(data)) {
        const entries = data[category] || {};

        for (const id of Object.keys(entries)) {
          const storageKey = `${category}:${id}`;
          const value = entries[id];

          if (value === null || value === undefined) {
            keyStore.delete(storageKey);
          } else {
            keyStore.set(storageKey, value);
          }
        }
      }
    },

    clear: async () => {
      keyStore.clear();
    }
  };

  return {
    state: { creds, keys },
    saveCreds: async () => {}
  };
}

/* =========================================
   TRANSFORMATION AUDIO
========================================= */

function transformAudio(input, output, filter) {
  return new Promise((resolve, reject) => {
    if (!ffmpeg) {
      return reject(new Error("FFmpeg introuvable."));
    }

    execFile(
      ffmpeg,
      [
        "-y",
        "-i", input,
        "-vn",
        "-af", filter,
        "-ac", "1",
        "-ar", "48000",
        "-c:a", "libopus",
        "-b:a", "32k",
        "-application", "voip",
        "-f", "ogg",
        output
      ],
      {
        timeout: 120000,
        maxBuffer: 1024 * 1024
      },
      (error) => {
        if (error) reject(error);
        else resolve();
      }
    );
  });
}

/* =========================================
   COMMANDES VOCALES
========================================= */

async function handleMessages(account, messages) {
  const sock = account.sock;

  for (const msg of messages) {
    let input;
    let output;

    try {
      if (!msg.message || msg.key.fromMe) continue;

      const jid = msg.key.remoteJid;

      if (!jid || jid === "status@broadcast") continue;

      const content = normalizeMessageContent(msg.message);

      const messageText =
        content?.conversation ||
        content?.extendedTextMessage?.text ||
        "";

      if (!messageText.startsWith("!")) continue;

      const command = messageText
        .slice(1)
        .trim()
        .toLowerCase()
        .split(/\s+/)[0];

      const uniqueId = `${account.id}-${msg.key.id}`;

      if (processed.has(uniqueId)) continue;

      processed.add(uniqueId);

      if (processed.size > 1000) {
        processed.clear();
      }

      if (command === "voicehelp") {
        await sock.sendMessage(
          jid,
          {
            text:
              "🌹 *VORAX VOICE BOT*\n\n" +
              "🎙️ !femme\n" +
              "🎙️ !homme\n" +
              "👶 !bebe\n" +
              "👴 !vieux\n\n" +
              "Réponds à un message vocal avec une commande.\n\n" +
              "🦅 THE SUPREMARCY VORAX EMPIRE"
          },
          { quoted: msg }
        );

        continue;
      }

      if (command === "voice") {
        await sock.sendMessage(
          jid,
          {
            text:
              "🎙️ VORAX VOICE BOT est opérationnel.\n" +
              "Utilise !voicehelp."
          },
          { quoted: msg }
        );

        continue;
      }

      if (!effects[command]) continue;

      const context = content?.extendedTextMessage?.contextInfo;

      if (!context?.quotedMessage || !context.stanzaId) {
        await sock.sendMessage(
          jid,
          {
            text: "⚠️ Réponds à un message vocal avec cette commande."
          },
          { quoted: msg }
        );

        continue;
      }

      const quotedContent = normalizeMessageContent(
        context.quotedMessage
      );

      if (!quotedContent?.audioMessage) {
        await sock.sendMessage(
          jid,
          {
            text: "⚠️ Le message sélectionné doit contenir un audio."
          },
          { quoted: msg }
        );

        continue;
      }

      await sock.sendMessage(
        jid,
        { text: "🎧 Transformation audio en cours..." },
        { quoted: msg }
      );

      const id = crypto.randomUUID();

      input = path.join(tempDir, `${id}.input`);
      output = path.join(tempDir, `${id}.ogg`);

      const quotedMessage = {
        key: {
          remoteJid: jid,
          id: context.stanzaId,
          participant: context.participant,
          fromMe: false
        },
        message: context.quotedMessage
      };

      const buffer = await downloadMediaMessage(
        quotedMessage,
        "buffer",
        {},
        {
          logger,
          reuploadRequest: sock.updateMediaMessage
        }
      );

      if (!buffer || buffer.length === 0) {
        throw new Error("Audio vide.");
      }

      if (buffer.length > 20 * 1024 * 1024) {
        throw new Error("Audio supérieur à 20 Mo.");
      }

      fs.writeFileSync(input, buffer);

      await transformAudio(
        input,
        output,
        effects[command].filter
      );

      const audio = fs.readFileSync(output);

      await sock.sendMessage(
        jid,
        {
          audio,
          mimetype: "audio/ogg; codecs=opus",
          ptt: true
        },
        { quoted: msg }
      );

      console.log(
        `[${account.id}] Transformation : ${command}`
      );

    } catch (error) {
      console.error(
        `[${account.id}] Erreur audio :`,
        error.message
      );

      try {
        await sock.sendMessage(
          msg.key.remoteJid,
          { text: "❌ Échec de la transformation audio." },
          { quoted: msg }
        );
      } catch {}

    } finally {
      if (input && fs.existsSync(input)) {
        fs.unlinkSync(input);
      }

      if (output && fs.existsSync(output)) {
        fs.unlinkSync(output);
      }
    }
  }
}

/* =========================================
   CONNEXION WHATSAPP
========================================= */

function connectAccount(account) {
  if (account.stopped) return;

  const sock = makeWASocket({
    auth: account.state,
    logger,
    markOnlineOnConnect: false,
    syncFullHistory: false
  });

  account.sock = sock;

  sock.ev.on("creds.update", (update) => {
    Object.assign(account.state.creds, update);
  });

  sock.ev.on("messages.upsert", async ({ messages }) => {
    if (!account.stopped && account.sock === sock) {
      await handleMessages(account, messages);
    }
  });

  sock.ev.on("connection.update", async (update) => {
    if (account.stopped || account.sock !== sock) return;

    const { connection, lastDisconnect, qr } = update;

    /*
      Le QR est conservé comme solution de secours.
      Le code de liaison est demandé une seule fois
      automatiquement pour cette tentative.
    */

    if (qr) {
      account.qr = qr;

      if (
        !account.state.creds.registered &&
        !account.pairingRequested
      ) {
        account.pairingRequested = true;
        account.status = "requesting_code";

        try {
          const code = await sock.requestPairingCode(
            account.phone
          );

          if (account.stopped || account.sock !== sock) return;

          account.code = code;
          account.codeAt = Date.now();
          account.lastCodeRequest = Date.now();
          account.status = "waiting_pairing";

          console.log(
            `[${account.id}] Code de liaison généré.`
          );

          account.resolvePairing?.(account);

        } catch (error) {
          account.status = "error";
          account.lastError = error.message;

          console.error(
            `[${account.id}] Erreur pairing :`,
            error.message
          );

          account.rejectPairing?.(error);
        }
      }
    }

    if (connection === "open") {
      account.status = "connected";
      account.code = null;
      account.qr = null;
      account.lastError = null;
      account.reconnectAttempts = 0;

      console.log(
        `[${account.id}] WhatsApp connecté.`
      );

      account.resolvePairing?.(account);
    }

    if (connection === "close") {
      const error = lastDisconnect?.error;
      const statusCode = error?.output?.statusCode;

      console.error(
        `[${account.id}] Connexion fermée.`,
        "Code :", statusCode,
        "Erreur :", error?.message || "Inconnue"
      );

      if (statusCode === DisconnectReason.loggedOut) {
        account.status = "disconnected";
        account.stopped = true;
        account.lastError = "Session déconnectée de WhatsApp.";

        account.rejectPairing?.(
          new Error(account.lastError)
        );

        accounts.delete(account.id);

        return;
      }

      /*
        Si le compte n'a pas encore terminé son appairage,
        on ne lance pas une boucle de reconnexion.
      */

      if (!account.state.creds.registered) {
        account.status = "error";
        account.lastError =
          error?.message || "Connexion interrompue pendant l'appairage.";

        account.rejectPairing?.(
          new Error(account.lastError)
        );

        return;
      }

      if (account.stopped) return;

      account.status = "reconnecting";

      scheduleReconnect(account);
    }
  });
}

/* =========================================
   RECONNEXION CONTRÔLÉE
========================================= */

function scheduleReconnect(account) {
  if (account.stopped || account.reconnectTimer) return;

  if (account.reconnectAttempts >= 5) {
    account.status = "error";
    account.lastError =
      "Trop de tentatives. Une nouvelle connexion manuelle est nécessaire.";

    console.error(
      `[${account.id}] Limite de reconnexion atteinte.`
    );

    return;
  }

  account.reconnectAttempts++;

  const delay = Math.min(
    5000 * account.reconnectAttempts,
    25000
  );

  console.log(
    `[${account.id}] Nouvelle tentative dans ${delay / 1000}s.`
  );

  account.reconnectTimer = setTimeout(() => {
    account.reconnectTimer = null;

    if (account.stopped) return;

    try {
      connectAccount(account);
    } catch (error) {
      account.status = "error";
      account.lastError = error.message;

      console.error(
        `[${account.id}] Reconnexion impossible :`,
        error.message
      );
    }
  }, delay);
}

/* =========================================
   CRÉATION D'UN COMPTE
========================================= */

async function createAccount(phone) {
  if (accounts.size >= MAX_ACCOUNTS) {
    throw new Error("Limite de 5 comptes atteinte.");
  }

  const id = crypto.randomUUID().slice(0, 8);

  const auth = createMemoryAuthState();

  const account = {
    id,
    phone,
    status: "connecting",
    code: null,
    qr: null,
    codeAt: null,
    lastCodeRequest: 0,
    lastError: null,
    sock: null,
    state: auth.state,
    stopped: false,
    pairingRequested: false,
    reconnectAttempts: 0,
    reconnectTimer: null,
    resolvePairing: null,
    rejectPairing: null
  };

  accounts.set(id, account);

  const pairingPromise = new Promise((resolve, reject) => {
    account.resolvePairing = resolve;
    account.rejectPairing = reject;
  });

  try {
    connectAccount(account);

    const timeout = new Promise((_, reject) => {
      setTimeout(() => {
        if (!account.state.creds.registered &&
            account.status !== "waiting_pairing") {
          reject(
            new Error(
              "Aucun code reçu. Vérifie les logs Render et réessaie plus tard."
            )
          );
        }
      }, 25000);
    });

    await Promise.race([pairingPromise, timeout]);

    return account;

  } catch (error) {
    account.stopped = true;

    if (account.reconnectTimer) {
      clearTimeout(account.reconnectTimer);
    }

    try {
      account.sock?.end();
    } catch {}

    accounts.delete(id);

    throw error;
  }
}

/* =========================================
   NOUVEAU CODE MANUEL
========================================= */

async function regenerateCode(account) {
  if (!account.sock || account.stopped) {
    throw new Error("Connexion indisponible.");
  }

  if (account.state.creds.registered) {
    throw new Error("Ce compte est déjà connecté.");
  }

  if (!account.qr) {
    throw new Error(
      "Le socket n'a pas encore généré de QR. Réessaie plus tard."
    );
  }

  const elapsed = Date.now() - account.lastCodeRequest;

  if (elapsed < 60000) {
    const remaining = Math.ceil(
      (60000 - elapsed) / 1000
    );

    throw new Error(
      `Attends encore ${remaining} secondes avant de demander un autre code.`
    );
  }

  account.status = "requesting_code";

  try {
    const code = await account.sock.requestPairingCode(
      account.phone
    );

    account.code = code;
    account.codeAt = Date.now();
    account.lastCodeRequest = Date.now();
    account.status = "waiting_pairing";

    return code;

  } catch (error) {
    account.status = "error";
    account.lastError = error.message;
    throw error;
  }
}

/* =========================================
   SUPPRESSION D'UN COMPTE
========================================= */

async function removeAccount(id) {
  const account = accounts.get(id);

  if (!account) {
    throw new Error("Compte introuvable.");
  }

  account.stopped = true;

  if (account.reconnectTimer) {
    clearTimeout(account.reconnectTimer);
  }

  try {
    await account.sock?.logout();
  } catch {
    try {
      account.sock?.end();
    } catch {}
  }

  accounts.delete(id);
}

/* =========================================
   ROUTES API
========================================= */

app.get("/api/health", (req, res) => {
  res.json({
    service: "VORAX VOICE BOT",
    status: "online",
    maxAccounts: MAX_ACCOUNTS,
    activeAccounts: accounts.size
  });
});

app.get("/api/accounts", adminAuth, (req, res) => {
  res.json({
    maxAccounts: MAX_ACCOUNTS,

    accounts: [...accounts.values()].map((account) => ({
      id: account.id,
      phone: account.phone,
      status: account.status,
      code: account.code,
      codeAt: account.codeAt,
      qr: account.qr,
      lastError: account.lastError
    }))
  });
});

app.post("/api/accounts", adminAuth, async (req, res) => {
  try {
    const phone = String(req.body.phone || "")
      .replace(/\D/g, "");

    if (!/^[1-9]\d{7,14}$/.test(phone)) {
      return res.status(400).json({
        error: "Numéro invalide. Utilise l'indicatif international."
      });
    }

    if (accounts.size >= MAX_ACCOUNTS) {
      return res.status(409).json({
        error: "Les 5 emplacements sont occupés."
      });
    }

    const account = await createAccount(phone);

    res.json({
      success: true,
      id: account.id,
      phone: account.phone,
      code: account.code,
      status: account.status
    });

  } catch (error) {
    console.error(
      "Création du compte :",
      error.message
    );

    res.status(500).json({
      error: error.message
    });
  }
});

app.post(
  "/api/accounts/:id/regenerate",
  adminAuth,
  async (req, res) => {
    try {
      const account = accounts.get(req.params.id);

      if (!account) {
        return res.status(404).json({
          error: "Compte introuvable."
        });
      }

      const code = await regenerateCode(account);

      res.json({
        success: true,
        code,
        status: account.status
      });

    } catch (error) {
      res.status(400).json({
        error: error.message
      });
    }
  }
);

app.delete(
  "/api/accounts/:id",
  adminAuth,
  async (req, res) => {
    try {
      await removeAccount(req.params.id);

      res.json({
        success: true,
        message: "Compte déconnecté."
      });

    } catch (error) {
      res.status(404).json({
        error: error.message
      });
    }
  }
);

/* =========================================
   PANNEAU WEB
========================================= */

app.get("/", (req, res) => {
  res.type("html").send(`<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#070a09">
<title>VORAX VOICE BOT</title>

<script src="https://cdn.jsdelivr.net/npm/qrcodejs@1.0.0/qrcode.min.js"><\/script>

<style>
*{box-sizing:border-box}
body{
  margin:0;
  background:#070a09;
  color:#eee;
  font-family:Arial,sans-serif;
  padding:20px
}
header{text-align:center;padding:25px 5px}
h1{color:#d6ae54;letter-spacing:3px}
.sub{color:#999;font-size:12px}
.panel{
  background:#101713;
  border:1px solid #41351c;
  border-radius:15px;
  padding:18px;
  margin:15px auto;
  max-width:550px
}
input{
  width:100%;
  background:#080d0b;
  color:white;
  border:1px solid #544421;
  padding:14px;
  border-radius:9px;
  margin:8px 0
}
button{
  background:#c49a42;
  color:#080808;
  border:0;
  padding:13px;
  border-radius:8px;
  font-weight:bold;
  cursor:pointer
}
button:disabled{opacity:.5}
.full{width:100%}
.account{
  border:1px solid #39301d;
  background:#0a100d;
  padding:15px;
  border-radius:10px;
  margin-top:12px
}
.status{color:#d6ae54;font-size:12px}
.code{
  font-size:23px;
  letter-spacing:5px;
  color:#e9c66d;
  margin:12px 0;
  font-weight:bold
}
.qrbox{
  background:white;
  padding:10px;
  border-radius:10px;
  width:210px;
  margin:12px auto;
  text-align:center
}
.danger{background:#a32236;color:white}
.secondary{background:#222;color:#eee;margin-top:8px}
#dashboard{display:none}
#message{color:#e5c16b;font-size:13px}
.error{color:#ff7777}
footer{
  text-align:center;
  color:#666;
  font-size:11px;
  margin:30px
}
</style>
</head>

<body>

<header>
  <h1>🌹 VORAX</h1>
  <div class="sub">VOICE BOT — MULTI ACCOUNT</div>
  <p class="sub">THE SUPREMARCY
