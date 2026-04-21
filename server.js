const express = require("express");
const axios = require("axios");
const rateLimit = require("express-rate-limit");
require("dotenv").config();

const app = express();

// 🔐 Fix for proxy (ngrok)
app.set("trust proxy", 1);
app.use(express.json());

/* =========================
   🔐 RATE LIMIT
========================= */
const limiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 10,
  message: {
    error: "Too many requests, try again later"
  }
});

app.use("/make-call", limiter);
let ringingTimeout = null;

/* =========================
   📞 MAKE CALL API (FOR ZOHO)
========================= */
app.get("/make-call", async (req, res) => {
  try {
    const domain = process.env.domain;
    const user = process.env.user;
    const TOKEN = process.env.TOKEN;

    const phone = req.query.phone;

    if (!phone) {
      return res.status(400).json({ error: "Phone number required" });
    }

    const cleanPhone = phone.replace(/\D/g, "");

    const response = await axios.post(
      `https://core1.primecall.com/ns-api/v2/domains/${domain}/users/${user}/calls`,
      {
        synchronous: "no",
        "call-id": Date.now().toString(),
        originator: "105",
        destination: cleanPhone,
        bridge: true
      },
      {
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "Content-Type": "application/json"
        }
      }
    );

    // ✅ correct log
    console.log("📞 CALL RESPONSE:", response.data);

    return res.json({
      success: true,
      message: `📞 Calling ${cleanPhone}...`,
      data: response.data
    });

  } catch (error) {
    console.error("❌ CALL ERROR:", error.response?.data || error.message);

    return res.status(500).json({
      error: "Call failed",
      details: error.response?.data || error.message
    });
  }
});
app.get("/call-status", async (req, res) => {
  try {
    const domain = process.env.domain;
    const user = process.env.user;
    const TOKEN = process.env.TOKEN;

    const callId = req.query.callId;

    if (!callId) {
      return res.status(400).json({ error: "callId required" });
    }

    const response = await axios.get(
      `https://core1.primecall.com/ns-api/v2/domains/${domain}/calls/${callId}`,
      {
        headers: {
          Authorization: `Bearer ${TOKEN}`
        }
      }
    );

    console.log("📡 CALL STATUS API:", response.data);

    res.json({ success: true, data: response.data });

  } catch (error) {
    console.error("❌ STATUS ERROR:", error.response?.data || error.message);

    res.status(500).json({
      error: "Status fetch failed",
      details: error.response?.data || error.message
    });
  }
});

