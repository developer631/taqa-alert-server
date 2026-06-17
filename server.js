// ═══════════════════════════════════════════════════════════
// طاقة (TAQA) - Alert Server  v4.3-cleanup (آخر إصدار)
// + المحطات الإضافية في رسالة التنبيه
// + احتياطي تلقائي للرقم الرئيسي لو فشل رقم المرسِل
// + استعادة كلمة المرور عبر واتساب (صيغة OTP)
// + ربط المرسلين (QR + رمز اقتران Pairing Code)
// + عتبات لكل مستلم + مستلمين متعددين
// + المفتاح الذكي + القاطع + تطبيع أسماء المكاتب
// + توافق "مكتب القرى" / "منيزلة" / "شرق الأحساء"
// + توحيد أيقونات رسائل التنبيه (⭐)
// + تنبيه تكرار المغذي الفوري + زر اختبار الواتساب (v4.0)
// + إيقاف/تشغيل تنبيه المستلم للإجازات — تخطّي paused (v4.1)
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
  // توافق: منيزلة/المنيزلة/شرق الأحساء القديمة = مكتب القرى
  if (s === "منيزلة" || s === "المنيزلة" || s === "شرق الأحساء" || s === "شرق الاحساء" || s === "مكتب القرى") {
    return "مكتب القرى";
  }
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

  // دالة داخلية للإرسال من instance معيّن
  async function trySend(instanceId, token) {
    const res = await fetch("https://api.wawp.net/v2/send/text", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
      body: JSON.stringify({ instance_id: instanceId, access_token: token, chatId, message }),
    });
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = { raw: text.substring(0, 300) }; }
    return { ok: res.ok, status: res.status, data, instanceId };
  }

  // 1. جرّب instance المخصص (رقم المرسِل) لو موجود
  const customId = customInstance && customInstance.instanceId;
  const customToken = (customInstance && customInstance.token) || WAWP_TOKEN;
  try {
    if (customId) {
      const r = await trySend(customId, customToken);
      console.log(`📤 WA → ${chatId}: ${r.status} [instance: ${customId}]`);
      if (r.ok) return r;
      // فشل instance المرسِل → نرجع للرئيسي
      console.warn(`⚠️ custom instance ${customId} failed (${r.status}), falling back to MAIN`);
    }
    // 2. الرقم الرئيسي (احتياطي أو افتراضي)
    const main = await trySend(WAWP_INSTANCE, WAWP_TOKEN);
    console.log(`📤 WA → ${chatId}: ${main.status} [instance: MAIN ${WAWP_INSTANCE}]`);
    return main;
  } catch (e) {
    console.error("❌ WA error:", e.message);
    // محاولة أخيرة من الرئيسي لو الخطأ كان من المخصص
    if (customId) {
      try {
        const main = await trySend(WAWP_INSTANCE, WAWP_TOKEN);
        console.log(`📤 WA → ${chatId}: ${main.status} [instance: MAIN fallback]`);
        return main;
      } catch (e2) {
        return { ok: false, error: e2.message };
      }
    }
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
    // v3.9-fix: المحطات الإضافية (انقطاع محطات متعددة) — تظهر في رسالة التنبيه
    extraStations: data.extraStations || raw.extraStations || [],
  };
}

