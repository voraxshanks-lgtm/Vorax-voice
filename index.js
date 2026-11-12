const express = require("express");
const {
  default: makeWASocket,
  DisconnectReason,
  downloadMediaMessage,
  normalizeMessageContent,
  useMultiFileAuthState
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
const authDir = path.join(__dirname, "auth");
fs.mkdirSync(tempDir, { recursive: true });
fs.mkdirSync(authDir, { recursive: true });

app.use(express.json({ limit: "20kb" }));

const effects = {
  femme: { name: "VOIX AIGUË", filter: "asetrate=48000*1.20,aresample=48000,atempo=0.8333" },
  homme: { name: "VOIX GRAVE", filter: "asetrate=48000*0.85,aresample=48000,atempo=1.1765" },
  bebe: { name: "EFFET BÉBÉ", filter: "asetrate=48000*1.35,aresample=48000,atempo=0.7407" },
  vieux: { name: "EFFET ÂGÉ", filter: "asetrate=48000*0.90,aresample=48000,atempo=1.1111,tremolo=f=5:d=0.15" }
};

function adminAuth(req, res, next) {
  if (!ADMIN_TOKEN) return res.status(503).json({ error: "ADMIN_TOKEN non configuré sur Render." });
  const token = req.headers["x-admin-token"];
  if (typeof token !== "string" || token.length !== ADMIN_TOKEN.length || !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(ADMIN_TOKEN))) {
    return res.status(401).json({ error: "Accès refusé." });
  }
  next();
}

function transformAudio(input, output, filter) {
  return new Promise((resolve, reject) => {
    execFile(ffmpeg, ["-y", "-i", input, "-vn", "-af", filter, "-ac", "1", "-ar", "48000", "-c:a", "libopus", "-b:a", "32k", "-application", "voip", "-f", "ogg", output],
      { timeout: 120000, maxBuffer: 1024 * 1024 },
      (error) => error ? reject(error) : resolve());
  });
}

async function handleMessages(account, messages) {
  const sock = account.sock;
  for (const msg of messages) {
    let input, output;
    try {
      if (!msg.message || msg.key.fromMe) continue;
      const jid = msg.key.remoteJid;
      if (!jid || jid === "status@broadcast") continue;
      const content = normalizeMessageContent(msg.message);
      const text = content?.conversation || content?.extendedTextMessage?.text || "";
      if (!text.startsWith("!")) continue;
      const command = text.slice(1).trim().toLowerCase().split(/\s+/)[0];
      const uniqueId = `${account.id}-${msg.key.id}`;
      if (processed.has(uniqueId)) continue;
      processed.add(uniqueId);
      if (processed.size > 1000) processed.clear();

      if (command === "voicehelp") {
        await sock.sendMessage(jid, { text: `🌹 *VORAX VOICE BOT*\n\n🎙️ !femme\n🎙️ !homme\n👶 !bebe\n👴 !vieux\n\nRéponds à un message vocal avec une commande.\n\n🦅 THE SUPREMARCY VORAX EMPIRE` }, { quoted: msg });
        continue;
      }
      if (command === "voice") {
        await sock.sendMessage(jid, { text: "🎙️ VORAX VOICE BOT est opérationnel. Utilise !voicehelp." }, { quoted: msg });
        continue;
      }
      if (!effects[command]) continue;

      const context = content?.extendedTextMessage?.contextInfo;
      if (!context?.quotedMessage || !context.stanzaId) {
        await sock.sendMessage(jid, { text: "⚠️ Réponds à un message vocal avec cette commande." }, { quoted: msg });
        continue;
      }
      const quotedContent = normalizeMessageContent(context.quotedMessage);
      if (!quotedContent?.audioMessage) {
        await sock.sendMessage(jid, { text: "⚠️ Le message sélectionné doit contenir un audio." }, { quoted: msg });
        continue;
      }
      await sock.sendMessage(jid, { text: "🎧 Transformation audio en cours..." }, { quoted: msg });

      const id = crypto.randomUUID();
      input = path.join(tempDir, `${id}.input`);
      output = path.join(tempDir, `${id}.ogg`);
      const quotedMessage = { key: { remoteJid: jid, id: context.stanzaId, participant: context.participant, fromMe: false }, message: context.quotedMessage };
      const buffer = await downloadMediaMessage(quotedMessage, "buffer", {}, { logger: pino({ level: "silent" }), reuploadRequest: sock.updateMediaMessage });
      if (!buffer || buffer.length === 0) throw new Error("Audio vide.");
      if (buffer.length > 20 * 1024 * 1024) throw new Error("Audio supérieur à 20 Mo.");
      fs.writeFileSync(input, buffer);
      await transformAudio(input, output, effects[command].filter);
      const audio = fs.readFileSync(output);
      await sock.sendMessage(jid, { audio, mimetype: "audio/ogg; codecs=opus", ptt: true }, { quoted: msg });
      console.log(`[${account.id}] Transformation : ${command}`);
    } catch (error) {
      console.error(`[${account.id}] Erreur audio :`, error.message);
      try { await sock.sendMessage(msg.key.remoteJid, { text: "❌ Échec de la transformation audio." }, { quoted: msg }); } catch {}
    } finally {
      if (input && fs.existsSync(input)) fs.unlinkSync(input);
      if (output && fs.existsSync(output)) fs.unlinkSync(output);
    }
  }
}