/* =========================
   📞 CALL UI PAGE (WITH MODAL)
========================= */
app.get("/call-ui", (req, res) => {
  const phone = req.query.phone || "";

  res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>Calling ${phone}</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: Arial; background: rgba(0,0,0,0.6); }
        .modal { display:flex; justify-content:center; align-items:center; height:100vh; }
        .modal-content { background:white; padding:28px 24px; border-radius:12px; text-align:center; width:300px; box-shadow:0 4px 20px rgba(0,0,0,0.3); }
        .phone-number { font-size:22px; font-weight:bold; color:#111; margin:4px 0 16px; }
        .status-badge { display:inline-flex; align-items:center; gap:8px; padding:8px 18px; border-radius:999px; font-size:14px; font-weight:600; margin-bottom:18px; }
        .dot { width:10px; height:10px; border-radius:50%; flex-shrink:0; }
        .status-dialing   { background:#FFF3CD; color:#856404; }
        .status-dialing .dot   { background:#F0A500; animation:pulse 1s infinite; }
        .status-ringing   { background:#D1ECF1; color:#0c5460; }
        .status-ringing .dot   { background:#17A2B8; animation:pulse 0.7s infinite; }
        .status-connected { background:#D4EDDA; color:#155724; }
        .status-connected .dot { background:#28A745; }
        .status-failed    { background:#F8D7DA; color:#721c24; }
        .status-failed .dot    { background:#DC3545; }
        .status-ended     { background:#e9ecef; color:#495057; }
        .status-ended .dot     { background:#6c757d; }
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }
        .timer { font-size:28px; font-weight:bold; color:#28A745; letter-spacing:2px; margin:4px 0 16px; font-family:monospace; display:none; }
        .countdown { font-size:13px; color:#888; margin-bottom:8px; display:none; }
        button { padding:10px; width:100%; margin-top:8px; border:none; cursor:pointer; font-weight:bold; border-radius:6px; font-size:15px; }
        .cancel { background:#DC3545; color:white; }
    </style>
</head>
<body>
<div class="modal">
  <div class="modal-content">
    <div style="font-size:13px;color:#777;margin-bottom:2px;">Calling</div>
    <div class="phone-number">${phone}</div>
    <div id="status-badge" class="status-badge status-dialing">
      <span class="dot"></span>
      <span id="status-text">Dialing...</span>
    </div>
    <div class="timer" id="timer">0:00</div>
    <div class="countdown" id="countdown"></div>
    <button class="cancel" onclick="cancelCall()">End Call</button>
  </div>
</div>

<script>
const PHONE = "${phone}";
let callId        = null;
let pollInterval  = null;
let timerInterval = null;
let ringingTimeout = null; // ✅ NEW
let seconds       = 0;
let currentStatus = "dialing";
let wasConnected  = false;
let closeTimer    = null;

const STATUS_MAP = {
  dialing:   { label:"Dialing...",  cls:"status-dialing"   },
  ringing:   { label:"Ringing...",  cls:"status-ringing"   },
  connected: { label:"Connected",   cls:"status-connected"  },
  failed:    { label:"Call Failed", cls:"status-failed"     },
  ended:     { label:"Call Ended",  cls:"status-ended"      },
};

function setStatus(key) {
  const isSame = currentStatus === key;
  currentStatus = key;

  const s = STATUS_MAP[key];
  const badge = document.getElementById("status-badge");
  badge.className = "status-badge " + s.cls;
  document.getElementById("status-text").textContent = s.label;

  // ✅ CLOSE POPUP WHEN RINGING
  if (key === "ringing") {
  console.log("🔔 Ringing → start countdown");

  stopPolling();   // optional (no more API calls)
  stopTimer();     // just safety

  autoClose(10);   // ✅ SHOW COUNTDOWN (10 sec)
  return;
}

  // (keep rest of your code SAME)
}

function startTimer() {
  document.getElementById("timer").style.display = "block";
  timerInterval = setInterval(() => {
    seconds++;
    const m = Math.floor(seconds / 60);
    const s = String(seconds % 60).padStart(2, "0");
    document.getElementById("timer").textContent = m + ":" + s;
  }, 1000);
}

function stopTimer() {
  clearInterval(timerInterval);
}

function stopPolling() {
  clearInterval(pollInterval);
  pollInterval = null;
}

function autoClose(secs) {
  const el = document.getElementById("countdown");
  el.style.display = "block";

  let remaining = secs;
  el.textContent = "Closing in " + remaining + "s...";

  closeTimer = setInterval(() => {
    remaining--;

    if (remaining <= 0) {
      clearInterval(closeTimer);
      el.textContent = "Closing...";
      closePopup();
    } else {
      el.textContent = "Closing in " + remaining + "s...";
    }
  }, 1000);
}

function closePopup() {
  // ✅ Try Zoho close
  if (window.ZOHO && ZOHO.CRM && ZOHO.CRM.UI) {
    try {
      ZOHO.CRM.UI.Popup.close();
      return;
    } catch(e) {
      console.log("Zoho close failed:", e);
    }
  }

  // ✅ fallback (no history back)
  window.open('', '_self');
  window.close();
}

async function makeCall() {
  try {
    const res  = await fetch("/make-call?phone=" + encodeURIComponent(PHONE));
    const data = await res.json();

    if (!data.success) {
      setStatus("failed");
      return;
    }

    callId =
      data.data?.id ||
      data.data?.uuid ||
      data.data?.callId ||
      data.data?.["call-id"] ||
      null;

    console.log("📞 CALL RESPONSE:", data);
    console.log("🆔 CALL ID:", callId);

    setStatus("ringing");

    pollInterval = setInterval(() => {
      pollStatus();
    }, 2000);

  } catch (err) {
    console.error("❌ CALL ERROR:", err);
    setStatus("failed");
  }
}

async function pollStatus() {
  if (!callId) return;

  try {
    const res  = await fetch("/call-status?callId=" + callId);
    const data = await res.json();

    const raw = (
      data.data?.state ||
      data.data?.status ||
      data.state ||
      data.status ||
      ""
    ).toLowerCase();

    console.log("👉 parsed status:", raw);

    const mapped =
      raw.includes("ring") ? "ringing" :

      raw === "up" ||
      raw === "active" ||
      raw === "answered" ||
      raw.includes("connect") ||
      raw.includes("bridge") ||
      raw.includes("established")
        ? "connected" :

      raw.includes("hangup") ||
      raw.includes("end") ||
      raw.includes("complete") ||
      raw.includes("destroy")
        ? "ended" :

      raw.includes("fail") ||
      raw.includes("busy") ||
      raw.includes("no-answer")
        ? "failed"
        : null;

    if (mapped) setStatus(mapped);

  } catch (err) {
    console.error("❌ POLL ERROR:", err);
  }
}

function cancelCall() {
  clearTimeout(ringingTimeout);
  clearInterval(closeTimer);

  stopPolling();
  stopTimer();

  closePopup();
}

window.onload = makeCall;
</script>
</body>
</html>
    `);
});

/* =========================
   SERVER
========================= */
app.listen(3000, () => {
  console.log("🚀 Server running on port 3000");
});

