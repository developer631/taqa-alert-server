// ═══════════════════════════════════════════════════════════
// طاقة - Alert Server  v3.6
// + ربط المرسلين (QR) + عتبات لكل مستلم + مستلمين متعددين
// + المفتاح الذكي + القاطع + تطبيع أسماء المكاتب
// ═══════════════════════════════════════════════════════════

const express = require("express");
const fetch = require("node-fetch");
const admin = require("firebase-admin");

const app = express();
app.use(express.json());

// v3.6: السماح بطلبات المتصفح من أي نطاق (CORS)
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

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

const ALERT_THRESHOLDS = [80, 120];
const RIYADH_OFFSET_MS = 3 * 3600 * 1000;

// v3.4: تنسيق مدة بالدقائق إلى نص عربي
function formatDuration(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h > 0 && m > 0) return `${h} ساعة ${m} دقيقة`;
  if (h > 0) return `${h} ساعة`;
  return `${m} دقيقة`;
}

// v3.5: تطبيع اسم المكتب (يشيل "ال" التعريف والمسافات) للمطابقة المرنة
function normalizeOffice(office) {
  if (!office) return "";
  let s = String(office).trim();
  // شيل "ال" من البداية
  if (s.startsWith("ال")) s = s.substring(2);
  return s;
}

// خريطة حالات المفتاح الذكي (موحدة)
const SK_STATUS_MAP = {
  ok: "✅ يعمل",
  not_responding: "🔴 لا يستجيب",
  offline: "🟠 أوف لاين",
  not_in_zenon: "🟡 غير مضاف بنظام الزنون",
  failed_other: "⚠️ فشل لسبب آخر",
};

// خريطة قديمة (للتوافق)
const SK_RESULT_MAP = SK_STATUS_MAP;

// v3.2: خريطة نتائج القاطع
const BREAKER_RESULT_MAP = {
  scada_no_response: "🔴 لا يستجيب",
  local: "✅ لوكل",
};

async function sendOSNotif(title, body, office) {
  const filters = office ? [{ field: "tag", key: "office", relation: "=", value: office }] : null;
  const payload = {
    app_id: OS_APP_ID,
    headings: { ar: title, en: title },
    contents: { ar: body, en: body },
    priority: 10, ttl: 3600,
    ...(filters ? { filters } : { included_segments: ["All"] }),
  };
  try {
    await fetch("https://onesignal.com/api/v1/notifications", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Basic " + OS_API_KEY },
      body: JSON.stringify(payload),
    });
    console.log(`📢 OS sent: ${title} → ${office || "All"}`);
  } catch (e) { console.error("❌ OS error:", e.message); }
}

async function sendWA(phone, message, customInstance) {
  if (!phone) return { ok: false, error: "no phone" };
  const cleanPhone = String(phone).replace(/[\s\-\+]/g, "").replace(/^00/, "").replace(/@c\.us$/, "");
  const chatId = cleanPhone + "@c.us";
  // v3.6: استخدم instance مخصص لو متوفر، وإلا الرئيسي
  const instanceId = (customInstance && customInstance.instanceId) || WAWP_INSTANCE;
  const token = (customInstance && customInstance.token) || WAWP_TOKEN;
  try {
    const res = await fetch("https://api.wawp.net/v2/send/text", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
      },
      body: JSON.stringify({
        instance_id: instanceId,
        access_token: token,
        chatId: chatId,
        message: message,
      }),
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text.substring(0, 300) }; }
    console.log(`📤 WA → ${chatId}: ${res.status} [instance: ${instanceId}]`);
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    console.error("❌ WA error:", e.message);
    return { ok: false, error: e.message };
  }
}

function calcOutageMinutes(outageTime, createdAt) {
  if (!outageTime) return 0;
  const nowRiyadh = new Date(Date.now() + RIYADH_OFFSET_MS);
  const parts = String(outageTime).split(":").map(Number);
  const h = parts[0];
  const m = parts[1] || 0;
  if (isNaN(h) || isNaN(m)) return 0;

  let baseDate = nowRiyadh;
  if (createdAt) {
    if (typeof createdAt === "number") {
      baseDate = new Date(createdAt + RIYADH_OFFSET_MS);
    } else if (typeof createdAt === "string") {
      const ddmmyyyy = createdAt.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
      if (ddmmyyyy) {
        const [, dd, mm, yyyy] = ddmmyyyy;
        baseDate = new Date(Date.UTC(+yyyy, +mm - 1, +dd) + RIYADH_OFFSET_MS);
      } else {
        const parsed = new Date(createdAt);
        if (!isNaN(parsed.getTime())) {
          baseDate = new Date(parsed.getTime() + RIYADH_OFFSET_MS);
        }
      }
    }
  }

  const outageDate = new Date(baseDate);
  outageDate.setUTCHours(h, m, 0, 0);
  const diffMs = nowRiyadh.getTime() - outageDate.getTime();
  if (diffMs < -60 * 60 * 1000) {
    outageDate.setUTCDate(outageDate.getUTCDate() - 1);
  }
  const finalDiff = nowRiyadh.getTime() - outageDate.getTime();
  return Math.max(0, Math.floor(finalDiff / 60000));
}

