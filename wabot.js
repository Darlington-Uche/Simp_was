// wabot.js
// WhatsApp GC bot with anti-spam + token search by $SYMBOL
// Requires: @whiskeysockets/baileys, pino, qrcode-terminal, axios, fs-extra

cot { default: makeWASocket, useMultiFileAuthState, jidNormalizedUser } = require("@whiskeysockets/baileys")
const P = require("pino")
const qrcode = require("qrcode-terminal")
const axios = require("axios")
const fs = require("fs-extra")
const path = require("path")
const express = require("express");
const app = express();

app.get("/", (req, res) => {
  res.send("WhatsApp bot is running 🚀");
});

// ---------- Storage ----------
const DATA_DIR = "session"
const DB_FILE = path.join(DATA_DIR, "db.json")

const defaultDB = {
  antilink: {},            
  customReplies: {},
  tokenUsage: {} // { userJid: { count: number, lastReset: timestamp } }
}

function loadDB() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirpSync(DATA_DIR)
    if (!fs.existsSync(DB_FILE)) {
      fs.writeFileSync(DB_FILE, JSON.stringify(defaultDB, null, 2))
      return JSON.parse(JSON.stringify(defaultDB))
    }
    return JSON.parse(fs.readFileSync(DB_FILE))
  } catch (e) {
    console.error("DB load error:", e)
    return JSON.parse(JSON.stringify(defaultDB))
  }
}

function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2))
}

// ---------- Helpers ----------
function isAdminOf(groupMetadata, jid) {
  const p = groupMetadata.participants.find(x => jidNormalizedUser(x.id) === jidNormalizedUser(jid))
  return !!(p && (p.admin === "admin" || p.admin === "superadmin" || p.admin === true))
}

function formatNumber(n) {
  if (n === null || n === undefined || isNaN(n)) return "—"
  if (Math.abs(n) >= 1) return Number(n).toLocaleString("en-US", { maximumFractionDigits: 2 })
  return Number(n).toLocaleString("en-US", { maximumFractionDigits: 8 })
}

async function fetchTokenInfo(query) {
  const url = `https://api.dexscreener.com/latest/dex/search/?q=${encodeURIComponent(query)}`
  const res = await axios.get(url, { timeout: 15000 })
  const data = res.data
  if (!data || !Array.isArray(data.pairs) || data.pairs.length === 0) return null

  const pairs = data.pairs.slice().sort((a, b) => (b.volume?.h24 || 0) - (a.volume?.h24 || 0))
  const best = pairs[0]

  const base = best.baseToken || best.token0 || best.token || {}
  const infoBlock = best.info || {}

  const priceUsd = Number(best.priceUsd ?? best.price ?? infoBlock.priceUsd ?? null) || null
  const priceNative = Number(best.priceNative ?? best.nativePrice ?? null) || null
  const marketCap = Number(
    best.marketCap ?? best.market_cap ?? infoBlock.marketCap ?? infoBlock.market_cap ?? best.marketCapUsd ?? null
  ) || null

  const name = base.name || base.symbol || infoBlock.name || infoBlock.symbol || (data.name || null)
  const symbol = base.symbol || infoBlock.symbol || null
  const imageUrl = infoBlock.imageUrl || base.logoURI || base.imageUrl || null

  return { name, symbol, priceUsd, priceNative, marketCap, imageUrl }
}