function formatOutageDetails(r) {
  const lines = [];
  const type = r.outageType;
  if (r.stationName) lines.push(`⭐ المحطة: ${r.stationName}`);

  if (type === "feeder" && r.feederName) {
    lines.push(`⭐ المغذي: ${r.feederName}`);
    // لا نعرض الباص لنوع المغذي — المغذي يحدّد الموقع بدقة
  } else if (type === "bus") {
    if (r.busNumbers && r.busNumbers.length > 0) {
      const list = r.busNumbers.includes("all")
        ? "كل الباصات"
        : r.busNumbers.map((b) => `B${b}`).join("، ");
      lines.push(`⭐ الباص/الباصات المتأثرة: ${list}`);
    } else if (r.busNumber) {
      lines.push(`⭐ الباص: B${r.busNumber}`);
    } else {
      lines.push(`⭐ نوع البلاغ: انقطاع باص`);
    }
  } else if (type === "station") {
    lines.push(`⚠️ انقطاع محطة كامل`);
    // محطات إضافية (انقطاع محطات متعددة)
    if (r.extraStations && r.extraStations.length > 0) {
      r.extraStations.forEach((st) => {
        const nm = typeof st === "string" ? st : (st.name || st.id);
        lines.push(`⭐ محطة إضافية: ${nm}`);
      });
    }
  } else {
    if (r.feederName) lines.push(`⭐ المغذي: ${r.feederName}`);
    if (!r.feederName && r.busNumber) lines.push(`⭐ الباص: B${r.busNumber}`);
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
      if (r.paused) return; // إجازة — لا تُرسل له تنبيهات
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

      // دالة بناء نص الرسالة لعتبة معينة
      const buildMsg = (threshold) => {
        const emoji = threshold >= 120 ? "🚨" : "⚠️";
        return `${emoji} *تنبيه تأخر انقطاع*\n\n` +
          `⭐ المكتب: ${r.office || "—"}\n` +
          `${outageDetails}\n` +
          `⭐ المناطق: ${r.affectedAreas || "—"}\n` +
          `⭐ وقت الانقطاع: ${r.outageTime}\n` +
          `⭐ المدة: ${durationText}\n` +
          `⭐ المتأثرين: ${r.totalAffected || "-"} | المتبقي: ${r.remainingCount !== undefined ? r.remainingCount : "—"}\n` +
          (r.sensitive ? `⭐ مشتركون حساسون: ${r.sensitive}\n` : "") +
          (r.reason ? `⭐ السبب: ${r.reason}\n` : "") +
          smartKeyWarning +
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
        // v3.9-fix: تخطّى المستلم لو رقمه = الرقم الرئيسي (يكون اتنبّه أصلاً كـ MAIN)
        if (WA_TARGET && cleanRecip === cleanTarget) {
          console.log(`   ⏭️ skip ${recip.name} (${recip.phone}) — same as WA_TARGET`);
          continue;
        }
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
    version: "3.9-extrast",
    time: new Date().toISOString(),
    features: [
      "✅ Per-recipient custom alert thresholds (dynamic)",
      "✅ Per-office alert recipients (multiple phones)",
      "✅ Multiple smart keys per feeder",
      "✅ Breaker (SCADA) status: no-response / local",
      "✅ Asia/Riyadh timezone",
    ],
    endpoints: ["GET /", "GET /config", "GET /check", "GET /reports", "GET /test-wa", "POST /send-wa", "GET /recipients", "POST /admin/set-password", "POST /admin/delete-user", "POST /admin/cleanup-orphans"],
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

// تشخيص: جرّب إنشاء جلسة ورجّع كل المحاولات (GET للتجربة من المتصفح)
app.get("/wawp/diag", async (req, res) => {
  const attempts = [];
  const TOKEN = WAWP_TOKEN;
  const endpoints = [
    { name: "V2 session/create POST", url: "https://api.wawp.net/v2/session/create?access_token=" + TOKEN, method: "POST", body: JSON.stringify({ access_token: TOKEN }) },
    { name: "V2 session/start POST", url: "https://api.wawp.net/v2/session/start?access_token=" + TOKEN, method: "POST", body: JSON.stringify({ access_token: TOKEN }) },
    { name: "V1 create_instance POST", url: "https://app.wawp.net/api/create_instance?access_token=" + TOKEN, method: "POST", body: JSON.stringify({ access_token: TOKEN }) },
    { name: "V1 create_instance GET", url: "https://app.wawp.net/api/create_instance?access_token=" + TOKEN, method: "GET" },
  ];
  for (const ep of endpoints) {
    try {
      const opts = { method: ep.method, headers: { "Content-Type": "application/json", "Authorization": "Bearer " + TOKEN } };
      if (ep.body) opts.body = ep.body;
      const r = await fetch(ep.url, opts);
      const t = await r.text();
      let d; try { d = JSON.parse(t); } catch { d = { raw: t.substring(0, 400) }; }
      attempts.push({ endpoint: ep.name, status: r.status, response: d });
    } catch (e) {
      attempts.push({ endpoint: ep.name, error: e.message });
    }
  }
  res.json({ ok: true, token_used: TOKEN.substring(0, 6) + "...", attempts });
});

// تشخيص Pairing Code لـ instance معيّن (GET للتجربة من المتصفح)
// الاستخدام: /wawp/diag-pair?instanceId=XXXX&phone=9665XXXXXXXX
app.get("/wawp/diag-pair", async (req, res) => {
  const TOKEN = WAWP_TOKEN;
  const instanceId = req.query.instanceId;
  const phone = (req.query.phone || "").replace(/[\s\-\+]/g, "");
  if (!instanceId || !phone) return res.status(400).json({ ok: false, error: "أضف ?instanceId=XXXX&phone=9665XXXXXXXX" });

  const results = {};
  const tries = [
    { name: "auth/request-code POST", url: `https://api.wawp.net/v2/auth/request-code?instance_id=${instanceId}&access_token=${TOKEN}`, body: { access_token: TOKEN, instance_id: instanceId, phone: phone, phoneNumber: phone } },
    { name: "auth/pairing-code POST", url: `https://api.wawp.net/v2/auth/pairing-code?instance_id=${instanceId}&access_token=${TOKEN}`, body: { access_token: TOKEN, instance_id: instanceId, phone: phone, phoneNumber: phone } },
    { name: "auth/pair POST", url: `https://api.wawp.net/v2/auth/pair?instance_id=${instanceId}&access_token=${TOKEN}`, body: { access_token: TOKEN, instance_id: instanceId, phone: phone, phoneNumber: phone } },
    { name: "auth/code POST", url: `https://api.wawp.net/v2/auth/code?instance_id=${instanceId}&access_token=${TOKEN}`, body: { access_token: TOKEN, instance_id: instanceId, phone: phone, phoneNumber: phone } },
    { name: "session/pairing-code POST", url: `https://api.wawp.net/v2/session/pairing-code?instance_id=${instanceId}&access_token=${TOKEN}`, body: { access_token: TOKEN, instance_id: instanceId, phone: phone, phoneNumber: phone } },
  ];
  for (const t of tries) {
    try {
      const r = await fetch(t.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + TOKEN },
        body: JSON.stringify(t.body),
      });
      const txt = await r.text();
      let d; try { d = JSON.parse(txt); } catch { d = { raw: txt.substring(0, 200) }; }
      results[t.name] = { status: r.status, keys: Object.keys(d), data: d };
    } catch (e) {
      results[t.name] = { error: e.message };
    }
  }
  res.json({ ok: true, instanceId, phone, results });
});

// تشخيص QR والحالة لـ instance معيّن (GET للتجربة من المتصفح)
app.get("/wawp/diag-qr", async (req, res) => {
  const TOKEN = WAWP_TOKEN;
  const instanceId = req.query.instanceId;
  if (!instanceId) return res.status(400).json({ ok: false, error: "أضف ?instanceId=XXXX" });

  const results = {};
  const tries = [
    { name: "qr-image POST", url: `https://api.wawp.net/v2/auth/qr-image?instance_id=${instanceId}&access_token=${TOKEN}`, method: "POST" },
    { name: "qr-image GET", url: `https://api.wawp.net/v2/auth/qr-image?instance_id=${instanceId}&access_token=${TOKEN}`, method: "GET" },
    { name: "qr (raw) POST", url: `https://api.wawp.net/v2/auth/qr?instance_id=${instanceId}&access_token=${TOKEN}`, method: "POST" },
    { name: "session/status POST", url: `https://api.wawp.net/v2/session/status?instance_id=${instanceId}&access_token=${TOKEN}`, method: "POST" },
    { name: "session/info GET", url: `https://api.wawp.net/v2/session/info?instance_id=${instanceId}&access_token=${TOKEN}`, method: "GET" },
  ];
  for (const t of tries) {
    try {
      const opts = { method: t.method, headers: { "Content-Type": "application/json", "Authorization": "Bearer " + TOKEN } };
      if (t.method === "POST") opts.body = JSON.stringify({ access_token: TOKEN, instance_id: instanceId });
      const r = await fetch(t.url, opts);
      const txt = await r.text();
      let d; try { d = JSON.parse(txt); } catch { d = { raw: txt.substring(0, 200) }; }
      // اختصر الـ QR الطويل
      if (d.qr && d.qr.length > 60) d.qr = d.qr.substring(0, 60) + "...[truncated]";
      if (d.base64 && d.base64.length > 60) d.base64 = d.base64.substring(0, 60) + "...[truncated]";
      results[t.name] = { status: r.status, keys: Object.keys(d), data: d };
    } catch (e) {
      results[t.name] = { error: e.message };
    }
  }
  res.json({ ok: true, instanceId, results });
});

// تشخيص: جرّب الإرسال من instance معيّن واكشف الرد
// /wawp/diag-send?instanceId=XXXX&phone=966XXX
app.get("/wawp/diag-send", async (req, res) => {
  const instanceId = req.query.instanceId;
  const phone = (req.query.phone || WA_TARGET || "").replace(/[\s\-\+]/g, "");
  if (!instanceId || !phone) return res.status(400).json({ ok: false, error: "أضف ?instanceId=XXXX&phone=966XXX" });

  // 1. افحص حالة الـ instance أول
  let statusInfo = {};
  try {
    const sr = await fetch(`https://api.wawp.net/v2/session/info?instance_id=${instanceId}&access_token=${WAWP_TOKEN}`, {
      method: "GET", headers: { "Authorization": "Bearer " + WAWP_TOKEN },
    });
    const st = await sr.text();
    try { statusInfo = JSON.parse(st); } catch { statusInfo = { raw: st.substring(0, 200) }; }
  } catch (e) { statusInfo = { error: e.message }; }

  // 2. جرّب الإرسال بصيغتين (message / text)
  const chatId = phone + "@c.us";
  const sends = {};
  const variants = [
    { name: "body message", body: { instance_id: instanceId, access_token: WAWP_TOKEN, chatId, message: "🧪 اختبار TAQA" } },
    { name: "body text", body: { instance_id: instanceId, access_token: WAWP_TOKEN, chatId, text: "🧪 اختبار TAQA" } },
    { name: "query+text", url: `https://api.wawp.net/v2/send/text?instance_id=${instanceId}&access_token=${WAWP_TOKEN}`, body: { chatId, text: "🧪 اختبار TAQA" } },
  ];
  for (const v of variants) {
    try {
      const r = await fetch(v.url || "https://api.wawp.net/v2/send/text", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + WAWP_TOKEN },
        body: JSON.stringify(v.body),
      });
      const t = await r.text();
      let d; try { d = JSON.parse(t); } catch { d = { raw: t.substring(0, 200) }; }
      sends[v.name] = { status: r.status, data: d };
    } catch (e) {
      sends[v.name] = { error: e.message };
    }
  }
  res.json({ ok: true, instanceId, phone, sessionStatus: statusInfo.status || statusInfo, sends });
});

