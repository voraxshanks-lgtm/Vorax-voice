
const express = require("express");
const {
  default: makeWASocket,
  initAuthCreds,
  DisconnectReason,
  downloadMediaMessage,
  normalizeMessageContent,
  proto
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

// ========================================
// AUTHENTIFICATION DU TABLEAU DE BORD
// ========================================

function adminAuth(req, res, next) {
  if (!ADMIN_TOKEN) {
    return res.status(503).json({
      error: "ADMIN_TOKEN non configuré sur Render."
    });
  }

  const token = req.headers["x-admin-token"];

  if (
    typeof token !== "string" ||
    token.length !== ADMIN_TOKEN.length ||
    !crypto.timingSafeEqual(
      Buffer.from(token),
      Buffer.from(ADMIN_TOKEN)
    )
  ) {
    return res.status(401).json({
      error: "Accès refusé."
    });
  }

  next();
}

// ========================================
// AUTHENTIFICATION WHATSAPP EN RAM
// AUCUN FICHIER DE SESSION
// ========================================

function createMemoryAuth() {
  const creds = initAuthCreds();
  const store = new Map();

  const keys = {
    get: async (type, ids) => {
      const result = {};

      for (const id of ids) {
        let value = store.get(`${type}-${id}`);

        if (type === "app-state-sync-key" && value) {
          value = proto.Message.AppStateSyncKeyData.fromObject(value);
        }

        result[id] = value;
      }

      return result;
    },

    set: async (data) => {
      for (const type in data) {
        for (const id in data[type]) {
          const value = data[type][id];
          const key = `${type}-${id}`;

          if (value) {
            store.set(key, value);
          } else {
            store.delete(key);
          }
        }
      }
    }
  };

  return {
    state: { creds, keys },
    saveCreds: async (update) => {
      Object.assign(creds, update);
    }
  };
}

// ========================================
// TRAITEMENT AUDIO
// ========================================

function transformAudio(input, output, filter) {
  return new Promise((resolve, reject) => {
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
        if (error) return reject(error);
        resolve();
      }
    );
  });
}

// ========================================
// GESTION DES MESSAGES
// ========================================

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

      const text =
        content?.conversation ||
        content?.extendedTextMessage?.text ||
        "";

      if (!text.startsWith("!")) continue;

      const command = text
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
        await sock.sendMessage(jid, {
          text:
`🌹 *VORAX VOICE BOT*

Commandes disponibles :

🎙️ !femme
🎙️ !homme
👶 !bebe
👴 !vieux

Réponds à un message vocal avec une commande.

🦅 THE SUPREMARCY VORAX EMPIRE`
        }, { quoted: msg });

        continue;
      }

      if (command === "voice") {
        await sock.sendMessage(jid, {
          text: "🎙️ VORAX VOICE BOT est opérationnel. Utilise !voicehelp."
        }, { quoted: msg });

        continue;
      }

      if (!effects[command]) continue;

      const context =
        content?.extendedTextMessage?.contextInfo;

      if (!context?.quotedMessage || !context.stanzaId) {
        await sock.sendMessage(jid, {
          text: "⚠️ Réponds à un message vocal avec cette commande."
        }, { quoted: msg });

        continue;
      }

      const quotedContent = normalizeMessageContent(
        context.quotedMessage
      );

      if (!quotedContent?.audioMessage) {
        await sock.sendMessage(jid, {
          text: "⚠️ Le message sélectionné doit contenir un audio."
        }, { quoted: msg });

        continue;
      }

      await sock.sendMessage(jid, {
        text: "🎧 Transformation audio en cours..."
      }, { quoted: msg });

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
          logger: pino({ level: "silent" }),
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

      await sock.sendMessage(jid, {
        audio,
        mimetype: "audio/ogg; codecs=opus",
        ptt: true
      }, { quoted: msg });

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
          {
            text: "❌ Échec de la transformation audio."
          },
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

// ========================================
// CRÉATION D'UN COMPTE WHATSAPP
// ========================================

