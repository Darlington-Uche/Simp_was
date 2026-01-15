// wabot.js - Simplified WhatsApp Project Tracking Bot
const P = require("pino")
const { default: makeWASocket, useMultiFileAuthState } = require("@whiskeysockets/baileys")
const qrcode = require("qrcode-terminal")
const express = require("express")

// Firebase Admin Setup
const admin = require('firebase-admin');
const serviceAccount = {
  projectId: process.env.FIREBASE_PROJECT_ID,
  privateKeyId: process.env.FIREBASE_PRIVATE_KEY_ID,
  privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
  clientId: process.env.FIREBASE_CLIENT_ID,
  authUri: process.env.FIREBASE_AUTH_URI,
  tokenUri: process.env.FIREBASE_TOKEN_URI,
  authProviderX509CertUrl: process.env.FIREBASE_AUTH_PROVIDER_X509_CERT_URL,
  clientX509CertUrl: process.env.FIREBASE_CLIENT_X509_CERT_URL,
  universeDomain: process.env.FIREBASE_UNIVERSE_DOMAIN
};

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

// Collections
const projectsRef = db.collection('projects');
const topProjectsRef = db.collection('top_projects');
const usersRef = db.collection('users');

// Server configuration
const BOT_PORT = process.env.PORT || 8000;

// ---------- Create HTTP server ----------
const app = express();
app.use(express.json());

app.get("/", (req, res) => {
    res.send("WhatsApp Project Tracking Bot is running 🚀")
});

app.get("/health", (req, res) => {
    res.json({ status: "ok", bot: "running" })
});

app.listen(BOT_PORT, () => {
    console.log(`🤖 Bot health server listening on port ${BOT_PORT}`)
});

// ---------- Helper Functions ----------
function extractXLink(text) {
    const regex = /(https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\/[^\s]+)/gi;
    const matches = text.match(regex);
    return matches ? matches[0] : null;
}

function formatPoints(points) {
    return points.toLocaleString('en-US');
}

async function getUser(userId) {
    try {
        const userDoc = await usersRef.doc(userId).get();
        if (userDoc.exists) {
            return userDoc.data();
        }
        return null;
    } catch (error) {
        console.error("Error fetching user data:", error);
        return null;
    }
}

async function saveUser(userId, data) {
    try {
        await usersRef.doc(userId).set(data, { merge: true });
        return true;
    } catch (error) {
        console.error("Error saving user:", error);
        return false;
    }
}

async function updateUserPoints(userId, pointsToAdd, reason = "New X profile posted") {
    try {
        let user = await getUser(userId);
        if (!user) {
            user = {
                userId: userId,
                totalPoints: 0,
                postedProfiles: []
            };
        }
        
        const currentPoints = user.totalPoints || 0;
        const newTotal = currentPoints + pointsToAdd;
        
        await saveUser(userId, {
            ...user,
            totalPoints: newTotal,
            lastUpdated: admin.firestore.FieldValue.serverTimestamp()
        });
        
        return newTotal;
    } catch (error) {
        console.error("Error updating user points:", error);
        return null;
    }
}

async function saveProject(projectData) {
    try {
        let id;
        do {
            id = Math.floor(10000 + Math.random() * 90000).toString(); // 5-digit ID
        } while ((await projectsRef.doc(id).get()).exists);
        
        await projectsRef.doc(id).set(projectData);
        return id;
    } catch (error) {
        console.error("Error saving project:", error);
        return null;
    }
}

async function deleteProject(projectId) {
    try {
        // Delete from projects
        await projectsRef.doc(projectId).delete();
        
        // Also delete from top projects if exists
        const topSnapshot = await topProjectsRef.where('projectId', '==', projectId).get();
        const batch = db.batch();
        topSnapshot.forEach(doc => {
            batch.delete(doc.ref);
        });
        await batch.commit();
        
        return true;
    } catch (error) {
        console.error("Error deleting project:", error);
        return false;
    }
}

async function getProjectById(projectId) {
    try {
        const doc = await projectsRef.doc(projectId).get();
        if (doc.exists) {
            return { id: doc.id, ...doc.data() };
        }
        return null;
    } catch (error) {
        console.error("Error getting project:", error);
        return null;
    }
}

async function getGroupProjects(groupId) {
    try {
        const snapshot = await projectsRef.where('groupId', '==', groupId).get();
        const projects = [];
        
        snapshot.forEach(doc => {
            const data = doc.data();
            projects.push({
                id: doc.id,
                ...data,
                timestampValue: data.timestamp ? data.timestamp.toDate().getTime() : 0
            });
        });
        
        // Sort by timestamp (newest first)
        projects.sort((a, b) => b.timestampValue - a.timestampValue);
        
        return projects;
    } catch (error) {
        console.error("Error getting group projects:", error);
        return [];
    }
}