// ═══ استعادة كلمة المرور عبر واتساب ═══
// محاولات الاسترداد (حماية بسيطة من الإساءة)
const resetAttempts = {}; // { badge: { count, firstAt } }

app.post("/auth/reset-password", async (req, res) => {
  const badge = String((req.body && req.body.badge) || "").trim();
  const phone = String((req.body && req.body.phone) || "").replace(/[\s\-\+]/g, "").replace(/^00/, "");
  if (!badge || !phone) return res.status(400).json({ ok: false, error: "الرقم الوظيفي ورقم الجوال مطلوبان" });

  // حماية: حد 3 محاولات لكل رقم وظيفي في الساعة
  const now = Date.now();
  const rec = resetAttempts[badge];
  if (rec && now - rec.firstAt < 3600000) {
    if (rec.count >= 3) {
      return res.status(429).json({ ok: false, error: "محاولات كثيرة. حاول بعد ساعة." });
    }
    rec.count++;
  } else {
    resetAttempts[badge] = { count: 1, firstAt: now };
  }

  try {
    // 1. تأكد إن الحساب موجود
    const email = badge + "@taqa.sec";
    let userRecord;
    try {
      userRecord = await admin.auth().getUserByEmail(email);
    } catch (e) {
      return res.status(404).json({ ok: false, error: "الرقم الوظيفي غير مسجّل" });
    }

    // 2. ولّد كلمة مرور مؤقتة (8 أحرف/أرقام)
    const tempPass = String(Math.floor(100000 + Math.random() * 900000)); // 6 أرقام

    // 3. عيّنها للحساب
    await admin.auth().updateUser(userRecord.uid, { password: tempPass });

    // 4. أرسلها واتساب من الرقم الرئيسي لجوال الموظف
    const msg = `TAQA code: ${tempPass}\n\n🔑 كلمة المرور المؤقتة لاستعادة حسابك في TAQA.\n\nإذا لم تطلب هذا، تجاهل الرسالة.`;
    const sendResult = await sendWA(phone, msg); // من الرقم الرئيسي (بدون customInstance)

    if (!sendResult.ok) {
      return res.status(502).json({ ok: false, error: "فشل إرسال الواتساب. تأكد من الرقم." });
    }

    res.json({ ok: true, message: "تم إرسال كلمة مرور مؤقتة لواتسابك" });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ═══ تغيير باسورد موظف من لوحة الإدارة (Admin SDK — يعمل لكل الحسابات بدون الباسورد القديم) ═══
// يتحقّق من توكن المُرسِل وأنه مدير قبل التنفيذ
const ADMIN_BADGES_SRV = ["77996"];
app.post("/admin/set-password", async (req, res) => {
  const idToken = String((req.body && req.body.idToken) || "");
  const targetBadge = String((req.body && req.body.targetBadge) || "").trim();
  const newPassword = String((req.body && req.body.newPassword) || "");
  if (!idToken || !targetBadge || !newPassword) return res.status(400).json({ ok: false, error: "بيانات ناقصة" });
  if (newPassword.length < 6) return res.status(400).json({ ok: false, error: "الباسورد 6 خانات على الأقل" });
  try {
    // 1. تحقّق أن المُرسِل مدير
    let decoded;
    try { decoded = await admin.auth().verifyIdToken(idToken); }
    catch (e) { return res.status(401).json({ ok: false, error: "جلسة غير صالحة" }); }
    const callerBadge = String(decoded.email || "").split("@")[0];
    let callerRole = null;
    try { callerRole = (await db.ref("users/" + decoded.uid + "/role").once("value")).val(); } catch (_) {}
    const isAdmin = callerRole === "admin" || ADMIN_BADGES_SRV.includes(callerBadge);
    if (!isAdmin) return res.status(403).json({ ok: false, error: "غير مصرّح — للمدير فقط" });
    // 2. جد حساب الهدف
    const email = targetBadge + "@taqa.sec";
    let userRecord;
    try { userRecord = await admin.auth().getUserByEmail(email); }
    catch (e) { return res.status(404).json({ ok: false, error: "الرقم الوظيفي غير مسجّل" }); }
    // 3. غيّر الباسورد
    await admin.auth().updateUser(userRecord.uid, { password: newPassword });
    // 4. خزّن الباسورد الجديد في السجل
    try { await db.ref("users/" + userRecord.uid + "/pw").set(newPassword); } catch (_) {}
    try { await db.ref("users/" + userRecord.uid + "/pwChanged").set(true); } catch (_) {}
    res.json({ ok: true, uid: userRecord.uid });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ═══ حذف موظف نهائياً من لوحة الإدارة (Admin SDK — يحذف حساب الدخول + السجل) ═══
app.post("/admin/delete-user", async (req, res) => {
  const idToken = String((req.body && req.body.idToken) || "");
  const targetBadge = String((req.body && req.body.targetBadge) || "").trim();
  if (!idToken || !targetBadge) return res.status(400).json({ ok: false, error: "بيانات ناقصة" });
  try {
    let decoded;
    try { decoded = await admin.auth().verifyIdToken(idToken); }
    catch (e) { return res.status(401).json({ ok: false, error: "جلسة غير صالحة" }); }
    const callerBadge = String(decoded.email || "").split("@")[0];
    let callerRole = null;
    try { callerRole = (await db.ref("users/" + decoded.uid + "/role").once("value")).val(); } catch (_) {}
    const isAdmin = callerRole === "admin" || ADMIN_BADGES_SRV.includes(callerBadge);
    if (!isAdmin) return res.status(403).json({ ok: false, error: "غير مصرّح — للمدير فقط" });
    if (ADMIN_BADGES_SRV.includes(targetBadge)) return res.status(400).json({ ok: false, error: "لا يمكن حذف المدير الدائم" });
    const email = targetBadge + "@taqa.sec";
    let userRecord;
    try { userRecord = await admin.auth().getUserByEmail(email); }
    catch (e) { return res.json({ ok: true, authDeleted: false, note: "no auth account" }); }
    if (userRecord.uid === decoded.uid) return res.status(400).json({ ok: false, error: "لا يمكن حذف حسابك" });
    await admin.auth().deleteUser(userRecord.uid);
    try { await db.ref("users/" + userRecord.uid).remove(); } catch (_) {}
    res.json({ ok: true, authDeleted: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ═══ تنظيف الحسابات اليتيمة: حسابات Auth بدون سجل في القائمة (users) ═══
app.post("/admin/cleanup-orphans", async (req, res) => {
  const idToken = String((req.body && req.body.idToken) || "");
  if (!idToken) return res.status(400).json({ ok: false, error: "بيانات ناقصة" });
  try {
    let decoded;
    try { decoded = await admin.auth().verifyIdToken(idToken); }
    catch (e) { return res.status(401).json({ ok: false, error: "جلسة غير صالحة" }); }
    const callerBadge = String(decoded.email || "").split("@")[0];
    let callerRole = null;
    try { callerRole = (await db.ref("users/" + decoded.uid + "/role").once("value")).val(); } catch (_) {}
    if (!(callerRole === "admin" || ADMIN_BADGES_SRV.includes(callerBadge))) return res.status(403).json({ ok: false, error: "غير مصرّح — للمدير فقط" });
    // اجمع الموجودين في القائمة (uid + badge)
    const usersSnap = await db.ref("users").once("value");
    const dbUsers = usersSnap.val() || {};
    const dbUids = new Set(Object.keys(dbUsers));
    const dbBadges = new Set(Object.values(dbUsers).map(u => String(u.badgeNum || "")));
    // مرّ على كل حسابات Auth واحذف اللي ما له سجل
    let deleted = [], kept = 0, nextToken;
    do {
      const list = await admin.auth().listUsers(1000, nextToken);
      for (const u of list.users) {
        const badge = String(u.email || "").split("@")[0];
        // أبقِ: المدير الدائم، حساب المُرسِل، أو أي حساب موجود في القائمة (بالـuid أو الرقم)
        if (ADMIN_BADGES_SRV.includes(badge) || u.uid === decoded.uid || dbUids.has(u.uid) || dbBadges.has(badge)) { kept++; continue; }
        try { await admin.auth().deleteUser(u.uid); deleted.push(badge); } catch (_) {}
      }
      nextToken = list.pageToken;
    } while (nextToken);
    res.json({ ok: true, deletedCount: deleted.length, deleted, keptCount: kept });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// طلب رمز اقتران (Pairing Code) - بديل QR
app.post("/wawp/request-code", async (req, res) => {
  const { instanceId, phone } = req.body || {};
  if (!instanceId || !phone) return res.status(400).json({ ok: false, error: "instanceId and phone required" });
  const cleanPhone = String(phone).replace(/[\s\-\+]/g, "").replace(/^00/, "");
  try {
    const r = await fetch(`https://api.wawp.net/v2/auth/request-code?instance_id=${instanceId}&access_token=${WAWP_TOKEN}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + WAWP_TOKEN },
      body: JSON.stringify({ access_token: WAWP_TOKEN, instance_id: instanceId, phone: cleanPhone, phone_number: cleanPhone, phoneNumber: cleanPhone }),
    });
    const txt = await r.text();
    let d; try { d = JSON.parse(txt); } catch { d = { raw: txt.substring(0, 200) }; }
    const code = d.code || d.pairingCode || d.pairing_code || null;
    if (!r.ok || !code) {
      return res.status(r.status).json({ ok: false, error: d.message || "فشل طلب الرمز", detail: d });
    }
    res.json({ ok: true, code });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// إنشاء instance جديد وإرجاع QR code (V2 - مؤكّد)
app.post("/wawp/create-session", async (req, res) => {
  const TOKEN = WAWP_TOKEN;
  try {
    // 1. إنشاء جلسة جديدة (V2)
    const createRes = await fetch("https://api.wawp.net/v2/session/create?access_token=" + TOKEN, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + TOKEN },
      body: JSON.stringify({ access_token: TOKEN }),
    });
    const createText = await createRes.text();
    let createData;
    try { createData = JSON.parse(createText); } catch { createData = { raw: createText.substring(0, 300) }; }

    const instanceId = createData.instance_id || createData.instanceId;
    if (!createRes.ok || !instanceId) {
      return res.status(500).json({ ok: false, error: "فشل إنشاء الجلسة", detail: createData });
    }

    console.log(`✅ Session created: ${instanceId} (${createData.session_name})`);

    // رجّع فوراً مع instanceId - الـ frontend يسحب QR بالـ polling
    // (نحاول جلب QR مرة وحدة بسرعة، لو ما جهز الـ frontend يعيد المحاولة)
    await new Promise(r => setTimeout(r, 4000));
    const qr = await fetchQRv2(instanceId, TOKEN);

    res.json({
      ok: true,
      instanceId: instanceId,
      token: TOKEN,
      sessionName: createData.session_name || null,
      qr: qr.qr,
      qrRaw: qr.raw,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// دالة مساعدة: جلب QR (V2 qr-image)
async function fetchQRv2(instanceId, token) {
  try {
    const r = await fetch(`https://api.wawp.net/v2/auth/qr-image?instance_id=${instanceId}&access_token=${token}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token },
      body: JSON.stringify({ access_token: token, instance_id: instanceId }),
    });
    const t = await r.text();
    let d; try { d = JSON.parse(t); } catch { d = { raw: t.substring(0, 300) }; }
    const qr = d.qr || d.base64 || d.qrcode || (d.data && d.data.qr) || null;
    return { qr, raw: d, status: r.status };
  } catch (e) {
    return { qr: null, raw: { error: e.message } };
  }
}

// جلب QR code من جديد (لو انتهت صلاحيته)
app.get("/wawp/qr", async (req, res) => {
  const { instanceId } = req.query;
  if (!instanceId) return res.status(400).json({ ok: false, error: "instanceId required" });
  const qr = await fetchQRv2(instanceId, WAWP_TOKEN);
  res.json({ ok: true, qr: qr.qr, raw: qr.raw });
});

// فحص حالة instance (هل صار WORKING؟) - V2
app.get("/wawp/status", async (req, res) => {
  const { instanceId } = req.query;
  if (!instanceId) return res.status(400).json({ ok: false, error: "instanceId required" });
  try {
    const statusRes = await fetch(`https://api.wawp.net/v2/session/info?instance_id=${instanceId}&access_token=${WAWP_TOKEN}`, {
      method: "GET",
      headers: { "Authorization": "Bearer " + WAWP_TOKEN },
    });
    const statusText = await statusRes.text();
    let statusData;
    try { statusData = JSON.parse(statusText); } catch { statusData = { raw: statusText.substring(0, 300) }; }

    const status = statusData.status || "UNKNOWN";
    // مرتبط فقط لو WORKING (مو SCAN_QR_CODE / STARTING / STOPPED / FAILED)
    const isConnected = status === "WORKING";

    res.json({ ok: true, status, isConnected, raw: statusData });
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

// ═══════════════════════════════════════════════════════════
// تنبيهات تكرار المغذي (فوري) — v9
// التطبيق يكتب في reports2/recurrenceAlerts، والسيرفر يرسلها
// واتساب لأرقام مستلمي المكتب (phones) من رقم المرسِل أو الرئيسي.
// ═══════════════════════════════════════════════════════════
function watchRecurrenceAlerts() {
  if (!db) { console.error("❌ recurrence watcher: no DB"); return; }
  // نراقب آخر 50 سجل فقط — السجلات المُرسلة (sent:true) تُتجاهل
  db.ref("reports2/recurrenceAlerts").limitToLast(50).on("child_added", async (snap) => {
    const alert = snap.val();
    if (!alert || alert.sent) return; // أُرسل سابقاً أو فارغ

    try {
      const phones = Array.isArray(alert.phones) ? alert.phones : [];
      if (!phones.length) {
        await snap.ref.update({ sent: true, sentCount: 0, note: "no phones" });
        return;
      }
      let okCount = 0;
      for (const phone of phones) {
        try {
          const r = await sendWA(phone, alert.message, alert.senderWawp || null);
          if (r && r.ok) okCount++;
          await new Promise((res) => setTimeout(res, 800)); // فاصل بين الرسائل
        } catch (e) {
          console.error(`❌ recurrence WA → ${phone}:`, e.message);
        }
      }
      await snap.ref.update({ sent: true, sentAt: Date.now(), sentCount: okCount });
      const tag = alert.type === "test" ? "🔔 اختبار" : "🔁 تكرار";
      console.log(`${tag} ${alert.feederName || ""} (${alert.office || ""}) → ${okCount}/${phones.length}`);
    } catch (e) {
      console.error("❌ recurrence alert failed:", e.message);
      // علّمه "تم" مع خطأ حتى لا يتكرر بلا نهاية
      try { await snap.ref.update({ sent: true, error: String(e.message || e) }); } catch (_) {}
    }
  });
  console.log("✅ Recurrence alerts watcher started");
}
watchRecurrenceAlerts();

// (اختياري) تنظيف يومي للتنبيهات المُرسلة الأقدم من 30 يوم
setInterval(async () => {
  if (!db) return;
  try {
    const cutoff = Date.now() - 30 * 86400000;
    const snap = await db.ref("reports2/recurrenceAlerts").once("value");
    const all = snap.val() || {};
    const updates = {};
    for (const [k, v] of Object.entries(all)) {
      if (v && v.sent && v.createdAt && v.createdAt < cutoff) updates[k] = null;
    }
    if (Object.keys(updates).length) {
      await db.ref("reports2/recurrenceAlerts").update(updates);
      console.log(`🧹 cleaned ${Object.keys(updates).length} old recurrence alerts`);
    }
  } catch (e) { console.error("cleanup error:", e.message); }
}, 86400000);

app.listen(PORT, () => {
  console.log(`🚀 Server v4.3-cleanup running on port ${PORT}`);
  console.log(`🌍 Timezone: Asia/Riyadh (UTC+3)`);
  console.log(`📱 Per-recipient custom alert thresholds`);
  console.log(`📞 WA_TARGET: ${WA_TARGET || "(not set)"}`);
});
