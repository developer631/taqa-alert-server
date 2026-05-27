// ═══════════════════════════════════════════════════════════
// طاقة - Alert Server  v2.4
// OneSignal Push + Wawp v2 WhatsApp API + Firebase Realtime DB
// ═══════════════════════════════════════════════════════════

const express = require("express");
const fetch = require("node-fetch");
const admin = require("firebase-admin");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

let db = null;
try {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: "https://taqa-378d1-default-rtdb.firebaseio.com",
  });
  db = admin.database();
  console.log("✅ Firebase connected");
} catch (e) {
  console.error("❌ Firebase init failed:", e.message);
}

const OS_APP_ID = "bd870563-8761-403d-a593-6fd5f8afad6d";
const OS_API_KEY = "os_v2_app_xwdqky4hmfad3jmtn7k7rl5nnvtdupv7osherneztog4fz76chlb25pzmq5lrjriiiiey6dvvgj2bs4yuyqdrijeh6ob2o5web7hzna";

const WAWP_INSTANCE = process.env.WAWP_INSTANCE_ID || "0666F2942346";
const WAWP_TOKEN = process.env.WAWP_TOKEN || "1hSIrJn9px4Tgl";
const WA_TARGET = process.env.WA_TARGET || "";

async function sendOSNotif(title, body, office) {
  const filters = office
    ? [{ field: "tag", key: "office", relation: "=", value: office }]
    : null;
  const payload = {
    app_id: OS_APP_ID,
    headings: { ar: title, en: title },
    contents: { ar: body, en: body },
    priority: 10,
    ttl: 3600,
    ...(filters ? { filters } : { included_segments: ["All"] }),
  };
  try {
    await fetch("https://onesignal.com/api/v1/notifications", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Basic " + OS_API_KEY,
      },
      body: JSON.stringify(payload),
    });
    console.log(`📢 OS sent: ${title} → ${office || "All"}`);
  } catch (e) {
    console.error("❌ OS error:", e.message);
  }
}

async function sendWA(phone, message) {
  if (!phone) return { ok: false, error: "no phone" };

  const cleanPhone = String(phone)
    .replace(/[\s\-\+]/g, "")
    .replace(/^00/, "")
    .replace(/@c\.us$/, "");
  const chatId = cleanPhone + "@c.us";

  try {
    const res = await fetch("https://api.wawp.net/v2/send/text", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${WAWP_TOKEN}`,
      },
      body: JSON.stringify({
        instance_id: WAWP_INSTANCE,
        access_token: WAWP_TOKEN,
        chatId: chatId,
        message: message,
      }),
    });

    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text.substring(0, 300) };
    }

    console.log(`📤 WA → ${chatId}: ${res.status}`, JSON.stringify(data).substring(0, 300));
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    console.error("❌ WA error:", e.message);
    return { ok: false, error: e.message };
  }
}

async function tryAllMethods(phone, message) {
  const cleanPhone = String(phone).replace(/[\s\-\+]/g, "").replace(/^00/, "").replace(/@c\.us$/, "");
  const chatId = cleanPhone + "@c.us";
  const results = {};

  try {
    const r = await fetch("https://api.wawp.net/v2/send/text", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${WAWP_TOKEN}` },
      body: JSON.stringify({ instance_id: WAWP_INSTANCE, access_token: WAWP_TOKEN, chatId, message }),
    });
    results.A_v2_bearer_body = { status: r.status, body: (await r.text()).substring(0, 200) };
  } catch (e) { results.A_v2_bearer_body = { error: e.message }; }

  try {
    const r = await fetch("https://api.wawp.net/v2/send/text", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instance_id: WAWP_INSTANCE, access_token: WAWP_TOKEN, chatId, message }),
    });
    results.B_v2_body_only = { status: r.status, body: (await r.text()).substring(0, 200) };
  } catch (e) { results.B_v2_body_only = { error: e.message }; }

  try {
    const params = new URLSearchParams({ instance_id: WAWP_INSTANCE, access_token: WAWP_TOKEN });
    const r = await fetch(`https://api.wawp.net/v2/send/text?${params}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId, message }),
    });
    results.C_v2_query_only = { status: r.status, body: (await r.text()).substring(0, 200) };
  } catch (e) { results.C_v2_query_only = { error: e.message }; }

  try {
    const r = await fetch("https://app.wawp.net/api/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ number: cleanPhone, type: "text", message, instance_id: WAWP_INSTANCE, access_token: WAWP_TOKEN }),
    });
    results.D_legacy_app = { status: r.status, body: (await r.text()).substring(0, 200) };
  } catch (e) { results.D_legacy_app = { error: e.message }; }

  try {
    const params = new URLSearchParams({ instance_id: WAWP_INSTANCE, access_token: WAWP_TOKEN, chatId: cleanPhone, message });
    const r = await fetch(`https://wawp.net/wp-json/awp/v1/send?${params}`, { method: "POST" });
    results.E_wp_json = { status: r.status, body: (await r.text()).substring(0, 200) };
  } catch (e) { results.E_wp_json = { error: e.message }; }

  return results;
}