// v3.0: أحدث محاولة مفتاح ذكي في المراحل
function getLatestSmartKeyAttempt(stages) {
  if (!Array.isArray(stages)) return null;
  for (let i = stages.length - 1; i >= 0; i--) {
    if (stages[i].by === "مفتاح ذكي" && stages[i].smartKeyResult) {
      return {
        keyId: stages[i].smartKeyId || null,
        result: stages[i].smartKeyResult,
      };
    }
  }
  return null;
}

// v3.2: حالة القاطع من حقل البلاغ مباشرة (مو المراحل)
function getBreakerStatus(raw, data) {
  return data.breakerStatus || raw.breakerStatus || null;
}

// v3.1: استخراج قائمة المفاتيح الذكية (مع دعم الصيغة القديمة)
function getSmartKeysList(raw, data) {
  const sk = data.smartKeys || raw.smartKeys;
  if (Array.isArray(sk)) return sk;
  // دعم الصيغة القديمة
  const oldKey = data.smartKey || raw.smartKey;
  const oldStatus = data.smartKeyStatus || raw.smartKeyStatus;
  if (oldKey) return [{ id: oldKey, status: oldStatus || "ok" }];
  return [];
}

function extractReport(id, raw, source) {
  const data = raw.data || raw;
  let buses = [];
  const busNumbersField = data.busNumbers || raw.busNumbers;
  if (Array.isArray(busNumbersField)) buses = busNumbersField;
  else if (busNumbersField) buses = [String(busNumbersField)];
  const busNumber = data.busNumber || raw.busNumber;
  if (busNumber && !buses.includes(String(busNumber))) buses.push(String(busNumber));

  const stages = data.stages || raw.stages || [];

  return {
    id: id, source: source,
    outageType: data.outageType || raw.outageType,
    outageTime: data.outageTime || raw.outageTime,
    office: data.office || raw.office,
    stationName: data.stationName || raw.stationName,
    stationId: data.stationId || raw.stationId,
    feederName: data.feederName || raw.feederName,
    feederId: data.feederId || raw.feederId,
    // v3.1: قائمة المفاتيح الذكية
    smartKeys: getSmartKeysList(raw, data),
    latestSmartKeyAttempt: getLatestSmartKeyAttempt(stages),
    // v3.2: حالة القاطع (من حقل البلاغ)
    breakerStatus: getBreakerStatus(raw, data),
    busNumber: busNumber,
    busNumbers: buses,
    affectedAreas: data.affectedAreas || raw.affectedAreas || data.areas || raw.areas,
    totalAffected: data.totalAffected || raw.totalAffected,
    remainingCount: data.remainingCount !== undefined ? data.remainingCount : raw.remainingCount,
    sensitive: data.sensitive || raw.sensitive || 0,
    reason: data.reason || raw.reason,
    allRestored: raw.allRestored === true || data.allRestored === true,
    status: raw.status || data.status,
    createdAt: raw.createdAt || data.createdAt,
    stages: stages,
    // v3.6: instance المرسِل (لإرسال التنبيهات من رقمه)
    senderWawp: data.senderWawp || raw.senderWawp || null,
  };
}

