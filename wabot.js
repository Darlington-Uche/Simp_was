// wabot.js
// Simplified WhatsApp GC bot: tagall, lock/unlock, custom replies, antilink (delete), token info (name, symbol, price, native price, market cap)
// Requires: @whiskeysockets/baileys, pino, qrcode-terminal, axios, fs-extra

const { default: makeWASocket, useMultiFileAuthState, jidNormalizedUser } = require("@whiskeysockets/baileys")
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
  antilink: {},            // { [groupJid]: true|false }
  customReplies: {}        // { [groupJid]: { [trigger]: reply } }
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

function detectLink(text) {
  if (!text) return false
  const invite = /chat\.whatsapp\.com\/[A-Za-z0-9_-]+/i
  const generic = /https?:\/\/[^\s]+/i
  return invite.test(text) || generic.test(text)
}

function formatNumber(n) {
  if (n === null || n === undefined || isNaN(n)) return "—"
  // show 2 decimals for big numbers, else up to 8
  if (Math.abs(n) >= 1) return Number(n).toLocaleString("en-US", { maximumFractionDigits: 2 })
  return Number(n).toLocaleString("en-US", { maximumFractionDigits: 8 })
}

// ---------- Dexscreener token fetch (simplified) ----------
async function fetchTokenInfo(contract) {
  // Dexscreener tokens endpoint
  const url = `https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(contract)}`
  const res = await axios.get(url, { timeout: 15000 })
  const data = res.data
  if (!data || !Array.isArray(data.pairs) || data.pairs.length === 0) return null

  // choose the pair with highest 24h volume (best liquidity)
  const pairs = data.pairs.slice().sort((a, b) => (b.volume?.h24 || 0) - (a.volume?.h24 || 0))
  const best = pairs[0]

  // try several fields for base token info
  const base = best.baseToken || best.token0 || best.token || {}
  const infoBlock = best.info || {}

  // price fields (try a few keys)
  const priceUsd = Number(best.priceUsd ?? best.price ?? infoBlock.priceUsd ?? null) || null
  const priceNative = Number(best.priceNative ?? best.nativePrice ?? null) || null

  // market cap (mcap) — dex responses vary; try multiple possibilities
  const marketCap = Number(
    best.marketCap ??
    best.market_cap ??
    infoBlock.marketCap ??
    infoBlock.market_cap ??
    best.marketCapUsd ??
    null
  ) || null

  const name = base.name || base.symbol || infoBlock.name || infoBlock.symbol || (data.name || null)
  const symbol = base.symbol || infoBlock.symbol || null

  // image (optional)
  const imageUrl = infoBlock.imageUrl || base.logoURI || base.imageUrl || null

  return {
    name,
    symbol,
    priceUsd,
    priceNative,
    marketCap,
    imageUrl,
    rawPair: best
  }
}

