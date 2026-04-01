const express = require("express");
const fetch = require("node-fetch");
const admin = require("firebase-admin");

const app = express();
const PORT = process.env.PORT || 3000;

// ── Firebase Admin init ────────────────────────────────
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://taqa-378d1-default-rtdb.firebaseio.com",
});
const db = admin.database();

// ── OneSignal ──────────────────────────────────────────
const OS_APP_ID = "bd870563-8761-403d-a593-6fd5f8afad6d";
const OS_API_KEY = "os_v2_app_xwdqky4hmfad3jmtn7k7rl5nnvtdupv7osherneztog4fz76chlb25pzmq5lrjriiiiey6dvvgj2bs4yuyqdrijeh6ob2o5web7hzna";

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
  await fetch("https://onesignal.com/api/v1/notifications", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Basic " + OS_API_KEY,
    },
    body: JSON.stringify(payload),
  });
  console.log(`✅ Sent: ${title} → ${office || "All"}`);
}

// ── فحص الانقطاعات ────────────────────────────────────
async function checkAlerts() {
  console.log("🔍 Checking outage alerts...", new Date().toISOString());
  try {
    const [reportsSnap, alertedSnap] = await Promise.all([
      db.ref("reports").once("value"),
      db.ref("alerted").once("value"),
    ]);

    const reports = reportsSnap.val();
    if (!reports) { console.log("No reports"); return; }

    const alerted = alertedSnap.val() || {};
    const newAlerted = { ...alerted };
    const now = new Date();

    for (const rep of Object.values(reports)) {
      if (rep.allRestored) continue;
      const outageTime = rep.data?.outageTime;
      if (!outageTime) continue;

      // احسب الدقائق
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
        await sendOSNotif(
          "🚨 تجاوز 120 دقيقة",
          `${feeder}  ${office}\nالانقطاع: ${outageTime}`,
          office
        );
        newAlerted[key120] = Date.now();
      } else if (mins >= 80 && !alerted[key80]) {
        await sendOSNotif(
          "⚠️ تجاوز 80 دقيقة",
          `${feeder}  ${office}\nالانقطاع: ${outageTime}`,
          office
        );
        newAlerted[key80] = Date.now();
      }
    }

    // احذف القديمة +6 ساعات
    const cutoff = Date.now() - 6 * 3600000;
    Object.keys(newAlerted).forEach((k) => {
      if (newAlerted[k] < cutoff) delete newAlerted[k];
    });
    await db.ref("alerted").set(newAlerted);
  } catch (e) {
    console.error("Error:", e.message);
  }
}

// ── Routes ─────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "✅ طاقة Alert Server running", time: new Date() });
});

app.get("/check", async (req, res) => {
  await checkAlerts();
  res.json({ status: "done" });
});

// ── شغّل كل 5 دقائق ───────────────────────────────────
setInterval(checkAlerts, 5 * 60 * 1000);
setTimeout(checkAlerts, 5000); // أول فحص بعد 5 ثواني

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