async function createAccount(phone) {
  if (accounts.size >= MAX_ACCOUNTS) {
    throw new Error("Limite de 5 comptes atteinte.");
  }

  const id = crypto.randomUUID().slice(0, 8);

  const auth = createMemoryAuth();

  const account = {
    id,
    phone,
    status: "connecting",
    code: null,
    sock: null,
    auth,
    stopped: false,
    reconnectTimer: null
  };

  accounts.set(id, account);

  try {
    await connectAccount(account);

    await new Promise(resolve => setTimeout(resolve, 1500));

    if (account.stopped) {
      throw new Error("Connexion annulée.");
    }

    if (account.auth.state.creds.registered) {
      account.status = "connected";
      return account;
    }

    account.code = await account.sock.requestPairingCode(phone);

    account.status = "waiting_pairing";

    return account;

  } catch (error) {
    accounts.delete(id);

    try {
      account.sock?.end();
    } catch {}

    throw error;
  }
}

// ========================================
// CONNEXION ET RECONNEXION
// ========================================

async function connectAccount(account) {
  if (account.stopped) return;

  const sock = makeWASocket({
    auth: account.auth.state,
    logger: pino({ level: "silent" }),
    browser: [
      "VORAX VOICE BOT",
      "Chrome",
      "2.0.0"
    ],
    markOnlineOnConnect: false,
    syncFullHistory: false
  });

  account.sock = sock;

  sock.ev.on("creds.update", account.auth.saveCreds);

  sock.ev.on("messages.upsert", async ({ messages }) => {
    if (!account.stopped) {
      await handleMessages(account, messages);
    }
  });

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === "open") {
      account.status = "connected";
      account.code = null;

      console.log(`[${account.id}] WhatsApp connecté.`);
    }

    if (connection === "close") {
      const code =
        lastDisconnect?.error?.output?.statusCode;

      if (code === DisconnectReason.loggedOut) {
        account.status = "disconnected";
        account.stopped = true;
        accounts.delete(account.id);

        console.log(`[${account.id}] Compte déconnecté.`);
        return;
      }

      if (!account.stopped) {
        account.status = "reconnecting";

        account.reconnectTimer = setTimeout(() => {
          connectAccount(account).catch(error => {
            console.error("Reconnexion impossible :", error.message);
            account.status = "error";
          });
        }, 5000);
      }
    }
  });
}

// ========================================
// DÉCONNEXION INDIVIDUELLE
// ========================================

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

// ========================================
// API DU TABLEAU DE BORD
// ========================================

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
    accounts: [...accounts.values()].map(account => ({
      id: account.id,
      phone: account.phone,
      status: account.status,
      code: account.code
    }))
  });
});

app.post("/api/accounts", adminAuth, async (req, res) => {
  try {
    const phone = String(req.body.phone || "").replace(/\D/g, "");

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
    console.error("Création du compte :", error.message);

    res.status(500).json({
      error: error.message
    });
  }
});

app.delete("/api/accounts/:id", adminAuth, async (req, res) => {
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
});

// ========================================
// INTERFACE WEB
// ========================================