function formatOutageDetails(r) {
  const lines = [];
  const type = r.outageType;
  if (r.stationName) lines.push(`🏢 المحطة: ${r.stationName}`);

  if (type === "feeder" && r.feederName) {
    lines.push(`🔌 المغذي: ${r.feederName}`);
    if (r.busNumber) lines.push(`⚡ الباص: B${r.busNumber}`);
  } else if (type === "bus") {
    if (r.busNumbers && r.busNumbers.length > 0) {
      const list = r.busNumbers.includes("all")
        ? "كل الباصات"
        : r.busNumbers.map((b) => `B${b}`).join("، ");
      lines.push(`⚡ الباص/الباصات المتأثرة: ${list}`);
    } else if (r.busNumber) {
      lines.push(`⚡ الباص: B${r.busNumber}`);
    } else {
      lines.push(`⚡ نوع البلاغ: انقطاع باص`);
    }
  } else if (type === "station") {
    lines.push(`⚠️ انقطاع محطة كامل`);
  } else {
    if (r.feederName) lines.push(`🔌 المغذي: ${r.feederName}`);
    if (r.busNumber) lines.push(`⚡ الباص: B${r.busNumber}`);
  }

  // v3.1: المفاتيح الذكية (للمغذي)
  if (type === "feeder" && r.smartKeys && r.smartKeys.length > 0) {
    if (r.smartKeys.length === 1) {
      const k = r.smartKeys[0];
      const statusText = SK_STATUS_MAP[k.status] || "";
      lines.push(`🔑 المفتاح الذكي: SK#${k.id}${statusText ? " — " + statusText : ""}`);
    } else {
      lines.push(`🔑 المفاتيح الذكية (${r.smartKeys.length}):`);
      r.smartKeys.forEach(k => {
        const statusText = SK_STATUS_MAP[k.status] || "";
        lines.push(`   • SK#${k.id}${statusText ? " — " + statusText : ""}`);
      });
    }
    // أحدث محاولة في المراحل
    if (r.latestSmartKeyAttempt) {
      const att = r.latestSmartKeyAttempt;
      const resultLabel = SK_STATUS_MAP[att.result] || att.result;
      const keyLabel = att.keyId ? `SK#${att.keyId}` : "";
      lines.push(`📌 آخر محاولة: ${keyLabel ? keyLabel + " — " : ""}${resultLabel}`);
    }
  }

  // v3.2: القاطع SCADA (من حقل البلاغ، متاح لكل الأنواع)
  if (r.breakerStatus) {
    const resultLabel = BREAKER_RESULT_MAP[r.breakerStatus] || r.breakerStatus;
    lines.push(`🔧 القاطع (SCADA): ${resultLabel}`);
  }

  return lines.join("\n");
}

