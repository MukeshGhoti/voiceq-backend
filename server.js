// ============================================================
// VoiceQ — BACKEND SERVER
// Works on Railway, Hostinger Business, or Local
// ============================================================
// HOW THIS WORKS:
// - Manages all active sessions
// - Handles real-time question delivery (WebSockets)
// - Manages WebRTC signaling for live voice
// - All hosting-specific settings come from .env file
// ============================================================

const express    = require("express");
const http       = require("http");
const { Server } = require("socket.io");
const cors       = require("cors");
require("dotenv").config();

// ─────────────────────────────────────────────
// SERVER SETUP
// ─────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);

// Allow frontend to connect from any domain
// When on Hostinger, this will auto-restrict to your domain
const io = new Server(server, {
  cors: {
    origin: process.env.FRONTEND_URL || "*",
    methods: ["GET", "POST"]
  }
});

app.use(cors({ origin: process.env.FRONTEND_URL || "*" }));
app.use(express.json());

// ─────────────────────────────────────────────
// IN-MEMORY SESSION STORE
// Stores all active event sessions
// ─────────────────────────────────────────────
const sessions = new Map();

// Helper: get or create a session
function getSession(sessionId) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      id:          sessionId,
      questions:   [],
      talkQueue:   [],
      activeSpeaker: null,
      createdAt:   Date.now(),
    });
  }
  return sessions.get(sessionId);
}

// ─────────────────────────────────────────────
// REST API ENDPOINTS
// ─────────────────────────────────────────────

// Health check — Railway and Hostinger use this to verify app is running
app.get("/health", (req, res) => {
  res.json({
    status:   "ok",
    version:  "1.0.0",
    provider: process.env.HOSTING_PROVIDER || "unknown",
    sessions: sessions.size,
  });
});

// Create a new event session
app.post("/session/create", (req, res) => {
  const sessionId = Math.random().toString(36).substring(2, 8).toUpperCase();
  getSession(sessionId);
  res.json({ sessionId, joinUrl: `/join/${sessionId}` });
});

// Get session details
app.get("/session/:id", (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: "Session not found" });
  res.json(session);
});