// ---------- Bot ----------su
async function startBot() {
  const db = loadDB()
  const { state, saveCreds } = await useMultiFileAuthState(DATA_DIR)

  const sock = makeWASocket({
    logger: P({ level: "silent" }),
    auth: state
  })

  sock.ev.on("creds.update", saveCreds)

  // QR & lifecycle
  sock.ev.on("connection.update", (update) => {
  const { connection, lastDisconnect, qr } = update

  if (qr) qrcode.generate(qr, { small: true })

  if (connection === "close") {
    const reason = lastDisconnect?.error?.output?.statusCode
    console.log("❌ Disconnected. Reason:", reason)

    // Only restart if NOT logged out
    if (reason !== 401) {
      startBot().catch(console.error)
    } else {
      console.log("🔒 Logged out. Delete session folder and scan again.")
    }
  }

  if (connection === "open") {
    console.log("✅ Bot connected")
  }
})

  // message handler
  sock.ev.on("messages.upsert", async ({ messages }) => {
    const m = messages[0]
    if (!m || !m.message) return
    const isGroup = m.key.remoteJid && m.key.remoteJid.endsWith?.("@g.us")
    if (!isGroup) return

    const from = m.key.remoteJid    
    const sender = m.key.participant || m.key.remoteJid    
    const text =    
      m.message.conversation ||    
      m.message.extendedTextMessage?.text ||    
      m.message.imageMessage?.caption ||    
      ""    

    const body = text.trim()

    // ---------- Token Search with $SYMBOL ----------
    // ---------- Token Search with $SYMBOL ----------
if (body.startsWith("$")) {
  (async () => {
    const symbol = body.slice(1).trim().toUpperCase()
    if (!symbol) return

    try {
      const info = await fetchTokenInfo(symbol)
      if (!info) {
        await sock.sendMessage(from, { text: `❔ Token $${symbol} not found.` })
        return
      }

      const captionLines = [
        `*${info.name || "Unknown"}* (${info.symbol || "—"})`,
        `Price (USD): $${formatNumber(info.priceUsd)}`,
        `Native price: ${formatNumber(info.priceNative)}`,
        `Market Cap: $${formatNumber(info.marketCap)}`
      ]

      if (info.imageUrl) {
        await sock.sendMessage(from, { image: { url: info.imageUrl }, caption: captionLines.join("\n") })
      } else {
        await sock.sendMessage(from, { text: captionLines.join("\n") })
      }
    } catch (e) {
      console.error("Token fetch error:", e?.message || e)
      await sock.sendMessage(from, { text: "Abeg Rest Headache dey do me " })
    }
  })()
  return
}

    // ---------- Commands ----------
    if (!body.startsWith("!")) return
    const [cmd, ...rest] = body.split(" ")    
    const args = rest.join(" ").trim()    

    try {
      switch (cmd.toLowerCase()) {
        case "!tagall": {
          const meta = await sock.groupMetadata(from)
          const participants = meta.participants.map(p => p.id)
          let out = "📢 *Tagging All Members:*\n\n"
          const mentions = []
          for (let p of participants) {
            mentions.push(p)
            out += `@${p.split("@")[0]} `
          }
          await sock.sendMessage(from, { text: out, mentions })
          break
        }

        case "!lock": {
          const meta = await sock.groupMetadata(from)
          if (!isAdminOf(meta, sender)) {
            await sock.sendMessage(from, { text: "⛔ Admins only." })
            break
          }
          await sock.groupSettingUpdate(from, "announcement")
          await sock.sendMessage(from, { text: "🔒 Group locked (admins only can send messages)" })
          break
        }

        case "!unlock": {
          const meta = await sock.groupMetadata(from)
          if (!isAdminOf(meta, sender)) {
            await sock.sendMessage(from, { text: "⛔ Admins only." })
            break
          }
          await sock.groupSettingUpdate(from, "not_announcement")
          await sock.sendMessage(from, { text: "🔓 Group unlocked (everyone can chat)" })
          break
        }

        case "!antilink": {
          const meta = await sock.groupMetadata(from)
          if (!isAdminOf(meta, sender)) {
            await sock.sendMessage(from, { text: "⛔ Admins only." })
            break
          }
          const t = args.toLowerCase()
          if (t === "on" || t === "off") {
            db.antilink[from] = t === "on"
            saveDB(db)
            await sock.sendMessage(from, { text: `🛡️ Antilink is now *${t.toUpperCase()}*` })
          } else {
            await sock.sendMessage(from, { text: "Usage: *!antilink on* | *!antilink off*" })
          }
          break
        }

        case "!crp": {
          // !crp set trigger=reply    
          // !crp del trigger    
          // !crp list    
          db.customReplies[from] = db.customReplies[from] || {}    
          const sub = args.split(" ")[0]?.toLowerCase()    

          if (sub === "set") {
            const eq = args.slice(3).trim()
            const i = eq.indexOf("=")
            if (i === -1) {
              await sock.sendMessage(from, { text: "Usage: *!crp set trigger=reply*" })
              break
            }
            const trigger = eq.slice(0, i).trim().toLowerCase()
            const reply = eq.slice(i + 1).trim()
            db.customReplies[from][trigger] = reply
            saveDB(db)
            await sock.sendMessage(from, { text: `✅ Saved custom reply for *${trigger}*` })
          } else if (sub === "del") {
            const trigger = args.slice(3).trim().toLowerCase()
            if (db.customReplies[from][trigger]) {
              delete db.customReplies[from][trigger]
              saveDB(db)
              await sock.sendMessage(from, { text: `🗑️ Deleted custom reply for *${trigger}*` })
            } else {
              await sock.sendMessage(from, { text: `Not found: *${trigger}*` })
            }
          } else if (sub === "list") {
            const entries = Object.entries(db.customReplies[from] || {})
            if (entries.length === 0) {
              await sock.sendMessage(from, { text: "No custom replies yet. Add with *!crp set trigger=reply*" })
              break
            }
            const lines = entries.map(([k, v]) => `• *${k}* → ${v}`)
            await sock.sendMessage(from, { text: `📒 *Custom Replies*\n${lines.join("\n")}` })
          }
          break
        }

        case "!t": {
  if (!args) {
    await sock.sendMessage(from, { text: "Usage: *!t <token_symbol_or_address>*" })
    break
  }

  await sock.sendMessage(from, { text: "⏳ Fetching token data..." })

  try {
    const info = await fetchTokenInfo(args)
    if (!info) {
      await sock.sendMessage(from, { text: "❔ Token not found on Dexscreener." })
      break
    }

    const captionLines = [
      `*${info.name || "Unknown"}* (${info.symbol || "—"})`,
      `Price (USD): $${formatNumber(info.priceUsd)}`,
      `Native price: ${formatNumber(info.priceNative)}`,
      `Market Cap: $${formatNumber(info.marketCap)}`
    ]

    if (info.imageUrl) {
      await sock.sendMessage(from, { image: { url: info.imageUrl }, caption: captionLines.join("\n") })
    } else {
      await sock.sendMessage(from, { text: captionLines.join("\n") })
    }
  } catch (e) {
    console.error("Token fetch error:", e?.message || e)
    await sock.sendMessage(from, { text: "You dey check price of watin you no get rest abeg" })
  }

  break
}

        case "!help": {
          await sock.sendMessage(from, {
            text: [
              "🤖 *Bot Menu*",
              "!tagall – Mention all",
              "!lock – Lock group (admins)",
              "!unlock – Unlock group (admins)",
              "!antilink on|off – Delete links (admins)",
              "!crp set a=b – Save custom reply",
              "!crp del a – Remove custom reply",
              "!crp list – View replies",
              "!T <contract/symbol> – Token info",
              "$SYMBOL – Quick token search (PEPE, WBTC, etc.)",
              "⛔ Each user can only do 3 token checks per 24h"
            ].join("\n")
          })
          break
        }
      }
    } catch (err) {
      console.error("Command error:", err?.message || err)
      try { await sock.sendMessage(from, { text: "Rest my head wan burst" }) } catch (e) {}
    }
  })

  function checkUsageLimit(db, user) {
    const now = Date.now()
    const ONE_DAY = 1 * 60 * 60 * 1000
    db.tokenUsage[user] = db.tokenUsage[user] || { count: 0, lastReset: now }
    if (now - db.tokenUsage[user].lastReset > ONE_DAY) {
      db.tokenUsage[user] = { count: 0, lastReset: now }
    }
    if (db.tokenUsage[user].count >= 5) return { allowed: false, left: 0 }
    db.tokenUsage[user].count++
    saveDB(db)
    return { allowed: true, left: 5 - db.tokenUsage[user].count }
  }
}

startBot().catch(console.error)

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});