async function checkAlerts() {
  console.log("🔍 Checking outage alerts...", new Date().toISOString());
  if (!db) return { ok: false, error: "no db" };
  try {
    const [oldReportsSnap, newReportsSnap, alertedSnap, recipientsSnap] = await Promise.all([
      db.ref("reports").once("value"),
      db.ref("reports2/outages").once("value"),
      db.ref("alerted").once("value"),
      db.ref("reports2/alertRecipients").once("value"),
    ]);
    const oldReports = oldReportsSnap.val() || {};
    const newReports = newReportsSnap.val() || {};
    const alerted = alertedSnap.val() || {};
    const newAlerted = { ...alerted };

    // v3.3: قائمة المستلمين (مجمّعة حسب المكتب، دعم مكاتب متعددة)
    const recipientsData = recipientsSnap.val() || {};
    // v3.4: المستلمين مع عتباتهم الخاصة، مجمّعين حسب المكتب
    const recipientsByOffice = {};
    Object.entries(recipientsData).forEach(([recipId, r]) => {
      if (!r.phone) return;
      let offices = [];
      if (Array.isArray(r.offices)) offices = r.offices;
      else if (r.office) offices = [r.office];
      // عتبات المستلم (بالدقائق)، احتياطي 80+120 للصيغة القديمة
      let thresholds = Array.isArray(r.thresholds) && r.thresholds.length > 0
        ? r.thresholds
        : [80, 120];
      offices.forEach(office => {
        if (!office) return;
        const key = normalizeOffice(office);  // v3.5: مطابقة مرنة
        if (!recipientsByOffice[key]) recipientsByOffice[key] = [];
        recipientsByOffice[key].push({
          id: recipId,
          name: r.name || "",
          phone: r.phone,
          thresholds: thresholds,
        });
      });
    });

    const allReports = [];
    for (const [id, raw] of Object.entries(oldReports)) allReports.push(extractReport(id, raw, "reports"));
    for (const [id, raw] of Object.entries(newReports)) allReports.push(extractReport(id, raw, "reports2/outages"));

    let checked = 0, alertsSent = 0, activeFound = 0;
    for (const r of allReports) {
      checked++;
      if (r.allRestored || r.status === "closed") continue;
      if (!r.outageTime) continue;
      activeFound++;
      const mins = calcOutageMinutes(r.outageTime, r.createdAt);

      const hours = Math.floor(mins / 60);
      const remainingMins = mins % 60;
      const durationText = hours > 0 ? `${hours} ساعة ${remainingMins} دقيقة` : `${mins} دقيقة`;
      const outageDetails = formatOutageDetails(r);

      // تحذير المفاتيح الذكية
      let smartKeyWarning = "";
      if (r.outageType === "feeder") {
        const problemStatuses = ["not_responding", "offline", "failed_other"];
        const problemKeys = (r.smartKeys || []).filter(k => problemStatuses.includes(k.status));
        const lastAttemptFailed = r.latestSmartKeyAttempt &&
          problemStatuses.includes(r.latestSmartKeyAttempt.result);
        if (lastAttemptFailed) {
          smartKeyWarning = `\n🔧 *تنبيه: آخر محاولة مفتاح ذكي فشلت — يستلزم تدخل ميداني*\n`;
        } else if (problemKeys.length > 0) {
          smartKeyWarning = `\n🔧 *تنبيه: ${problemKeys.length} مفتاح ذكي معطّل*\n`;
        }
      }

      // تحذير القاطع
      let breakerWarning = "";
      if (r.breakerStatus === "scada_no_response") {
        breakerWarning = `\n🔧 *تنبيه: القاطع لا يستجيب — يستلزم فني محطات*\n`;
      }

      // دالة بناء نص الرسالة لعتبة معينة
      const buildMsg = (threshold) => {
        const emoji = threshold >= 120 ? "🚨" : "⚠️";
        return `${emoji} *تنبيه تأخر انقطاع*\n\n` +
          `📍 المكتب: ${r.office || "—"}\n` +
          `${outageDetails}\n` +
          `🗺 المناطق: ${r.affectedAreas || "—"}\n` +
          `🕐 وقت الانقطاع: ${r.outageTime}\n` +
          `⏱️ المدة: ${durationText}\n` +
          `👥 المتأثرين: ${r.totalAffected || "-"} | المتبقي: ${r.remainingCount !== undefined ? r.remainingCount : "—"}\n` +
          (r.sensitive ? `🔴 مشتركون حساسون: ${r.sensitive}\n` : "") +
          (r.reason ? `📋 السبب: ${r.reason}\n` : "") +
          smartKeyWarning +
          breakerWarning +
          `\n⚠️ البلاغ تجاوز ${formatDuration(threshold)} ولم يُكتمل بعد`;
      };

      // v3.6: instance المرسِل (صاحب البلاغ) - أو الرئيسي احتياطياً
      const senderInstance = (r.senderWawp && r.senderWawp.instanceId) ? r.senderWawp : null;

      // ─── WA_TARGET: الرقم الرئيسي (عتبات افتراضية 80/120) ───
      if (WA_TARGET) {
        for (const t of [...ALERT_THRESHOLDS].sort((a, b) => a - b)) {
          const key = `${r.id}_MAIN_${t}`;
          if (mins >= t && !alerted[key]) {
            await sendWA(WA_TARGET, buildMsg(t), senderInstance);
            const emoji = t >= 120 ? "🚨" : "⚠️";
            await sendOSNotif(`${emoji} تجاوز ${formatDuration(t)}`,
              `${r.office || "-"}\nالانقطاع: ${r.outageTime} (${durationText})`, r.office);
            newAlerted[key] = Date.now();
            alertsSent++;
            console.log(`📤 MAIN alert: id=${r.id} t=${t}min sender=${senderInstance ? senderInstance.phone : "main"}`);
          }
        }
      }

      // ─── مستلمو المكتب: كل واحد حسب عتباته ───
      const officeRecipients = recipientsByOffice[normalizeOffice(r.office)] || [];
      const cleanTarget = String(WA_TARGET).replace(/[\s\-\+]/g, "").replace(/^00/, "");
      for (const recip of officeRecipients) {
        const cleanRecip = String(recip.phone).replace(/[\s\-\+]/g, "").replace(/^00/, "");
        // فحص كل عتبة للمستلم
        for (const t of [...recip.thresholds].sort((a, b) => a - b)) {
          const key = `${r.id}_${recip.id}_${t}`;
          if (mins >= t && !alerted[key]) {
            await sendWA(recip.phone, buildMsg(t), senderInstance);
            newAlerted[key] = Date.now();
            alertsSent++;
            console.log(`   📨 → ${recip.name} (${recip.phone}) t=${t}min [id=${r.id}]`);
          }
        }
      }
    }

    const cutoff = Date.now() - 24 * 3600000;
    Object.keys(newAlerted).forEach((k) => {
      if (newAlerted[k] < cutoff) delete newAlerted[k];
    });
    await db.ref("alerted").set(newAlerted);

    console.log(`✅ Total=${checked} Active=${activeFound} Alerts=${alertsSent}`);
    return {
      ok: true, total: checked, active: activeFound, alertsSent,
      sources: {
        reports: Object.keys(oldReports).length,
        reports2_outages: Object.keys(newReports).length,
      },
    };
  } catch (e) {
    console.error("❌ Error in checkAlerts:", e.message);
    return { ok: false, error: e.message };
  }
}