async function checkAlerts() {
  console.log("🔍 Checking outage alerts...", new Date().toISOString());
  if (!db) {
    console.log("⚠️ DB not connected, skip check");
    return;
  }
  try {
    const [reportsSnap, alertedSnap] = await Promise.all([
      db.ref("reports").once("value"),
      db.ref("alerted").once("value"),
    ]);

    const reports = reportsSnap.val();
    if (!reports) {
      console.log("No reports");
      return;
    }

    const alerted = alertedSnap.val() || {};
    const newAlerted = { ...alerted };
    const now = new Date();

    for (const rep of Object.values(reports)) {
      if (rep.allRestored) continue;
      const outageTime = rep.data?.outageTime;
      if (!outageTime) continue;

      const [h, m] = outageTime.split(":").map(Number);
      const outageDate = new Date(now);
      outageDate.setHours(h, m, 0, 0);
      if (outageDate > now) outageDate.setDate(outageDate.getDate() - 1);
      const mins = Math.floor((now - outageDate) / 60000);

      const id = rep.id || rep.data?.feeder || Math.random();
      const office = rep.data?.office || "";
      const feeder = rep.data?.feeder || "";
      const key80 = id + "_80";
      const key120 = id + "_120";

      if (mins >= 120 && !alerted[key120]) {
        const title = "🚨 تجاوز 120 دقيقة";
        const body = `${feeder}  ${office}\nالانقطاع: ${outageTime}`;
        await sendOSNotif(title, body, office);
        if (WA_TARGET) {
          const waMsg = "🚨 *تنبيه تأخر انقطاع*\n\n" +
            `📍 المكتب: ${office}\n` + `🔌 المغذي: ${feeder}\n` +
            `🕐 وقت الانقطاع: ${outageTime}\n` +
            `⏱️ المدة: ${Math.floor(mins / 60)} ساعة ${mins % 60} دقيقة\n\n` +
            "⚠️ البلاغ تجاوز ساعتين ولم يُكتمل بعد";
          await sendWA(WA_TARGET, waMsg);
        }
        newAlerted[key120] = Date.now();
      }
      else if (mins >= 80 && !alerted[key80]) {
        const title = "⚠️ تجاوز 80 دقيقة";
        const body = `${feeder}  ${office}\nالانقطاع: ${outageTime}`;
        await sendOSNotif(title, body, office);
        if (WA_TARGET) {
          const waMsg = "⚠️ *تنبيه تأخر انقطاع*\n\n" +
            `📍 المكتب: ${office}\n` + `🔌 المغذي: ${feeder}\n` +
            `🕐 وقت الانقطاع: ${outageTime}\n` +
            `⏱️ المدة: ${mins} دقيقة\n\n` +
            "⚠️ البلاغ تجاوز 80 دقيقة";
          await sendWA(WA_TARGET, waMsg);
        }
        newAlerted[key80] = Date.now();
      }
    }

    const cutoff = Date.now() - 6 * 3600000;
    Object.keys(newAlerted).forEach((k) => {
      if (newAlerted[k] < cutoff) delete newAlerted[k];
    });
    await db.ref("alerted").set(newAlerted);
  } catch (e) {
    console.error("Error in checkAlerts:", e.message);
  }
}

app.get("/", (req, res) => {
  res.json({
    status: "✅ طاقة Alert Server running",
    version: "2.4",
    time: new Date().toISOString(),
    endpoints: ["GET /", "GET /config", "GET /check", "GET /test-wa", "GET /diag-wa", "POST /send-wa"],
  });
});

app.get("/config", (req, res) => {
  res.json({
    WAWP_INSTANCE_ID: WAWP_INSTANCE ? "✅ set (" + WAWP_INSTANCE + ")" : "❌ missing",
    WAWP_TOKEN: WAWP_TOKEN ? "✅ set (hidden)" : "❌ missing",
    WA_TARGET: WA_TARGET || "❌ missing",
    FIREBASE: db ? "✅ connected" : "❌ not connected",
    ONESIGNAL: OS_APP_ID ? "✅ configured" : "❌ missing",
  });
});

app.get("/check", async (req, res) => {
  await checkAlerts();
  res.json({ status: "done", time: new Date().toISOString() });
});

app.get("/test-wa", async (req, res) => {
  if (!WA_TARGET) return res.status(400).json({ ok: false, error: "WA_TARGET not set" });
  const testMessage = "🧪 *اختبار طاقة*\n\n" +
    "✅ السيرفر متصل بـ Wawp\n" +
    "✅ Firebase: " + (db ? "متصل" : "غير متصل") + "\n" +
    "🕐 الوقت: " + new Date().toLocaleString("ar-SA", { timeZone: "Asia/Riyadh" }) +
    "\n\nإذا وصلتك هذي الرسالة، فإن الربط يعمل ✅";
  const result = await sendWA(WA_TARGET, testMessage);
  res.json({ ok: result.ok, target: WA_TARGET, result });
});

app.get("/diag-wa", async (req, res) => {
  if (!WA_TARGET) return res.status(400).json({ ok: false, error: "WA_TARGET not set" });
  const results = await tryAllMethods(WA_TARGET, "🧪 طاقة diag test");
  res.json({ target: WA_TARGET, instance: WAWP_INSTANCE, methods: results });
});

app.post("/send-wa", async (req, res) => {
  const { phone, message } = req.body || {};
  if (!phone || !message) return res.status(400).json({ ok: false, error: "phone and message required" });
  const result = await sendWA(phone, message);
  res.json(result);
});

app.use((req, res) => {
  res.status(404).json({
    ok: false,
    error: `route not found: ${req.method} ${req.path}`,
    available: ["/", "/config", "/check", "/test-wa", "/diag-wa", "/send-wa"],
  });
});

setInterval(checkAlerts, 5 * 60 * 1000);
setTimeout(checkAlerts, 5000);

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📱 Wawp Instance: ${WAWP_INSTANCE}`);
  console.log(`📞 WA_TARGET: ${WA_TARGET || "(not set)"}`);
});