// ─────────────────────────────────────────────
// WEBSOCKET EVENTS
// Real-time communication between all 3 views
// ─────────────────────────────────────────────
io.on("connection", (socket) => {
  console.log(`✅ Client connected: ${socket.id}`);

  // ── JOIN SESSION ──
  // Called when Audience, Moderator or Host opens the app
  socket.on("join-session", ({ sessionId, role }) => {
    socket.join(sessionId);
    socket.sessionId = sessionId;
    socket.role      = role;
    console.log(`👤 ${role} joined session ${sessionId}`);

    // Send current session state to the newly joined user
    const session = getSession(sessionId);
    socket.emit("session-state", session);
  });

  // ── SUBMIT QUESTION (Audience) ──
  socket.on("submit-question", (data) => {
    const session = getSession(data.sessionId);
    const question = {
      id:        Date.now(),
      type:      data.type,       // "text" or "voice"
      text:      data.text,
      audioData: data.audioData || null,
      lang:      data.lang,
      author:    data.author || "Anonymous",
      status:    "pending",
      upvotes:   0,
      time:      new Date().toLocaleTimeString(),
    };
    session.questions.push(question);

    // Send to MODERATOR only
    io.to(data.sessionId).emit("question-received", question);
    console.log(`❓ Question received in session ${data.sessionId}`);
  });

  // ── APPROVE QUESTION (Moderator) ──
  socket.on("approve-question", ({ sessionId, questionId }) => {
    const session  = getSession(sessionId);
    const question = session.questions.find(q => q.id === questionId);
    if (question) {
      question.status = "approved";
      // Send approved question to HOST
      io.to(sessionId).emit("question-approved", question);
      console.log(`✅ Question approved: ${questionId}`);
    }
  });

  // ── REJECT QUESTION (Moderator) ──
  socket.on("reject-question", ({ sessionId, questionId }) => {
    const session  = getSession(sessionId);
    const question = session.questions.find(q => q.id === questionId);
    if (question) {
      question.status = "rejected";
      io.to(sessionId).emit("question-rejected", { questionId });
    }
  });

  // ── PLAY QUESTION TO HALL (Host) ──
  socket.on("play-question", ({ sessionId, questionId }) => {
    const session  = getSession(sessionId);
    const question = session.questions.find(q => q.id === questionId);
    if (question) {
      question.status = "played";
      io.to(sessionId).emit("question-played", { questionId });
    }
  });

  // ── UPVOTE QUESTION (Audience) ──
  socket.on("upvote-question", ({ sessionId, questionId }) => {
    const session  = getSession(sessionId);
    const question = session.questions.find(q => q.id === questionId);
    if (question) {
      question.upvotes++;
      io.to(sessionId).emit("question-upvoted", { questionId, upvotes: question.upvotes });
    }
  });

  // ── REQUEST TALK LIVE (Audience) ──
  socket.on("request-talk-live", ({ sessionId, name }) => {
    const session = getSession(sessionId);
    const request = {
      id:       socket.id,
      socketId: socket.id,
      name:     name || "Audience Member",
      status:   "pending",
    };
    session.talkQueue.push(request);

    // Notify MODERATOR and HOST
    io.to(sessionId).emit("talk-live-request", request);
    console.log(`🎙️ Talk live request from ${name}`);
  });

  // ── APPROVE TALK LIVE (Moderator/Host) ──
  socket.on("approve-talk-live", ({ sessionId, requestId }) => {
    const session = getSession(sessionId);
    const request = session.talkQueue.find(r => r.id === requestId);
    if (request) {
      request.status         = "approved";
      session.activeSpeaker  = request;

      // Tell the specific audience member they can speak
      io.to(requestId).emit("talk-live-approved");

      // Tell everyone a live speaker is active
      io.to(sessionId).emit("speaker-active", request);
      console.log(`🎙️ Talk live approved for ${request.name}`);
    }
  });

  // ── REJECT TALK LIVE (Moderator/Host) ──
  socket.on("reject-talk-live", ({ sessionId, requestId }) => {
    const session = getSession(sessionId);
    session.talkQueue = session.talkQueue.filter(r => r.id !== requestId);

    // Tell the specific audience member they were rejected
    io.to(requestId).emit("talk-live-rejected");
    io.to(sessionId).emit("talk-live-request-removed", { requestId });
  });

  // ── END TALK LIVE (Host/Moderator) ──
  socket.on("end-talk-live", ({ sessionId }) => {
    const session          = getSession(sessionId);
    session.activeSpeaker  = null;
    session.talkQueue      = [];
    io.to(sessionId).emit("speaker-ended");
  });

  // ── WEBRTC SIGNALING FOR LIVE VOICE ──
  // These events pass WebRTC connection data between peers
  // without us ever seeing the actual voice content

  socket.on("webrtc-offer", ({ sessionId, offer, targetId }) => {
    io.to(targetId).emit("webrtc-offer", { offer, from: socket.id });
  });

  socket.on("webrtc-answer", ({ sessionId, answer, targetId }) => {
    io.to(targetId).emit("webrtc-answer", { answer, from: socket.id });
  });

  socket.on("webrtc-ice-candidate", ({ sessionId, candidate, targetId }) => {
    io.to(targetId).emit("webrtc-ice-candidate", { candidate, from: socket.id });
  });

  // ── DISCONNECT ──
  socket.on("disconnect", () => {
    console.log(`❌ Client disconnected: ${socket.id}`);

    // If the disconnected user was the active speaker, end the live session
    if (socket.sessionId) {
      const session = getSession(socket.sessionId);
      if (session.activeSpeaker?.socketId === socket.id) {
        session.activeSpeaker = null;
        io.to(socket.sessionId).emit("speaker-ended");
      }
    }
  });
});

// ─────────────────────────────────────────────
// START SERVER
// Port comes from environment (Railway/Hostinger set this automatically)
// ─────────────────────────────────────────────
const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`🚀 VoiceQ Backend running on port ${PORT}`);
  console.log(`🏠 Hosting provider: ${process.env.HOSTING_PROVIDER || "local"}`);
  console.log(`🌐 Frontend URL: ${process.env.FRONTEND_URL || "*"}`);
});