app.get("/", (req, res) => {
  res.json({
    status: "✅ طاقة Alert Server running",
    version: "3.6",
    time: new Date().toISOString(),
    features: [
      "✅ Per-recipient custom alert thresholds (dynamic)",
      "✅ Per-office alert recipients (multiple phones)",
      "✅ Multiple smart keys per feeder",
      "✅ Breaker (SCADA) status: no-response / local",
      "✅ Asia/Riyadh timezone",
    ],
    endpoints: ["GET /", "GET /config", "GET /check", "GET /reports", "GET /test-wa", "POST /send-wa", "GET /recipients"],
  });
});

app.get("/config", (req, res) => {
  res.json({
    WAWP_INSTANCE_ID: WAWP_INSTANCE ? "✅ set" : "❌ missing",
    WAWP_TOKEN: WAWP_TOKEN ? "✅ set" : "❌ missing",
    WA_TARGET: WA_TARGET || "❌ missing",
    FIREBASE: db ? "✅ connected" : "❌ not connected",
    paths: ["reports/", "reports2/outages/"],
    alert_thresholds: ALERT_THRESHOLDS,
    timezone: "Asia/Riyadh (UTC+3)",
  });
});

app.get("/check", async (req, res) => {
  const result = await checkAlerts();
  res.json({ ...result, time: new Date().toISOString() });
});