app.get("/", (req, res) => {
  res.type("html").send(`<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#080b0a">
<title>VORAX VOICE BOT</title>

<style>
*{box-sizing:border-box}
body{
  margin:0;
  background:#070a09;
  color:#eee;
  font-family:Arial,sans-serif;
  padding:20px;
}
header{
  text-align:center;
  padding:25px 5px;
}
h1{
  color:#d6ae54;
  letter-spacing:3px;
}
.sub{color:#999;font-size:12px}
.panel{
  background:#101713;
  border:1px solid #41351c;
  border-radius:15px;
  padding:18px;
  margin:15px auto;
  max-width:550px;
}
input{
  width:100%;
  background:#080d0b;
  color:white;
  border:1px solid #544421;
  padding:14px;
  border-radius:9px;
  margin:8px 0;
}
button{
  background:#c49a42;
  color:#080808;
  border:0;
  padding:13px;
  border-radius:8px;
  font-weight:bold;
  cursor:pointer;
}
button:disabled{opacity:.5}
.full{width:100%}
.account{
  border:1px solid #39301d;
  background:#0a100d;
  padding:15px;
  border-radius:10px;
  margin-top:12px;
}
.status{color:#d6ae54;font-size:12px}
.code{
  font-size:23px;
  letter-spacing:5px;
  color:#e9c66d;
  margin:12px 0;
  font-weight:bold;
}
.danger{background:#a32236;color:white}
#dashboard{display:none}
#message{color:#e5c16b;font-size:13px}
footer{text-align:center;color:#666;font-size:11px;margin:30px}
</style>
</head>

<body>

<header>
<h1>🌹 VORAX</h1>
<div class="sub">VOICE BOT — MULTI ACCOUNT</div>
<p class="sub">THE SUPREMARCY VORAX EMPIRE 🦅</p>
</header>

<div class="panel" id="login">
<h3>ADMINISTRATION</h3>
<input id="token" type="password"
placeholder="Mot de passe administrateur">
<button class="full" onclick="login()">ACCÉDER AU PANEL</button>
</div>

<div id="dashboard">

<div class="panel">
<h3>CONNEXION WHATSAPP</h3>
<p class="sub">Maximum 5 comptes simultanément</p>

<input id="phone" type="tel"
placeholder="Indicatif + numéro (ex : 225...)">

<button class="full" id="add"
onclick="addAccount()">GÉNÉRER UN CODE</button>

<p id="message"></p>
</div>

<div class="panel">
<h3>MES COMPTES</h3>
<div id="accounts"></div>
</div>

<div class="panel">
<h3>COMMANDES VOCALES</h3>
<p>🎙️ !femme — Effet aigu</p>
<p>🎙️ !homme — Effet grave</p>
<p>👶 !bebe — Effet enfantin</p>
<p>👴 !vieux — Effet âgé</p>
<p>📖 !voicehelp — Aide</p>
</div>

</div>

<footer>
VORAX VOICE BOT © 2026<br>
AUDIO TEMPORAIRE — SESSIONS EN MÉMOIRE
</footer>

<script>
let adminToken = "";

async function api(url, options={}) {
  const response = await fetch(url, {
    ...options,
    headers:{
      "Content-Type":"application/json",
      "x-admin-token":adminToken,
      ...(options.headers || {})
    }
  });

  const data = await response.json();

  if(!response.ok) {
    throw new Error(data.error || "Erreur serveur");
  }

  return data;
}

async function login(){
  adminToken=document.getElementById("token").value;

  try{
    await api("/api/accounts");
    document.getElementById("login").style.display="none";
    document.getElementById("dashboard").style.display="block";
    refresh();
  }catch(e){
    alert(e.message);
  }
}

async function addAccount(){
  const phone=document.getElementById("phone").value.trim();
  const button=document.getElementById("add");
  const message=document.getElementById("message");

  button.disabled=true;
  message.textContent="Connexion en préparation...";

  try{
    const result=await api("/api/accounts",{
      method:"POST",
      body:JSON.stringify({phone})
    });

    message.textContent=result.code
      ? "Code : "+result.code+" — À saisir dans WhatsApp."
      : "Compte ajouté. Vérifie son état.";

    document.getElementById("phone").value="";
    refresh();
  }catch(e){
    message.textContent=e.message;
  }finally{
    button.disabled=false;
  }
}

async function disconnect(id){
  if(!confirm("Déconnecter ce compte WhatsApp ?"))return;

  try{
    await api("/api/accounts/"+encodeURIComponent(id),{
      method:"DELETE"
    });
    refresh();
  }catch(e){
    alert(e.message);
  }
}

async function refresh(){
  try{
    const data=await api("/api/accounts");
    const area=document.getElementById("accounts");

    area.innerHTML="";

    for(const account of data.accounts){
      const div=document.createElement("div");
      div.className="account";

      const title=document.createElement("strong");
      title.textContent=account.phone;

      const status=document.createElement("p");
      status.className="status";
      status.textContent="État : "+account.status;

      div.append(title,status);

      if(account.code){
        const code=document.createElement("div");
        code.className="code";
        code.textContent=account.code;
        div.append(code);

        const help=document.createElement("p");
        help.className="sub";
        help.textContent="Saisis ce code dans WhatsApp > Appareils connectés > Connecter un appareil > Lier avec numéro.";
        div.append(help);
      }

      const button=document.createElement("button");
      button.className="danger";
      button.textContent="DÉCONNECTER";
      button.onclick=()=>disconnect(account.id);

      div.append(button);
      area.append(div);
    }

    if(!data.accounts.length){
      area.textContent="Aucun compte connecté.";
    }
  }catch(e){
    console.error(e);
  }
}

</script>
</body>
</html>`);
});

// ========================================
// DÉMARRAGE
// ========================================

app.listen(PORT, "0.0.0.0", () => {
  console.log("==================================");
  console.log(" VORAX VOICE BOT — MULTI ACCOUNT");
  console.log(" Maximum : 5 comptes");
  console.log(" Stockage permanent : désactivé");
  console.log(" Port :", PORT);
  console.log("==================================");
});