// ---------- Bot ----------
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
    const { qr, connection } = update
    if (qr) qrcode.generate(qr, { small: true })
    if (connection === "open") console.log("✅ Bot connected")
    if (connection === "close") {
      console.log("❌ Disconnected. Restarting…")
      startBot().catch(console.error)
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

    // fetch group metadata (needed for admin checks)
    let meta = {}
    try { meta = await sock.groupMetadata(from) } catch (e) { meta = { participants: [] } }

    // ---------- Anti-link: delete message (then optionally remove user) ----------
    const groupAnti = !!db.antilink[from]
    if (groupAnti && detectLink(text)) {
      const isSenderAdmin = isAdminOf(meta, sender)
      if (!isSenderAdmin) {
        // notify then attempt to delete the message for everyone
        try {
          await sock.sendMessage(from, {
            text: `⚠️ Link detected. Removing message from @${sender.split("@")[0]}.`,
            mentions: [sender]
          })
        } catch (e) { /* ignore notify failure */ }

        // Try to delete the offending message for everyone
        try {
          // Baileys deletion for everyone: send { delete: msg.key }
          await sock.sendMessage(from, { delete: m.key })
          // optionally inform
          await sock.sendMessage(from, { text: `✅ Message deleted.` })
        } catch (err) {
          console.error("Delete message failed:", err?.message || err)
          // If delete fails, try to remove the user (if the bot is an admin)
          try {
            const botIsAdmin = isAdminOf(meta, sock.user?.id || sock.user?.jid || (sock.user && (sock.user.id || sock.user.jid)) )
            if (botIsAdmin) {
              await sock.groupParticipantsUpdate(from, [sender], "remove")
              await sock.sendMessage(from, { text: `🚫 @${sender.split("@")[0]} removed for posting links.`, mentions: [sender] })
            } else {
              await sock.sendMessage(from, { text: `⚠️ Could not delete message automatically. Please remove the message/sender manually.` })
            }
          } catch (err2) {
            console.error("Remove user failed:", err2?.message || err2)
            await sock.sendMessage(from, { text: `⚠️ Could not delete or remove user; please remove manually.` })
          }
        }
        // stop further processing of this message (don't treat as command)
        return
      }
    }

    // ---------- Custom Replies ----------
    const cr = db.customReplies[from] || {}
    const lowered = text.trim().toLowerCase()
    if (cr[lowered]) {
      await sock.sendMessage(from, { text: cr[lowered] })
      return
    }

    // ---------- Commands ----------
    const body = text.trim()
    if (!body.startsWith("!")) return

    const [cmd, ...rest] = body.split(" ")
    const args = rest.join(" ").trim()

    const needAdmin = async () => {
      if (!isAdminOf(meta, sender)) {
        await sock.sendMessage(from, { text: "⛔ Admins only." })
        return false
      }
      return true
    }

    try {
      switch (cmd.toLowerCase()) {
        case "!tagall": {
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
          if (!(await needAdmin())) break
          await sock.groupSettingUpdate(from, "announcement")
          await sock.sendMessage(from, { text: "🔒 Group locked (admins only can send messages)" })
          break
        }

        case "!unlock": {
          if (!(await needAdmin())) break
          await sock.groupSettingUpdate(from, "not_announcement")
          await sock.sendMessage(from, { text: "🔓 Group unlocked (everyone can chat)" })
          break
        }

        case "!antilink": {
          if (!(await needAdmin())) break
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
          const sub = args.split(" ")[0]?.toLowerCase()
          db.customReplies[from] = db.customReplies[from] || {}

          if (sub === "set") {
            const eq = args.slice(3).trim()
            const i = eq.indexOf("=")
            if (i === -1) {
              await sock.sendMessage(from, { text: "Usage: *!crp set trigger=reply*" })
              break
            }
            const trigger = eq.slice(0, i).trim().toLowerCase()
            const reply = eq.slice(i + 1).trim()
            if (!trigger || !reply) {
              await sock.sendMessage(from, { text: "Usage: *!crp set trigger=reply*" })
              break
            }
            db.customReplies[from][trigger] = reply
            saveDB(db)
            await sock.sendMessage(from, { text: `✅ Saved custom reply for *${trigger}*` })
          } else if (sub === "del") {
            const trigger = args.slice(3).trim().toLowerCase()
            if (!trigger) {
              await sock.sendMessage(from, { text: "Usage: *!crp del trigger*" })
              break
            }
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
          } else {
            await sock.sendMessage(from, {
              text: [
                "📌 *Custom Reply Commands*",
                "*!crp set trigger=reply*",
                "*!crp del trigger*",
                "*!crp list*"
              ].join("\n")
            })
          }
          break
        }

        case "!t": {
          const contract = args || ""
          if (!contract) {
            await sock.sendMessage(from, { text: "Usage: *!T <token_contract_or_address>*" })
            break
          }
          await sock.sendMessage(from, { text: "⏳ Fetching token data…" })
          try {
            const info = await fetchTokenInfo(contract)
            if (!info) {
              await sock.sendMessage(from, { text: "❔ Token not found on Dexscreener." })
              break
            }

            const captionLines = [
              `*${(info.name || "Unknown").toString()}* (${(info.symbol || "—").toString()})`,
              `Price (USD): $${formatNumber(info.priceUsd)}`,
              `Native price: ${formatNumber(info.priceNative)}`,
              `Market Cap: $${formatNumber(info.marketCap)}`
            ]
            const caption = captionLines.join("\n")

            if (info.imageUrl) {
              // send image with the caption
              try {
                const resp = await axios.get(info.imageUrl, { responseType: "arraybuffer", timeout: 15000 })
                await sock.sendMessage(from, {
                  image: Buffer.from(resp.data),
                  caption
                })
              } catch (imgErr) {
                // if image fetch fails, fallback to text
                console.error("Image fetch failed:", imgErr?.message || imgErr)
                await sock.sendMessage(from, { text: caption })
              }
            } else {
              await sock.sendMessage(from, { text: caption })
            }
          } catch (e) {
            console.error("Token fetch error:", e?.message || e)
            await sock.sendMessage(from, { text: "⚠️ Error fetching token. Check address and try again." })
          }
          break
        }

        case "!help": {
          await sock.sendMessage(from, {
            text:
`🤖 *Bot Menu*  
!tagall – Mention all
!lock – Lock group (admins)
!unlock – Unlock group (admins)
!antilink on|off – Delete links (admins)
!crp set a=b – Save custom reply
!crp del a – Remove custom reply
!crp list – View replies
!T <contract> – Token info (name, symbol, price, native price, market cap)`
          })
          break
        }

        default:
          // unknown
          break
      }
    } catch (err) {
      console.error("Command error:", err?.message || err)
      try { await sock.sendMessage(from, { text: "⚠️ Command failed. Check logs." }) } catch (e) {}
    }
  })
}

startBot().catch(console.error)


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});