app.get("/reports", async (req, res) => {
  if (!db) return res.status(500).json({ ok: false, error: "no db" });
  try {
    const [oldSnap, newSnap] = await Promise.all([
      db.ref("reports").once("value"),
      db.ref("reports2/outages").once("value"),
    ]);
    const oldReports = oldSnap.val() || {};
    const newReports = newSnap.val() || {};
    const list = [];
    for (const [id, raw] of Object.entries(oldReports)) {
      const r = extractReport(id, raw, "reports");
      list.push({ ...r, durationMinutes: calcOutageMinutes(r.outageTime, r.createdAt) });
    }
    for (const [id, raw] of Object.entries(newReports)) {
      const r = extractReport(id, raw, "reports2/outages");
      list.push({ ...r, durationMinutes: calcOutageMinutes(r.outageTime, r.createdAt) });
    }
    const active = list.filter(r => !r.allRestored && r.status !== "closed");
    res.json({
      ok: true, total: list.length, active: active.length,
      sources: {
        reports: Object.keys(oldReports).length,
        "reports2/outages": Object.keys(newReports).length,
      },
      activeList: active, allList: list,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
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

app.post("/send-wa", async (req, res) => {
  const { phone, message } = req.body || {};
  if (!phone || !message) return res.status(400).json({ ok: false, error: "phone and message required" });
  const result = await sendWA(phone, message);
  res.json(result);
});

// v3.3: عرض المستلمين (تشخيص)
app.get("/recipients", async (req, res) => {
  if (!db) return res.status(500).json({ ok: false, error: "no db" });
  try {
    const snap = await db.ref("reports2/alertRecipients").once("value");
    const data = snap.val() || {};
    const list = Object.entries(data).map(([id, r]) => ({ id, ...r }));
    const byOffice = {};
    list.forEach(r => {
      let offices = [];
      if (Array.isArray(r.offices)) offices = r.offices;
      else if (r.office) offices = [r.office];
      offices.forEach(o => {
        if (!o) return;
        byOffice[o] = (byOffice[o] || 0) + 1;
      });
    });
    res.json({ ok: true, total: list.length, byOffice, recipients: list });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════
// v3.6: ربط المرسلين - إنشاء instance ومسح QR
// ═══════════════════════════════════════════════════════════

// إنشاء instance جديد وإرجاع QR code
app.post("/wawp/create-session", async (req, res) => {
  try {
    // 1. إنشاء instance جديد (POST)
    const createRes = await fetch("https://app.wawp.net/api/create_instance?access_token=" + WAWP_TOKEN, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    const createText = await createRes.text();
    let createData;
    try { createData = JSON.parse(createText); } catch { createData = { raw: createText.substring(0, 300) }; }

    const instanceId = createData.instance_id || createData.instanceId || (createData.data && createData.data.instance_id);
    if (!instanceId) {
      return res.status(500).json({ ok: false, error: "فشل إنشاء instance", detail: createData });
    }

    // 2. جلب QR code (POST)
    const qrRes = await fetch(`https://app.wawp.net/api/get_qrcode?instance_id=${instanceId}&access_token=${WAWP_TOKEN}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    const qrText = await qrRes.text();
    let qrData;
    try { qrData = JSON.parse(qrText); } catch { qrData = { raw: qrText.substring(0, 300) }; }

    const qrImage = qrData.base64 || qrData.qr || (qrData.data && qrData.data.qrcode) || null;

    res.json({
      ok: true,
      instanceId: instanceId,
      token: WAWP_TOKEN,
      qr: qrImage,
      raw: qrData,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// جلب QR code من جديد (لو انتهت صلاحيته)
app.get("/wawp/qr", async (req, res) => {
  const { instanceId } = req.query;
  if (!instanceId) return res.status(400).json({ ok: false, error: "instanceId required" });
  try {
    const qrRes = await fetch(`https://app.wawp.net/api/get_qrcode?instance_id=${instanceId}&access_token=${WAWP_TOKEN}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    const qrText = await qrRes.text();
    let qrData;
    try { qrData = JSON.parse(qrText); } catch { qrData = { raw: qrText.substring(0, 300) }; }
    const qrImage = qrData.base64 || qrData.qr || (qrData.data && qrData.data.qrcode) || null;
    res.json({ ok: true, qr: qrImage, status: qrData.status || null, raw: qrData });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// فحص حالة instance (هل صار WORKING؟)
app.get("/wawp/status", async (req, res) => {
  const { instanceId } = req.query;
  if (!instanceId) return res.status(400).json({ ok: false, error: "instanceId required" });
  try {
    // جرّب جلب معلومات الـ instance
    const statusRes = await fetch(`https://app.wawp.net/api/get_qrcode?instance_id=${instanceId}&access_token=${WAWP_TOKEN}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    const statusText = await statusRes.text();
    let statusData;
    try { statusData = JSON.parse(statusText); } catch { statusData = { raw: statusText.substring(0, 300) }; }

    // الحالة WORKING تعني مرتبط؛ لو ما فيه QR يعني ارتبط
    let status = statusData.status || "UNKNOWN";
    const hasQr = !!(statusData.base64 || statusData.qr);
    // لو ما فيه QR والحالة مو SCAN، غالباً ارتبط
    const isConnected = status === "WORKING" || status === "CONNECTED" ||
                        (!hasQr && status !== "SCAN_QR_CODE");

    res.json({ ok: true, status, isConnected, hasQr, raw: statusData });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// إرسال رسالة اختبار من instance معين
app.post("/wawp/test", async (req, res) => {
  const { instanceId, token, phone } = req.body || {};
  if (!instanceId || !phone) return res.status(400).json({ ok: false, error: "instanceId and phone required" });
  const result = await sendWA(phone, "✅ تم ربط رقمك بنجاح بنظام طاقة!\n\nالآن بلاغاتك وتنبيهاتها ستُرسل من هذا الرقم.",
    { instanceId, token: token || WAWP_TOKEN });
  res.json(result);
});

app.use((req, res) => {
  res.status(404).json({
    ok: false,
    error: `route not found: ${req.method} ${req.path}`,
    available: ["/", "/config", "/check", "/reports", "/test-wa", "/send-wa", "/recipients"],
  });
});

setInterval(checkAlerts, 5 * 60 * 1000);
setTimeout(checkAlerts, 5000);

app.listen(PORT, () => {
  console.log(`🚀 Server v3.6 running on port ${PORT}`);
  console.log(`🌍 Timezone: Asia/Riyadh (UTC+3)`);
  console.log(`📱 Per-recipient custom alert thresholds`);
  console.log(`📞 WA_TARGET: ${WA_TARGET || "(not set)"}`);
});