async function getTopProjects(groupId) {
    try {
        const snapshot = await topProjectsRef.where('groupId', '==', groupId).get();
        const topProjects = [];
        
        snapshot.forEach(doc => {
            const data = doc.data();
            topProjects.push({
                id: doc.id,
                ...data
            });
        });
        
        // Sort by addedAt timestamp (newest first)
        topProjects.sort((a, b) => b.addedAt - a.addedAt);
        
        // Keep only top 10
        return topProjects.slice(0, 10);
    } catch (error) {
        console.error("Error getting top projects:", error);
        return [];
    }
}

async function addToTop(projectId, groupId) {
    try {
        const project = await getProjectById(projectId);
        if (!project) return false;
        
        // Check if already in top
        const topProjects = await getTopProjects(groupId);
        const alreadyInTop = topProjects.find(p => p.projectId === projectId);
        if (alreadyInTop) {
            return false;
        }
        
        // Add to top
        await topProjectsRef.add({
            projectId: projectId,
            link: project.link,
            userName: project.userName,
            userId: project.userId,
            projectName: project.projectName,
            groupId: groupId,
            addedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        
        // Award bonus points
        await updateUserPoints(project.userId, 500, "Project entered top 10 list");
        
        return true;
    } catch (error) {
        console.error("Error adding to top:", error);
        return false;
    }
}

async function removeFromTop(projectId, groupId) {
    try {
        const snapshot = await topProjectsRef
            .where('projectId', '==', projectId)
            .where('groupId', '==', groupId)
            .get();
        
        if (snapshot.empty) return false;
        
        const batch = db.batch();
        snapshot.forEach(doc => {
            batch.delete(doc.ref);
        });
        await batch.commit();
        
        return true;
    } catch (error) {
        console.error("Error removing from top:", error);
        return false;
    }
}

async function isGroupAdmin(sock, groupJid, userJid) {
    try {
        const metadata = await sock.groupMetadata(groupJid);
        const participant = metadata.participants.find(p => p.id === userJid);
        return participant && (participant.admin === 'admin' || participant.admin === 'superadmin');
    } catch (error) {
        console.error("Error checking admin status:", error);
        return false;
    }
}

function getRankBadge(rank) {
    if (rank === 1) return "👑 G.O.A.T";
    if (rank === 2) return "⭐ Superstar";
    if (rank === 3) return "🔥 Hotshot";
    if (rank <= 10) return "🏅 Elite";
    return "📊 Contributor";
}

// ---------- Command Handlers ----------
async function handleHiddenTag(sock, from, message, sender) {
  try {
    const text = message.replace(/^\/tag\s*/i, '').trim();
    if (!text) {
      return; // Silent fail for hidden tag
    }
    
    const metadata = await sock.groupMetadata(from);
    const participants = metadata.participants.map(p => p.id);
    
    let out = `${text}\n\n`;
    const mentions = [];
    for (let p of participants) {
      mentions.push(p);
      out += `@${p.split("@")[0]} `;
    }
    
    await sock.sendMessage(from, { text: out, mentions });
    
  } catch (error) {
    // Silent fail
  }
}

async function handleHiddenTagAll(sock, from) {
  try {
    const metadata = await sock.groupMetadata(from);
    const participants = metadata.participants.map(p => p.id);
    
    let out = "📢 *Tagging All Members:*\n\n";
    const mentions = [];
    for (let p of participants) {
      mentions.push(p);
      out += `@${p.split("@")[0]} `;
    }
    
    await sock.sendMessage(from, { text: out, mentions });
    
  } catch (error) {
    console.error("Error in hidden tagall:", error);
    // Silent fail
  }
}

async function handleListProjects(sock, from, sender) {
  try {
    const projects = await getGroupProjects(from);
    
    if (projects.length === 0) {
      await sock.sendMessage(from, { text: "📭 No X profiles found in this group yet." });
      return;
    }
    
    let responseText = "🔗 *ALL X PROFILES*\n\n";
    
    projects.forEach((project, index) => {
      const userName = project.userName || 'Unknown User';
      const link = project.link || 'No link';
      const projectId = project.id;
      
      // Extract X username from link
      const xUsername = link.match(/(?:twitter\.com|x\.com)\/([^\s/?]+)/)?.[1] || 'Unknown';
      
      responseText += `*${index + 1}. @${xUsername}*\n`;
      responseText += `   👤 Dropped by: ${userName}\n`;
      responseText += `   🆔 ${projectId}\n\n`;
    });
    
    responseText += `\n📊 Total: ${projects.length} profile(s)`;
    responseText += `\n\n*Admin commands:*`;
    responseText += `\n• /t {id} - Add to top 10`;
    responseText += `\n• /d {id} - Delete from lists`;
    
    await sock.sendMessage(from, { text: responseText });
    
  } catch (error) {
    console.error("Error in /pl:", error);
    await sock.sendMessage(from, { text: "❌ Error fetching X profiles." });
  }
}

async function handleTopList(sock, from) {
    try {
        const topProjects = await getTopProjects(from);
        
        if (topProjects.length === 0) {
            await sock.sendMessage(from, { text: "🏆 No projects in top list yet." });
            return;
        }
        
        let responseText = "🏆 *TOP 10 PROJECTS*\n\n";
        
        topProjects.forEach((project, index) => {
            responseText += `${index + 1}. *${project.projectName}*\n`;
            responseText += `   👤 ${project.userName}\n`;
            responseText += `   🔗 ${project.link}\n`;
            responseText += `   🆔 ${project.projectId}\n\n`;
        });
        
        responseText += `\n*Admin commands:*`;
        responseText += `\n• /tr {id} - Remove from top 10`;
        
        await sock.sendMessage(from, { text: responseText });
        
    } catch (error) {
        console.error("Error in /top:", error);
        await sock.sendMessage(from, { text: "❌ Error fetching top projects." });
    }
}

async function handleAddToTop(sock, from, message, sender) {
  try {
    const parts = message.split(' ');
    const projectId = parts[1];
    
    if (!projectId) {
      await sock.sendMessage(from, { text: "❌ Please provide project ID.\nExample: /t abc123" });
      return;
    }
    
    // Check if admin
    const isAdmin = await isGroupAdmin(sock, from, sender);
    if (!isAdmin) {
      await sock.sendMessage(from, { text: "❌ Admin only command." });
      return;
    }
    
    // Check if project exists
    const project = await getProjectById(projectId);
    if (!project) {
      await sock.sendMessage(from, { text: "❌ Project not found." });
      return;
    }
    
    // Check if already in top
    const topProjects = await getTopProjects(from);
    if (topProjects.length >= 10) {
      await sock.sendMessage(from, { text: "❌ Top 10 list is full! Use /tr {id} to remove first." });
      return;
    }
    
    const alreadyInTop = topProjects.find(p => p.projectId === projectId);
    if (alreadyInTop) {
      await sock.sendMessage(from, { text: "❌ Project already in top list." });
      return;
    }
    
    // Add to top
    const added = await addToTop(projectId, from);
    
    if (added) {
      await sock.sendMessage(from, { react: { text: '✅', key: m.key } });
    } else {
      await sock.sendMessage(from, { text: "❌ Failed to add to top list." });
    }
    
  } catch (error) {
    console.error("Error in /t:", error);
    await sock.sendMessage(from, { text: "❌ Error adding to top." });
  }
}

async function handleRemoveFromTop(sock, from, message, sender) {
    try {
        const parts = message.split(' ');
        const projectId = parts[1];
        
        if (!projectId) {
            await sock.sendMessage(from, { text: "❌ Please provide project ID.\nExample: /tr abc123" });
            return;
        }
        
        // Check if admin
        const isAdmin = await isGroupAdmin(sock, from, sender);
        if (!isAdmin) {
            await sock.sendMessage(from, { text: "❌ Admin only command." });
            return;
        }
        
        // Remove from top
        const removed = await removeFromTop(projectId, from);
        
        if (removed) {
            await sock.sendMessage(from, { 
                text: `✅ Removed from top 10\n🆔 ${projectId}` 
            });
        } else {
            await sock.sendMessage(from, { text: "❌ Project not found in top list." });
        }
        
    } catch (error) {
        console.error("Error in /tr:", error);
        await sock.sendMessage(from, { text: "❌ Error removing from top." });
    }
}

async function handleDeleteProject(sock, from, message, sender) {
    try {
        const parts = message.split(' ');
        const projectId = parts[1];
        
        if (!projectId) {
            await sock.sendMessage(from, { text: "❌ Please provide project ID.\nExample: /d abc123" });
            return;
        }
        
        // Check if admin
        const isAdmin = await isGroupAdmin(sock, from, sender);
        if (!isAdmin) {
            await sock.sendMessage(from, { text: "❌ Admin only command." });
            return;
        }
        
        // Get project info before deletion
        const project = await getProjectById(projectId);
        if (!project) {
            await sock.sendMessage(from, { text: "❌ Project not found." });
            return;
        }
        
        // Remove from top list first
        await removeFromTop(projectId, from);
        
        // Delete project
        const deleted = await deleteProject(projectId);
        
        if (deleted) {
            await sock.sendMessage(from, { 
                text: `✅ Deleted project\n*${project.projectName}*\n👤 ${project.userName}\n🆔 ${projectId}` 
            });
        } else {
            await sock.sendMessage(from, { text: "❌ Failed to delete project." });
        }
        
    } catch (error) {
        console.error("Error in /d:", error);
        await sock.sendMessage(from, { text: "❌ Error deleting project." });
    }
}

async function handleRank(sock, from) {
  try {
    // Get all projects from this group
    const projects = await getGroupProjects(from);
    const userPoints = {};
    
    // Calculate points for each user in this group
    projects.forEach(project => {
      const userId = project.userId;
      if (!userPoints[userId]) {
        userPoints[userId] = {
          userId: userId,
          userName: project.userName,
          totalPoints: 0
        };
      }
      userPoints[userId].totalPoints += 100; // 100 points per profile
    });
    
    // Get top projects for bonus points
    const topProjects = await getTopProjects(from);
    topProjects.forEach(project => {
      if (userPoints[project.userId]) {
        userPoints[project.userId].totalPoints += 500; // 500 bonus points
      }
    });
    
    const users = Object.values(userPoints);
    
    if (users.length === 0) {
      await sock.sendMessage(from, { text: "📊 No ranking data yet." });
      return;
    }
    
    // Sort by points
    users.sort((a, b) => b.totalPoints - a.totalPoints);
    
    let responseText = "🏆 *GROUP RANKING*\n\n";
    const topUsers = users.slice(0, 10);
    
    topUsers.forEach((user, index) => {
      const badge = getRankBadge(index + 1);
      responseText += `${badge}\n`;
      responseText += `👤 ${user.userName}\n`;
      responseText += `⭐ ${formatPoints(user.totalPoints)} points\n\n`;
    });
    
    responseText += `\n*Points System:*`;
    responseText += `\n• New X profile: 100 points`;
    responseText += `\n• Enter top 10: +500 points`;
    
    await sock.sendMessage(from, { text: responseText });
  } catch (error) {
    console.error("Error in /rank:", error);
    await sock.sendMessage(from, { text: "❌ Error fetching ranking." });
  }
}

// ---------- X Link Handler ----------
async function handleXLink(sock, from, message, sender, userName, m) {
    try {
        const xLink = extractXLink(message);
        if (!xLink) return false;
        
        // Ignore bot's own messages
        if (global.botId && sender.includes(global.botId)) {
            return false;
        }
        
        // Check if this link already exists globally
        const existing = await projectsRef.where('link', '==', xLink).get();
        if (!existing.empty) {
            // React with thumbs up for existing
            await sock.sendMessage(from, { react: { text: '👍', key: m.key } });
            return false;
        }
        
        // Extract project name from message
        const projectName = message.replace(xLink, '').trim() || `Project by ${userName}`;
        
        // Save project
        const projectId = await saveProject({
            link: xLink,
            userId: sender,
            userName: userName,
            groupId: from,
            projectName: projectName,
            botUsername: global.botName || "ProjectBot",
            timestamp: admin.firestore.FieldValue.serverTimestamp()
        });
        
        if (!projectId) {
            console.error("Failed to save project");
            return false;
        }
        
        // Update user's posted profiles
        const user = await getUser(sender);
        const postedProfiles = user?.postedProfiles || [];
        await saveUser(sender, {
            userName: userName,
            postedProfiles: [...postedProfiles, xLink],
            lastActive: admin.firestore.FieldValue.serverTimestamp()
        });
        
        // Award points for new profile
        await updateUserPoints(sender, 100, "New X profile posted");
        
        // React with checkmark
        await sock.sendMessage(from, { react: { text: '✅', key: m.key } });
        
        return true;
        
    } catch (error) {
        console.error("Error handling X link:", error);
        return false;
    }
}

// ---------- Main Message Handler ----------
async function handleMessage(sock, m) {
    const from = m.key.remoteJid;
    const sender = m.key.participant || m.key.remoteJid;
    let body = "";
    let userName = m.pushName || "User";

    // Extract message text
    if (m.message.conversation) {
        body = m.message.conversation;
    } else if (m.message.extendedTextMessage?.text) {
        body = m.message.extendedTextMessage.text;
    } else if (m.message.imageMessage?.caption) {
        body = m.message.imageMessage.caption;
    } else {
        return;
    }

    body = body.trim();
    
    console.log(`📨 Message from ${userName}: ${body.substring(0, 50)}`);

    try {
        // Handle hidden tag command
        if (body.toLowerCase().startsWith('/tag ')) {
            await handleHiddenTag(sock, from, body, sender);
            return;
        }

        // Handle hidden tagall command
        if (body.toLowerCase().startsWith('/tagall')) {
            await handleHiddenTagAll(sock, from, body, sender);
            return;
        }

        // Handle /pl command
        if (body.toLowerCase().startsWith('/pl')) {
            await handleListProjects(sock, from, sender);
            return;
        }

        // Handle /top command
        if (body.toLowerCase().startsWith('/top')) {
            await handleTopList(sock, from);
            return;
        }

        // Handle /t command - Add to top
        if (body.toLowerCase().startsWith('/t ')) {
            await handleAddToTop(sock, from, body, sender);
            return;
        }

        // Handle /tr command - Remove from top
        if (body.toLowerCase().startsWith('/tr ')) {
            await handleRemoveFromTop(sock, from, body, sender);
            return;
        }

        // Handle /d command - Delete project
        if (body.toLowerCase().startsWith('/d ')) {
            await handleDeleteProject(sock, from, body, sender);
            return;
        }

        // Handle /rank command
        if (body.toLowerCase().startsWith('/rank')) {
            await handleRank(sock, from);
            return;
        }

        // Handle /help command
        if (body.toLowerCase().startsWith('/help')) {
            const helpText = `🤖 *PROJECT BOT COMMANDS*\n\n` +
                `*For Everyone:*\n` +
                `• /tag {message} - Tag all (hidden)\n` +
                `• /tagall - Tag all (hidden)\n` +
                `• /pl - List all X profiles\n` +
                `• /top - Show top 10 projects\n` +
                `• /rank - Top 10 members\n` +
                `• /help - Show this help\n\n` +
                `*Admin Commands:*\n` +
                `• /t {id} - Add to top 10\n` +
                `• /tr {id} - Remove from top 10\n` +
                `• /d {id} - Delete project\n\n` +
                `*Auto Features:*\n` +
                `• X links auto-save\n` +
                `• New profile: 100 points\n` +
                `• Top 10 entry: +500 points`;

            await sock.sendMessage(from, { text: helpText });
            return;
        }

        // Check for X links
        await handleXLink(sock, from, body, sender, userName, m);

    } catch (error) {
        console.error("❌ Error processing message:", error);
    }
}

// ---------- Bot Setup ----------
async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState("session");

    const sock = makeWASocket({
        logger: P({ level: "silent" }),
        auth: state,
        printQRInTerminal: true
    });

    global.sock = sock;

    // Store bot info
    sock.ev.on("connection.update", (update) => {
        const { connection, user } = update;
        if (user && user.id) {
            global.botId = user.id.split(':')[0];
            global.botName = user.name || "ProjectBot";
            console.log(`🤖 Bot ID: ${global.botId}`);
            console.log(`🤖 Bot Name: ${global.botName}`);
        }
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            qrcode.generate(qr, { small: true });
        }

        if (connection === "close") {
            const reason = lastDisconnect?.error?.output?.statusCode;
            console.log("❌ Disconnected. Reason:", reason);

            if (reason !== 401) {
                setTimeout(() => startBot().catch(console.error), 5000);
            } else {
                console.log("🔒 Logged out. Delete session folder and scan again.");
            }
        }

        if (connection === "open") {
            console.log("✅ Bot connected!");
        }
    });

    // Message handler
    sock.ev.on("messages.upsert", async ({ messages }) => {
        const m = messages[0];
        if (!m || !m.message) return;

        const isGroup = m.key.remoteJid && m.key.remoteJid.endsWith("@g.us");
        if (!isGroup) return;

        await handleMessage(sock, m);
    });
}

// Start the bot
startBot().catch(console.error);

console.log("🤖 WhatsApp Project Bot starting...");
console.log("📋 Features:");
console.log("- /tag {message} - Hidden tag all");
console.log("- /tagall - Hidden tag all");
console.log("- /pl - List X profiles with ID, username, bot name");
console.log("- /t {id} - Add to top 10");
console.log("- /top - Show top 10");
console.log("- /tr {id} - Remove from top 10");
console.log("- /d {id} - Delete from all lists");
console.log("- /rank - Top 10 members with badges");
console.log("- Ignores bot's own messages");
console.log("- New X profile: 100 points");
console.log("- Top 10 entry: +500 points");