async function createAccount(phone) {
  if (accounts.size >= MAX_ACCOUNTS) throw new Error("Limite de 5 comptes atteinte.");
  const id = crypto.randomUUID().slice(0, 8);
  const { state, saveCreds } = await useMultiFileAuthState(path.join(authDir, id));

  const account = { id, phone, status: "connecting", code: null, qr: null, codeAt: null, sock: null, state, saveCreds, stopped: false, reconnectTimer: null };
  accounts.set(id, account);

  try {
    await connectAccount(account);
    await new Promise(r => setTimeout(r, 2000));
    if (account.stopped) throw new Error("Connexion annulée.");
    if (state.creds.registered) { account.status = "connected"; return account; }

    account.code = await account.sock.requestPairingCode(phone);
    account.codeAt = Date.now();
    account.status = "waiting_pairing";
    return account;
  } catch (error) {
    accounts.delete(id);
    try { account.sock?.end(); } catch {}
    throw error;
  }
}

async function regenerateCode(account) {
  if (!account.sock) throw new Error("Socket introuvable.");
  if (account.state.creds.registered) throw new Error("Compte déjà connecté.");
  account.code = await account.sock.requestPairingCode(account.phone);
  account.codeAt = Date.now();
  account.status = "waiting_pairing";
  return account.code;
}

async function connectAccount(account) {
  if (account.stopped) return;
  const sock = makeWASocket({
    auth: account.state,
    logger: pino({ level: "silent" }),
    // AJOUT 1 : vrai nom de navigateur, sinon WhatsApp refuse le code
    browser: ["Ubuntu", "Chrome", "20.0.04"],
    markOnlineOnConnect: false,
    syncFullHistory: false
  });
  account.sock = sock;
  sock.ev.on("creds.update", account.saveCreds);
  sock.ev.on("messages.upsert", async ({ messages }) => { if (!account.stopped) await handleMessages(account, messages); });

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // AJOUT 2 : QR de secours
    if (qr) { account.qr = qr; console.log(`[${account.id}] QR généré.`); }

    if (connection === "open") {
      account.status = "connected";
      account.code = null;
      account.qr = null;
      console.log(`[${account.id}] WhatsApp connecté.`);
    }
    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        account.status = "disconnected";
        account.stopped = true;
        accounts.delete(account.id);
        console.log(`[${account.id}] Compte déconnecté.`);
        return;
      }
      if (account.status === "waiting_pairing") {
        console.log(`[${account.id}] En attente du code, pas de reconnexion.`);
        return;
      }
      if (!account.stopped) {
        account.status = "reconnecting";
        account.reconnectTimer = setTimeout(() => {
          connectAccount(account).catch(e => { console.error("Reconnexion impossible :", e.message); account.status = "error"; });
        }, 5000);
      }
    }
  });
}

async function removeAccount(id) {
  const account = accounts.get(id);
  if (!account) throw new Error("Compte introuvable.");
  account.stopped = true;
  if (account.reconnectTimer) clearTimeout(account.reconnectTimer);
  try { await account.sock?.logout(); } catch { try { account.sock?.end(); } catch {} }
  accounts.delete(id);
  try { fs.rmSync(path.join(authDir, id), { recursive: true, force: true }); } catch {}
}

app.get("/api/health", (req, res) => res.json({ service: "VORAX VOICE BOT", status: "online", maxAccounts: MAX_ACCOUNTS, activeAccounts: accounts.size }));

app.get("/api/accounts", adminAuth, (req, res) => {
  res.json({ maxAccounts: MAX_ACCOUNTS, accounts: [...accounts.values()].map(a => ({ id: a.id, phone: a.phone, status: a.status, code: a.code, codeAt: a.codeAt || null, qr: a.qr || null })) });
});

app.post("/api/accounts", adminAuth, async (req, res) => {
  try {
    const phone = String(req.body.phone || "").replace(/\D/g, "");
    if (!/^[1-9]\d{7,14}$/.test(phone)) return res.status(400).json({ error: "Numéro invalide. Utilise l'indicatif international." });
    if (accounts.size >= MAX_ACCOUNTS) return res.status(409).json({ error: "Les 5 emplacements sont occupés." });
    const account = await createAccount(phone);
    res.json({ success: true, id: account.id, phone: account.phone, code: account.code, status: account.status });
  } catch (error) { console.error("Création du compte :", error.message); res.status(500).json({ error: error.message }); }
});

app.post("/api/accounts/:id/regenerate", adminAuth, async (req, res) => {
  try {
    const account = accounts.get(req.params.id);
    if (!account) return res.status(404).json({ error: "Compte introuvable." });
    const code = await regenerateCode(account);
    res.json({ success: true, code, status: account.status });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.delete("/api/accounts/:id", adminAuth, async (req, res) => {
  try { await removeAccount(req.params.id); res.json({ success: true, message: "Compte déconnecté." }); }
  catch (error) { res.status(404).json({ error: error.message }); }
});

app.get("/", (req, res) => {
  res.type("html").send(`<!DOCTYPE html>
<html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>VORAX VOICE BOT</title>
<script src="https://cdn.jsdelivr.net/npm/qrcodejs@1.0.0/qrcode.min.js"><\/script>
<style>
*{box-sizing:border-box} body{margin:0;background:#070a09;color:#eee;font-family:Arial,sans-serif;padding:20px}
header{text-align:center;padding:25px 5px} h1{color:#d6ae54;letter-spacing:3px} .sub{color:#999;font-size:12px}
.panel{background:#101713;border:1px solid #41351c;border-radius:15px;padding:18px;margin:15px auto;max-width:550px}
input{width:100%;background:#080d0b;color:white;border:1px solid #544421;padding:14px;border-radius:9px;margin:8px 0}
button{background:#c49a42;color:#080808;border:0;padding:13px;border-radius:8px;font-weight:bold;cursor:pointer}
button:disabled{opacity:.5} .full{width:100%} .account{border:1px solid #39301d;background:#0a100d;padding:15px;border-radius:10px;margin-top:12px}
.status{color:#d6ae54;font-size:12px} .code{font-size:23px;letter-spacing:5px;color:#e9c66d;margin:12px 0;font-weight:bold}
.qrbox{background:white;padding:10px;border-radius:10px;width:210px;margin:12px auto;text-align:center}
.danger{background:#a32236;color:white} .secondary{background:#222;color:#eee;margin-top:8px} #dashboard{display:none} #message{color:#e5c16b;font-size:13px}
footer{text-align:center;color:#666;font-size:11px;margin:30px}
</style></head><body>
<header><h1>🌹 VORAX</h1><div class="sub">VOICE BOT — MULTI ACCOUNT</div><p class="sub">THE SUPREMARCY VORAX EMPIRE 🦅</p></header>
<div class="panel" id="login"><h3>ADMINISTRATION</h3><input id="token" type="password" placeholder="Mot de passe administrateur"><button class="full" onclick="login()">ACCÉDER AU PANEL</button></div>
<div id="dashboard">
<div class="panel"><h3>CONNEXION WHATSAPP</h3><p class="sub">Maximum 5 comptes — ex : 22507xxxxxxxx, sans + et sans 0</p>
<input id="phone" type="tel" placeholder="Indicatif + numéro (ex : 225...)">
<button class="full" id="add" onclick="addAccount()">GÉNÉRER UN CODE</button><p id="message"></p></div>
<div class="panel"><h3>MES COMPTES</h3><div id="accounts"></div></div>
<div class="panel"><h3>COMMANDES VOCALES</h3><p>🎙️ !femme — Effet aigu</p><p>🎙️ !homme — Effet grave</p><p>👶 !bebe — Effet enfantin</p><p>👴 !vieux — Effet âgé</p><p>📖 !voicehelp — Aide</p></div>
</div>
<footer>VORAX VOICE BOT © 2026<br>SESSIONS EN FICHIER — AUDIO TEMPORAIRE</footer>
<script>
let adminToken = "";
let autoRegenCount = {};
let regenInProgress = {};
async function api(url, options={}) {
  const response = await fetch(url, { ...options, headers: { "Content-Type": "application/json", "x-admin-token": adminToken, ...(options.headers || {}) } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Erreur serveur");
  return data;
}
async function login() {
  adminToken = document.getElementById("token").value;
  try { await api("/api/accounts"); document.getElementById("login").style.display = "none"; document.getElementById("dashboard").style.display = "block"; refresh(); setInterval(refresh, 1000); }
  catch (e) { alert(e.message); }
}
async function addAccount() {
  const phone = document.getElementById("phone").value.trim();
  const button = document.getElementById("add"); const message = document.getElementById("message");
  button.disabled = true; message.textContent = "Connexion en préparation...";
  try {
    const result = await api("/api/accounts", { method: "POST", body: JSON.stringify({ phone }) });
    message.textContent = result.code ? "Code : " + result.code + " — Tape-le VITE, ou scanne le QR en dessous." : "Compte ajouté. Vérifie son état.";
    document.getElementById("phone").value = ""; refresh();
  } catch (e) { message.textContent = e.message; } finally { button.disabled = false; }
}
async function regenerate(id, auto = false) {
  if (regenInProgress[id]) return;
  regenInProgress[id] = true;
  try { const r = await api("/api/accounts/" + encodeURIComponent(id) + "/regenerate", { method: "POST" }); autoRegenCount[id] = auto ? (autoRegenCount[id] || 0) + 1 : 0; if (!auto) alert("Nouveau code : " + r.code); refresh(); }
  catch (e) { if (!auto) alert(e.message); } finally { regenInProgress[id] = false; }
}
async function disconnect(id) {
  if (!confirm("Déconnecter ce compte WhatsApp ?")) return;
  try { await api("/api/accounts/" + encodeURIComponent(id), { method: "DELETE" }); refresh(); } catch (e) { alert(e.message); }
}
async function refresh() {
  try {
    const data = await api("/api/accounts"); const area = document.getElementById("accounts"); area.innerHTML = "";
    for (const account of data.accounts) {
      const div = document.createElement("div"); div.className = "account";
      const title = document.createElement("strong"); title.textContent = account.phone;
      const status = document.createElement("p"); status.className = "status"; status.textContent = "État : " + account.status;
      div.append(title, status);

      if (account.qr) {
        const qtitle = document.createElement("p"); qtitle.className = "sub"; qtitle.textContent = "📷 OU SCANNE CE QR AVEC WHATSAPP :"; qtitle.style.textAlign = "center"; div.append(qtitle);
        const qrbox = document.createElement("div"); qrbox.className = "qrbox"; div.append(qrbox);
        new QRCode(qrbox, { text: account.qr, width: 190, height: 190 });
        const qhelp = document.createElement("p"); qhelp.className = "sub"; qhelp.textContent = "WhatsApp > Appareils liés > Lier un appareil, et scanne. Si le QR marche mais pas le code, c'est le pairing qui est bloqué."; qhelp.style.textAlign = "center"; div.append(qhelp);
      }

      if (account.code) {
        const code = document.createElement("div"); code.className = "code"; code.textContent = account.code; div.append(code);
        const timer = document.createElement("p"); timer.className = "status";
        const elapsed = account.codeAt ? (Date.now() - account.codeAt) / 1000 : 99;
        const left = Math.max(0, Math.ceil(30 - elapsed));
        timer.textContent = left > 0 ? "⏳ Code valable encore : " + left + "s — TAPE-LE MAINTENANT" : "❌ Code expiré — nouveau code en cours...";
        timer.style.color = left > 0 ? "#e9c66d" : "#ff5555"; timer.style.fontWeight = "bold"; div.append(timer);
        if (left <= 0 && (autoRegenCount[account.id] || 0) < 3) regenerate(account.id, true);
        if (left <= 0 && (autoRegenCount[account.id] || 0) >= 3) { const s = document.createElement("p"); s.className = "sub"; s.textContent = "⚠️ 3 codes expirés. Attends 1 min, puis RÉGÉNÉRER."; s.style.color = "#ff5555"; div.append(s); }
        const regen = document.createElement("button"); regen.className = "secondary full"; regen.textContent = "🔄 RÉGÉNÉRER LE CODE"; regen.onclick = () => { autoRegenCount[account.id] = 0; regenerate(account.id, false); }; div.append(regen);
      }
      const button = document.createElement("button"); button.className = "danger"; button.textContent = "DÉCONNECTER"; button.style.marginTop = "8px"; button.onclick = () => disconnect(account.id);
      div.append(button); area.append(div);
    }
    if (!data.accounts.length) area.textContent = "Aucun compte connecté.";
  } catch (e) { console.error(e); }
}
</script></body></html>`);
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("==================================");
  console.log(" VORAX VOICE BOT — MULTI ACCOUNT");
  console.log(" Maximum : 5 comptes");
  console.log(" Sessions : fichiers ./auth");
  console.log(" Port :", PORT);
  console.log("==================================");
});
