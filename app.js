/* ============================================================
   Météo — 100% Open-Meteo (conditions actuelles + prévisions)
   ============================================================ */

/* ---------- Villes (onglets, localStorage) ---------- */
function loadCities() {
  try {
    const c = JSON.parse(localStorage.getItem("cities"));
    if (Array.isArray(c) && c.length) return c;
  } catch {}
  return [];
}
let cities = loadCities();
let activeCityIdx = Math.max(0, Math.min(Number(localStorage.getItem("activeCityIdx")) || 0, cities.length - 1));

const city = () => cities[activeCityIdx];
const LAT = () => city().lat;
const LON = () => city().lon;

function saveCities() {
  localStorage.setItem("cities", JSON.stringify(cities));
  localStorage.setItem("activeCityIdx", String(activeCityIdx));
}

const $ = (id) => document.getElementById(id);

/* ---------- Fetch Open-Meteo avec limitation de débit + retry sur 429 ----------
   File d'attente globale : 1 requête à la fois, espacement mini entre requêtes,
   et backoff exponentiel (ou Retry-After) en cas de 429/502/503. */
const omFetch = (() => {
  const MIN_INTERVAL = 350; // ms entre deux requêtes
  const RETRY_DELAYS = [2000, 5000, 15000]; // backoff après 429/502/503
  let queue = Promise.resolve();
  let lastReq = 0;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  return (url) => {
    const task = queue.then(async () => {
      for (let attempt = 0; ; attempt++) {
        const wait = lastReq + MIN_INTERVAL - Date.now();
        if (wait > 0) await sleep(wait);
        lastReq = Date.now();
        let res;
        try {
          res = await fetch(url);
        } catch (e) {
          if (attempt >= RETRY_DELAYS.length) throw e;
          await sleep(RETRY_DELAYS[attempt]);
          continue;
        }
        if (![429, 502, 503].includes(res.status) || attempt >= RETRY_DELAYS.length) return res;
        const retryAfter = Number(res.headers.get("Retry-After"));
        await sleep(retryAfter > 0 ? retryAfter * 1000 : RETRY_DELAYS[attempt]);
      }
    });
    queue = task.catch(() => {}); // la file continue même si une requête échoue
    return task;
  };
})();

/* ---------- Helpers ---------- */
const fmt = (v, unit = "", digits = 1) =>
  v === null || v === undefined || Number.isNaN(v) ? "--" : `${Number(v).toFixed(digits).replace(/\.0$/, "")}${unit}`;

const windDirLabel = (deg) => {
  if (deg == null) return "--";
  const dirs = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSO", "SO", "OSO", "O", "ONO", "NO", "NNO"];
  return dirs[Math.round(deg / 22.5) % 16];
};

const windArrow = (deg) =>
  deg == null ? "" : `<span class="wind-arrow" style="transform:rotate(${(deg + 180) % 360}deg)" title="${windDirLabel(deg)} (${Math.round(deg)}°)">&#8593;</span>`;

/* durée en secondes → "6h05" */
const fmtDur = (s) =>
  s == null ? "--" : `${Math.floor(s / 3600)}h${String(Math.round((s % 3600) / 60)).padStart(2, "0")}`;

/* Icônes SVG minimales lever/coucher de soleil */
const sunSvg = (up) => `
<svg class="sun-icon" viewBox="0 0 24 16" width="22" height="15" aria-hidden="true">
  <g stroke="${up ? "#ffca6b" : "#ff9d6b"}" stroke-width="1.6" stroke-linecap="round" fill="none">
    <path d="M6 11a6 6 0 0 1 12 0"/>
    <line x1="2" y1="13.5" x2="22" y2="13.5"/>
    <line x1="12" y1="${up ? "5.5" : "2.5"}" x2="12" y2="${up ? "2.5" : "5.5"}"/>
    <path d="M${up ? "10 4.5 12 2.5 14 4.5" : "10 3.5 12 5.5 14 3.5"}"/>
  </g>
</svg>`;

const WMO = {
  0: ["☀️", "Ciel clair"], 1: ["🌤️", "Peu nuageux"], 2: ["⛅", "Partiellement nuageux"], 3: ["☁️", "Couvert"],
  45: ["🌫️", "Brouillard"], 48: ["🌫️", "Brouillard givrant"],
  51: ["🌦️", "Bruine légère"], 53: ["🌦️", "Bruine"], 55: ["🌧️", "Bruine forte"],
  61: ["🌦️", "Pluie faible"], 63: ["🌧️", "Pluie"], 65: ["🌧️", "Pluie forte"],
  66: ["🌧️", "Pluie verglaçante"], 67: ["🌧️", "Pluie verglaçante forte"],
  71: ["🌨️", "Neige faible"], 73: ["🌨️", "Neige"], 75: ["❄️", "Neige forte"], 77: ["❄️", "Neige en grains"],
  80: ["🌦️", "Averses faibles"], 81: ["🌧️", "Averses"], 82: ["⛈️", "Averses fortes"],
  85: ["🌨️", "Averses de neige"], 86: ["🌨️", "Averses de neige fortes"],
  95: ["⛈️", "Orage"], 96: ["⛈️", "Orage + grêle"], 99: ["⛈️", "Orage violent"],
};
const wmo = (code) => WMO[code] || ["❓", "?"];

// seuils d'humidité volumique du sol (m³/m³, sol limoneux type Bretagne) :
// < 10% point de flétrissement, 10-15% sec, 15-25% correct, 25-35% humide, > 35% saturé
const soilLevel = (v) => {
  if (v == null) return null;
  const p = v * 100;
  if (p < 10) return ["Sécheresse", "#e57373", "Sous le point de flétrissement : les plantes ne peuvent plus extraire d'eau"];
  if (p < 15) return ["Sec", "#ffb74d", "Réserve utile faible : surveiller, irrigation à envisager"];
  if (p < 25) return ["Correct", "#81c784", "Réserve utile confortable"];
  if (p < 35) return ["Humide", "#4fc3f7", "Sol proche de la capacité au champ"];
  return ["Saturé", "#9575cd", "Sol gorgé d'eau : risque d'asphyxie racinaire / portance réduite"];
};

/* ---------- Tooltip partagé pour les graphes canvas ---------- */
const chartTip = (() => {
  let el = null;
  return {
    show(html, px, py) {
      if (!el) { el = document.createElement("div"); el.className = "chart-tip"; document.body.appendChild(el); }
      el.innerHTML = html;
      el.style.display = "block";
      const r = el.getBoundingClientRect();
      let x = px + 14;
      if (x + r.width > window.innerWidth - 8) x = px - r.width - 14;
      el.style.left = x + "px";
      el.style.top = Math.max(4, py - r.height - 12) + "px";
    },
    hide() { if (el) el.style.display = "none"; },
  };
})();

/* associe un tooltip "point le plus proche" à un canvas (cfg rafraîchie à chaque tracé) */
function attachChartTip(canvas, cfg) {
  canvas._tip = cfg; // { padL, padR, count, html(i), onHover?(i|null) }
  if (canvas._tipBound) return;
  canvas._tipBound = true;
  const hover = (i) => {
    const c = canvas._tip;
    if (!c.onHover || canvas._hoverI === i) return;
    canvas._hoverI = i;
    c.onHover(i);
  };
  canvas.addEventListener("mousemove", (e) => {
    const c = canvas._tip;
    if (!c) return;
    const rect = canvas.getBoundingClientRect();
    const i = Math.round(((e.clientX - rect.left - c.padL) / (rect.width - c.padL - c.padR)) * (c.count - 1));
    if (i < 0 || i >= c.count) { hover(null); return chartTip.hide(); }
    const html = c.html(i);
    if (!html) { hover(null); return chartTip.hide(); }
    hover(i);
    chartTip.show(html, e.clientX, e.clientY);
  });
  canvas.addEventListener("mouseleave", () => { hover(null); chartTip.hide(); });
}

/* ---------- Mini chart (canvas, sans lib) ---------- */
function drawLineChart(canvas, labels, values, { color = "#4fc3f7", unit = "", colorFor = null, markIndex = null, tipFor = null } = {}) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || canvas.parentElement.clientWidth;
  if (!canvas.dataset.h) canvas.dataset.h = canvas.getAttribute("height") || 140;
  const h = Number(canvas.dataset.h);
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.height = h + "px";
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);

  const pts = values.map((v, i) => ({ v, i })).filter((p) => p.v != null);
  if (pts.length < 2) return;

  const pad = { l: 36, r: 8, t: 12, b: 20 };
  const min = Math.min(...pts.map((p) => p.v));
  const max = Math.max(...pts.map((p) => p.v));
  const range = max - min || 1;
  const x = (i) => pad.l + (i / (values.length - 1)) * (w - pad.l - pad.r);
  const y = (v) => pad.t + (1 - (v - min) / range) * (h - pad.t - pad.b);

  attachChartTip(canvas, {
    padL: pad.l, padR: pad.r, count: values.length,
    html: (i) => values[i] == null ? null :
      (tipFor ? tipFor(i) : `<b>${values[i].toFixed(1)}${unit}</b> · ${labels[i]}`),
  });

  // grid + labels axe Y
  ctx.strokeStyle = "rgba(255,255,255,.07)";
  ctx.fillStyle = "#8fa1bb";
  ctx.font = "10px sans-serif";
  ctx.textAlign = "right";
  for (let g = 0; g <= 3; g++) {
    const v = min + (range * g) / 3;
    const gy = y(v);
    ctx.beginPath(); ctx.moveTo(pad.l, gy); ctx.lineTo(w - pad.r, gy); ctx.stroke();
    ctx.fillText(v.toFixed(1) + unit, pad.l - 5, gy + 3);
  }
  // labels axe X (5 max)
  ctx.textAlign = "center";
  const step = Math.max(1, Math.floor(labels.length / 5));
  for (let i = 0; i < labels.length; i += step) ctx.fillText(labels[i], x(i), h - 5);

  // area + line
  const drawMark = () => {
    if (markIndex == null || values[markIndex] == null) return;
    const mv = values[markIndex];
    const mc = colorFor ? colorFor(mv) : color;
    ctx.beginPath();
    ctx.arc(x(markIndex), y(mv), 4, 0, Math.PI * 2);
    ctx.fillStyle = mc;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = "#fff";
    ctx.stroke();
  };
  if (colorFor) {
    // tracé coloré segment par segment selon la valeur (+ remplissage assorti)
    for (let k = 1; k < pts.length; k++) {
      const a = pts[k - 1], b = pts[k];
      const segColor = colorFor((a.v + b.v) / 2);
      ctx.beginPath();
      ctx.moveTo(x(a.i), y(a.v));
      ctx.lineTo(x(b.i), y(b.v));
      ctx.lineTo(x(b.i), h - pad.b);
      ctx.lineTo(x(a.i), h - pad.b);
      ctx.closePath();
      ctx.fillStyle = segColor + "2e";
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(x(a.i), y(a.v));
      ctx.lineTo(x(b.i), y(b.v));
      ctx.strokeStyle = segColor;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    drawMark();
    return;
  }
  ctx.beginPath();
  pts.forEach((p, k) => (k === 0 ? ctx.moveTo(x(p.i), y(p.v)) : ctx.lineTo(x(p.i), y(p.v))));
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.lineTo(x(pts[pts.length - 1].i), h - pad.b);
  ctx.lineTo(x(pts[0].i), h - pad.b);
  ctx.closePath();
  const grad = ctx.createLinearGradient(0, pad.t, 0, h - pad.b);
  grad.addColorStop(0, color + "55");
  grad.addColorStop(1, color + "05");
  ctx.fillStyle = grad;
  ctx.fill();
  drawMark();
}

/* ============================================================
   OPEN-METEO — conditions actuelles, prévisions, météo agricole
   ============================================================ */
async function loadOpenMeteo() {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${LAT()}&longitude=${LON()}` +
    `&current=temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,` +
    `wind_speed_10m,wind_gusts_10m,wind_direction_10m,surface_pressure` +
    `&hourly=temperature_2m,precipitation_probability,precipitation,weather_code,` +
    `wind_speed_10m,wind_direction_10m,relative_humidity_2m,` +
    `soil_temperature_0cm,soil_temperature_6cm,soil_moisture_0_to_1cm,soil_moisture_3_to_9cm` +
    `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,` +
    `wind_speed_10m_max,wind_direction_10m_dominant,et0_fao_evapotranspiration,sunrise,sunset,sunshine_duration,daylight_duration` +
    `&timezone=Europe%2FParis&forecast_days=7&past_days=1`;

  // historique 30 j d'humidité du sol (requête séparée, une seule variable)
  const soilUrl =
    `https://api.open-meteo.com/v1/forecast?latitude=${LAT()}&longitude=${LON()}` +
    `&hourly=soil_moisture_3_to_9cm&past_days=30&forecast_days=7&timezone=Europe%2FParis`;

  const [res, soilRes] = await Promise.all([omFetch(url), omFetch(soilUrl)]);
  if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);
  const data = await res.json();
  const soilData = soilRes.ok ? await soilRes.json() : null;

  // past_days=1 ajoute hier en tête des tableaux daily : on recale sur aujourd'hui
  const today = new Date().toLocaleDateString("sv-SE");
  const off = data.daily.time.indexOf(today);
  if (off > 0) for (const k of Object.keys(data.daily)) data.daily[k] = data.daily[k].slice(off);

  renderCurrent(data);
  renderToday(data);
  renderDaily(data);
  renderAgri(data, soilData);
}

/* Conditions actuelles */
function renderCurrent(data) {
  const c = data.current;
  const h = data.hourly;
  const now = new Date(c.time);

  // point de rosée (formule de Magnus)
  const dewPoint = (t, rh) => {
    if (t == null || rh == null) return null;
    const g = Math.log(rh / 100) + (17.62 * t) / (243.12 + t);
    return (243.12 * g) / (17.62 - g);
  };

  // index de l'heure courante + pluie des dernières 24h
  const nowIdx = h.time.findIndex((t) => new Date(t) > now) - 1;
  const rain24 = h.precipitation.slice(Math.max(0, nowIdx - 23), nowIdx + 1).reduce((a, b) => a + (b || 0), 0);

  $("obs-temp").textContent = c.temperature_2m != null ? c.temperature_2m.toFixed(1) : "--";
  $("obs-feels").textContent = fmt(c.apparent_temperature, " °C");
  $("obs-hum").textContent = fmt(c.relative_humidity_2m, " %", 0);
  $("obs-dew").textContent = fmt(dewPoint(c.temperature_2m, c.relative_humidity_2m), " °C");
  $("obs-wind-line").innerHTML =
    `💨 <b>${fmt(c.wind_speed_10m, " km/h", 0)}</b> (raf. ${fmt(c.wind_gusts_10m, "", 0)}) ${windArrow(c.wind_direction_10m)} ${windDirLabel(c.wind_direction_10m)}`;
  $("obs-rain-line").innerHTML =
    `🌧 <b>${fmt(nowIdx >= 0 ? h.precipitation[nowIdx] : null, " mm")}</b> /1h · <b>${fmt(rain24, " mm")}</b> /24h`;
  $("obs-pressure-line").innerHTML = `<b>${fmt(c.surface_pressure, " hPa", 0)}</b>`;

  $("obs-loading").classList.add("hidden");
  $("obs-content").classList.remove("hidden");
}

/* Prévision de la journée (résumé + heures restantes du jour) */
function renderToday(data) {
  const d = data.daily;
  const h = data.hourly;
  const [icon, desc] = wmo(d.weather_code[0]);

  todayForecast = { max: d.temperature_2m_max[0], min: d.temperature_2m_min[0] };
  renderClimo();

  $("today-summary").innerHTML = `
    <span class="big-icon">${icon}</span>
    <span class="sum-desc">${desc}</span>
    <span class="sum-item"><b>${Math.round(d.temperature_2m_max[0])}°</b> / ${Math.round(d.temperature_2m_min[0])}°</span>
    <span class="sum-item">🌧 <b>${d.precipitation_sum[0] > 0 ? d.precipitation_sum[0].toFixed(1) + " mm" : "—"}</b> (${d.precipitation_probability_max[0] ?? 0}%)</span>
    <span class="sum-item">${windArrow(d.wind_direction_10m_dominant[0])} <b>${Math.round(d.wind_speed_10m_max[0])} km/h</b></span>
    <span class="sum-item">${sunSvg(true)} ${new Date(d.sunrise[0]).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}
      · ${sunSvg(false)} ${new Date(d.sunset[0]).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}</span>
    <span class="sum-item" title="Ensoleillement prévu / durée du jour">☀️ <b>${fmtDur(d.sunshine_duration[0])}</b> / ${fmtDur(d.daylight_duration[0])}</span>`;

  // périodes de la journée : matin, midi, aprèm, soir, nuit
  const strip = $("today-strip");
  strip.innerHTML = "";
  const now = new Date();
  const today = now.toLocaleDateString("sv-SE");
  const tomorrow = new Date(now.getTime() + 86400000).toLocaleDateString("sv-SE");

  const periods = [
    ["Matin", today, 6, 12],
    ["Midi", today, 12, 14],
    ["Aprèm", today, 14, 18],
    ["Soir", today, 18, 23],
    ["Nuit", today, 23, 30], // 23h → 6h le lendemain
  ];

  const idxOf = (day, hour) => h.time.indexOf(`${day}T${String(hour % 24).padStart(2, "0")}:00`);

  periods.forEach(([name, day, from, to]) => {
    const idx = [];
    for (let hr = from; hr < to; hr++) {
      const i = idxOf(hr < 24 ? day : tomorrow, hr);
      if (i !== -1) idx.push(i);
    }
    if (!idx.length) return;

    const mid = idx[Math.floor(idx.length / 2)];
    const temps = idx.map((i) => h.temperature_2m[i]);
    const rain = idx.reduce((a, i) => a + (h.precipitation[i] || 0), 0);
    const prob = Math.max(...idx.map((i) => h.precipitation_probability[i] ?? 0));
    const wind = Math.max(...idx.map((i) => h.wind_speed_10m[i]));
    // code météo le plus "marquant" de la période
    const code = Math.max(...idx.map((i) => h.weather_code[i]));
    const [icon] = wmo(code);

    const nowH = now.getHours();
    const isNow = day === today && ((from <= nowH && nowH < Math.min(to, 24)) || (name === "Nuit" && nowH >= 23));

    const card = document.createElement("div");
    card.className = "hour-card period-card" + (isNow ? " now" : "");
    card.innerHTML = `
      <span class="hour-time">${name}</span>
      <span class="hour-icon">${icon}</span>
      <span class="hour-temp">${Math.round(Math.min(...temps))}° / ${Math.round(Math.max(...temps))}°</span>
      <span class="hour-rain">${rain > 0 ? rain.toFixed(1) + " mm" : prob + " %"}</span>
      <span class="hour-wind">${windArrow(h.wind_direction_10m[mid])} ${Math.round(wind)} km/h</span>`;
    strip.appendChild(card);
  });

  $("today-loading").classList.add("hidden");
  $("today-content").classList.remove("hidden");
}

/* carte horaire (réutilisée dans les accordéons) */
function hourCardHTML(h, i, showNow) {
  const dt = new Date(h.time[i]);
  const [icon] = wmo(h.weather_code[i]);
  const isNow = showNow && dt.getHours() === new Date().getHours();
  return `
    <div class="hour-card${isNow ? " now" : ""}">
      <span class="hour-time">${dt.getHours()}h</span>
      <span class="hour-icon">${icon}</span>
      <span class="hour-temp">${Math.round(h.temperature_2m[i])}°</span>
      <span class="hour-rain">${h.precipitation[i] > 0 ? h.precipitation[i].toFixed(1) + " mm" : (h.precipitation_probability[i] ?? 0) + " %"}</span>
      <span class="hour-wind">${windArrow(h.wind_direction_10m[i])} ${Math.round(h.wind_speed_10m[i])} km/h</span>
    </div>`;
}

function renderDaily(data) {
  const d = data.daily;
  const h = data.hourly;
  const grid = $("daily-grid");
  grid.innerHTML = "";
  const now = new Date();

  d.time.forEach((day, i) => {
    const [icon, desc] = wmo(d.weather_code[i]);
    const name = i === 0 ? "Aujourd'hui" : new Date(day).toLocaleDateString("fr-FR", { weekday: "long", day: "numeric" });
    const rowHTML = `
      <span class="day-name">${name}</span>
      <span class="day-icon">${icon}</span>
      <span class="day-desc">${desc}</span>
      <span class="day-temps"><span class="tmax">${Math.round(d.temperature_2m_max[i])}°</span><span class="tmin">${Math.round(d.temperature_2m_min[i])}°</span></span>
      <span class="day-rain">${d.precipitation_sum[i] > 0 ? d.precipitation_sum[i].toFixed(1) + " mm" : "—"} (${d.precipitation_probability_max[i] ?? 0}%)</span>
      <span class="day-sun" title="Ensoleillement prévu">☀️ ${fmtDur(d.sunshine_duration[i])}</span>
      <span class="day-wind">${windArrow(d.wind_direction_10m_dominant[i])} ${Math.round(d.wind_speed_10m_max[i])} km/h</span>`;

    // les 2 premiers jours : accordéon avec le détail horaire
    if (i < 2) {
      const isToday = i === 0;
      const cards = h.time
        .map((t, k) => ({ t, k }))
        .filter(({ t }) => t.startsWith(day) && (!isToday || new Date(t) >= new Date(now.getTime() - 3600 * 1000)))
        .map(({ k }) => hourCardHTML(h, k, isToday))
        .join("");
      const det = document.createElement("details");
      det.className = "day-acc";
      if (isToday) det.open = true;
      det.innerHTML = `
        <summary class="day-row"><span class="day-caret">▸</span>${rowHTML}</summary>
        <div class="hourly-strip acc-strip">${cards}</div>`;
      grid.appendChild(det);
    } else {
      const row = document.createElement("div");
      row.className = "day-row";
      row.innerHTML = `<span class="day-caret"></span>${rowHTML}`;
      grid.appendChild(row);
    }
  });
  $("daily-loading").classList.add("hidden");
  grid.classList.remove("hidden");
}

function renderAgri(data, soilData) {
  const h = data.hourly;
  const d = data.daily;
  const nowIdx = Math.max(0, h.time.findIndex((t) => new Date(t) >= new Date()) - 1);

  const pct = (v) => (v != null ? fmt(v * 100, " %", 0) : "--");
  const soilBadge = (v) => {
    const lvl = soilLevel(v);
    return lvl ? `<span class="soil-badge" style="color:${lvl[1]};border-color:${lvl[1]}" title="${lvl[2]}">${lvl[0]}</span>` : "";
  };

  const c = data.current;
  const rain7j = d.precipitation_sum.slice(0, 7).reduce((a, b) => a + (b || 0), 0);

  $("soil-diagram").innerHTML = `
    <div class="soil-layer sky">
      <span class="soil-depth">Ciel</span>
      <span class="soil-name"></span>
      <span class="soil-vals">
        <span class="soil-val" title="Pluie cumulée sur 7 jours"><span class="ic">🌧️</span><span class="flux down">⇣</span>${fmt(rain7j, " mm")}<span class="soil-depth">&nbsp;pluie 7 j</span></span>
        <span class="soil-val" title="Évapotranspiration (ET0) du jour : eau qui repart vers l'atmosphère"><span class="ic">🌿</span><span class="flux up">⇡</span>${fmt(d.et0_fao_evapotranspiration[0], " mm")}<span class="soil-depth">&nbsp;ET0 auj.</span></span>
      </span>
    </div>
    <div class="soil-layer air">
      <span class="soil-depth">Air 2 m</span>
      <span class="soil-name">🌾 Surface</span>
      <span class="soil-vals">
        <span class="soil-val" title="Température de l'air à 2 m (temps réel)"><span class="ic">🌡️</span>${fmt(c.temperature_2m, " °C")}</span>
        <span class="soil-val" title="Humidité relative de l'air à 2 m (temps réel)"><span class="ic">💧</span>${fmt(c.relative_humidity_2m, " %", 0)}</span>
      </span>
    </div>
    <div class="soil-grass"></div>
    <div class="soil-layer topsoil">
      <span class="soil-depth">0-1 cm</span>
      <span class="soil-name">Surface du sol</span>
      <span class="soil-vals">
        <span class="soil-val" title="Température du sol en surface"><span class="ic">🌡️</span>${fmt(h.soil_temperature_0cm[nowIdx], " °C")}</span>
        <span class="soil-val" title="Humidité volumique du sol (0-1 cm) : part du volume occupée par l'eau"><span class="ic">💧</span>${pct(h.soil_moisture_0_to_1cm[nowIdx])}${soilBadge(h.soil_moisture_0_to_1cm[nowIdx])}</span>
      </span>
    </div>
    <div class="soil-layer subsoil">
      <span class="soil-depth">-6 cm</span>
      <span class="soil-name">Sous-sol</span>
      <span class="soil-vals">
        <span class="soil-val" title="Température du sol à -6 cm"><span class="ic">🌡️</span>${fmt(h.soil_temperature_6cm[nowIdx], " °C")}</span>
        <span class="soil-val" title="Humidité volumique du sol (3-9 cm) : part du volume occupée par l'eau"><span class="ic">💧</span>${pct(h.soil_moisture_3_to_9cm[nowIdx])}<span class="soil-depth">&nbsp;(3-9 cm)</span>${soilBadge(h.soil_moisture_3_to_9cm[nowIdx])}</span>
      </span>
    </div>`;

  $("agri-loading").classList.add("hidden");
  $("agri-content").classList.remove("hidden");

  // historique 30 j + prévision 7 j (sous-échantillonné toutes les 6 h)
  const src = soilData ? soilData.hourly : h;
  const times = src.time.filter((_, i) => i % 6 === 0);
  const labels = times.map((t) => new Date(t).toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" }));
  const soil = src.soil_moisture_3_to_9cm.filter((_, i) => i % 6 === 0).map((v) => (v != null ? v * 100 : null));
  // point le plus proche de maintenant
  const nowMs = Date.now();
  let markIndex = 0;
  times.forEach((t, i) => { if (Math.abs(new Date(t) - nowMs) < Math.abs(new Date(times[markIndex]) - nowMs)) markIndex = i; });
  drawLineChart($("chart-soil"), labels, soil, {
    unit: "%", colorFor: (p) => soilLevel(p / 100)[1], markIndex,
    tipFor: (i) => {
      if (soil[i] == null) return null;
      const lvl = soilLevel(soil[i] / 100);
      const dt = new Date(times[i]);
      return `<b>${soil[i].toFixed(1)} %</b> <span style="color:${lvl[1]}">${lvl[0]}</span>` +
        `<br><span class="tip-sub">${dt.toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short" })} ${dt.getHours()}h</span>`;
    },
  });
}

/* ============================================================
   Records & normales climatiques (archive ERA5 1940 → hier)
   Calculés pour la date du jour, mis en cache 24 h en localStorage
   ============================================================ */
let climoStats = null;
let todayForecast = null; // { max, min } rempli par renderToday

/* écart aux normales, façon Météo-France */
const diffBadge = (val, norm) => {
  if (val == null || norm == null) return "";
  const diff = val - norm;
  const txt = `${diff >= 0 ? "+" : "−"}${Math.abs(diff).toFixed(1).replace(/\.0$/, "")}°`;
  let color, label;
  if (diff >= 4) { color = "#e57373"; label = "bien au-dessus des normales"; }
  else if (diff >= 1.5) { color = "#ffb74d"; label = "au-dessus des normales"; }
  else if (diff > -1.5) { color = "#81c784"; label = "conforme aux normales"; }
  else if (diff > -4) { color = "#4fc3f7"; label = "en dessous des normales"; }
  else { color = "#9575cd"; label = "bien en dessous des normales"; }
  return `<span class="diff-badge" style="color:${color};border-color:${color}" title="${label}">${txt}</span>`;
};

function renderClimo() {
  if (!climoStats || !todayForecast) return;
  const s = climoStats;
  const monthLabel = new Date().toLocaleDateString("fr-FR", { month: "long" });

  $("climo").innerHTML = `
    <div class="climo-head" title="Réanalyse ERA5 (1940 → hier), point de grille le plus proche de ${city().name} — normales 1991-2020">
      Comparaison aux normales <span class="climo-sub">1991-2020</span>
    </div>
    <div class="climo-rows">
      <div class="climo-row">
        <span class="climo-label">Min prévue</span>
        <span class="climo-val">${fmt(todayForecast.min, "°", 0)}</span>
        <span class="climo-norm">normale ${fmt(s.normMin, "°")}</span>
        ${diffBadge(todayForecast.min, s.normMin)}
      </div>
      <div class="climo-row">
        <span class="climo-label">Max prévue</span>
        <span class="climo-val">${fmt(todayForecast.max, "°", 0)}</span>
        <span class="climo-norm">normale ${fmt(s.normMax, "°")}</span>
        ${diffBadge(todayForecast.max, s.normMax)}
      </div>
    </div>
    <div class="climo-records">
      Records ${monthLabel} : <b class="rec-hot">${fmt(s.recHot.v, "°")}</b> <i>(${s.recHot.y})</i>
      · <b class="rec-cold">${fmt(s.recCold.v, "°")}</b> <i>(${s.recCold.y})</i>
    </div>`;
  $("climo").classList.remove("hidden");
}

async function loadClimo() {
  const today = new Date().toLocaleDateString("sv-SE");
  const cacheKey = `climo7-${LAT()},${LON()}-${today}`;

  let stats = null;
  try { stats = JSON.parse(localStorage.getItem(cacheKey)); } catch {}

  if (!stats) {
    const yesterday = new Date(Date.now() - 86400000).toLocaleDateString("sv-SE");
    const url =
      `https://archive-api.open-meteo.com/v1/archive?latitude=${LAT()}&longitude=${LON()}` +
      `&start_date=1940-01-01&end_date=${yesterday}` +
      `&daily=temperature_2m_max,temperature_2m_min,precipitation_sum&timezone=Europe%2FParis`;
    const res = await omFetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`); // géré par le catch de l'appelant
    const d = (await res.json()).daily;

    const mmdd = today.slice(5);
    const curYear = +today.slice(0, 4);
    let nTmax = 0, nTmin = 0, nCount = 0;

    // agrégats par mois : moyennes par année, records journaliers, stats par jour du mois
    const M = {};
    for (let m = 1; m <= 12; m++) M[m] = { byYear: {}, daysHot: [], daysCold: [], daysAmp: [], perDay: {} };

    // agrégats par semaine de l'année (52 semaines, pour la vue "Année")
    const DOY = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
    const weekIdx = (mon, day) => Math.min(51, Math.floor((DOY[mon - 1] + day - 1) / 7));
    const W = Array.from({ length: 52 }, () => ({ recMax: null, recMin: null, sx: 0, sn: 0, sp: 0, n: 0 }));

    d.time.forEach((t, i) => {
      const year = +t.slice(0, 4);
      const mon = +t.slice(5, 7);
      const tmax = d.temperature_2m_max[i], tmin = d.temperature_2m_min[i];
      if (tmax != null && tmin != null) {
        const mo = M[mon];
        const y = mo.byYear[year] || (mo.byYear[year] = { sx: 0, sn: 0, sr: 0, n: 0 });
        y.sx += tmax; y.sn += tmin; y.sr += d.precipitation_sum[i] || 0; y.n++;
        mo.daysHot.push({ v: tmax, d: t });
        mo.daysCold.push({ v: tmin, d: t });
        mo.daysAmp.push({ v: tmax - tmin, d: t });
        // stats par jour du mois (records toutes années, moyennes 1991-2020)
        const dd = t.slice(8);
        const pd = mo.perDay[dd] || (mo.perDay[dd] = { recMax: null, recMin: null, sx: 0, sn: 0, sp: 0, n: 0 });
        if (!pd.recMax || tmax > pd.recMax.v) pd.recMax = { v: tmax, y: year };
        if (!pd.recMin || tmin < pd.recMin.v) pd.recMin = { v: tmin, y: year };
        if (year >= 1991 && year <= 2020) { pd.sx += tmax; pd.sn += tmin; pd.sp += d.precipitation_sum[i] || 0; pd.n++; }
        // stats par semaine de l'année
        const wk = W[weekIdx(mon, +dd)];
        if (!wk.recMax || tmax > wk.recMax.v) wk.recMax = { v: tmax, y: year };
        if (!wk.recMin || tmin < wk.recMin.v) wk.recMin = { v: tmin, y: year };
        if (year >= 1991 && year <= 2020) { wk.sx += tmax; wk.sn += tmin; wk.sp += d.precipitation_sum[i] || 0; wk.n++; }
      }
      // normales 1991-2020 pour la date du jour
      if (t.slice(5) === mmdd && year >= 1991 && year <= 2020 && tmax != null && tmin != null) {
        nTmax += tmax; nTmin += tmin; nCount++;
      }
    });

    const months = {};
    for (let m = 1; m <= 12; m++) {
      const mo = M[m];
      if (!mo.daysHot.length) continue;
      // années complètes uniquement pour les moyennes/cumuls mensuels
      const years = Object.entries(mo.byYear)
        .filter(([y, v]) => +y !== curYear && v.n >= 28)
        .map(([y, v]) => ({ y: +y, txm: v.sx / v.n, tnm: v.sn / v.n, tm: (v.sx + v.sn) / (2 * v.n), rr: v.sr }));
      const topY = (key, dir, n = 5) =>
        [...years].sort((a, b) => (dir === "desc" ? b[key] - a[key] : a[key] - b[key]))
          .slice(0, n).map((e) => ({ v: e[key], y: e.y }));
      const topD = (arr, dir, n = 5) =>
        [...arr].sort((a, b) => (dir === "desc" ? b.v - a.v : a.v - b.v)).slice(0, n);

      months[m] = {
        txmHot: topY("txm", "desc"), txmCold: topY("txm", "asc"),
        tnmCold: topY("tnm", "asc"), tnmHot: topY("tnm", "desc"),
        tmHot: topY("tm", "desc"), tmCold: topY("tm", "asc"),
        rrMax: topY("rr", "desc"),
        dayHot: topD(mo.daysHot, "desc"), dayCold: topD(mo.daysCold, "asc"), dayAmp: topD(mo.daysAmp, "desc"),
        days: Object.keys(mo.perDay).sort().map((dd) => {
          const p = mo.perDay[dd];
          return {
            d: +dd, recMax: p.recMax.v, recMaxY: p.recMax.y, recMin: p.recMin.v, recMinY: p.recMin.y,
            meanMax: p.n ? p.sx / p.n : null, meanMin: p.n ? p.sn / p.n : null,
            meanRain: p.n ? p.sp / p.n : null,
          };
        }),
      };
    }

    const curMonth = months[+today.slice(5, 7)];
    if (!curMonth) return;

    stats = {
      recHot: { v: curMonth.dayHot[0].v, y: +curMonth.dayHot[0].d.slice(0, 4) },
      recCold: { v: curMonth.dayCold[0].v, y: +curMonth.dayCold[0].d.slice(0, 4) },
      normMax: nCount ? nTmax / nCount : null,
      normMin: nCount ? nTmin / nCount : null,
      months,
      weeks: W.map((wk, wi) => ({
        d: wi + 1,
        recMax: wk.recMax ? wk.recMax.v : null, recMaxY: wk.recMax ? wk.recMax.y : null,
        recMin: wk.recMin ? wk.recMin.v : null, recMinY: wk.recMin ? wk.recMin.y : null,
        meanMax: wk.n ? wk.sx / wk.n : null, meanMin: wk.n ? wk.sn / wk.n : null,
        meanRain: wk.n ? (wk.sp / wk.n) * 7 : null, // cumul hebdo moyen
      })),
    };
    // on ne garde que les caches du jour (toutes villes) au format courant
    Object.keys(localStorage).filter((k) => k.startsWith("climo") && (!k.startsWith("climo7") || !k.endsWith(today))).forEach((k) => localStorage.removeItem(k));
    try { localStorage.setItem(cacheKey, JSON.stringify(stats)); } catch {}
  }

  climoStats = stats;
  renderClimo();
  renderClimoMonth(climoMonth);
}

/* ---------- Climatologie du mois (façon Infoclimat) ---------- */
let climoMonth = new Date().getMonth() + 1; // mois affiché (1-12)
let climoView = "month"; // "month" (par jour) ou "year" (par semaine)
let climoYear = "all"; // "all" ou année (nombre)
let climoYearB = "none"; // comparaison superposée : "none", "norm" (moyennes 1991-2020) ou année
let climoRenderTok = 0; // jeton anti-course pour les rendus asynchrones
let showRain = true; // histogramme pluviométrie
let showRecords = true; // courbes des records
let showRecYears = true; // années des records sur le graphe
const yearDailyCache = {}; // données journalières d'une année : clé "lat,lon-année"

/* données journalières (tmax/tmin/pluie) d'une année pour la ville active
   — cache mémoire + localStorage pour les années terminées (immuables) */
async function loadYearDaily(year) {
  const key = `${LAT()},${LON()}-${year}`;
  if (yearDailyCache[key]) return yearDailyCache[key];
  const lsKey = `omyear-${key}`;
  const finished = year < new Date().getFullYear();
  if (finished) {
    try {
      const cached = JSON.parse(localStorage.getItem(lsKey));
      if (cached) { yearDailyCache[key] = cached; return cached; }
    } catch {}
  }
  const yesterday = new Date(Date.now() - 86400000).toLocaleDateString("sv-SE");
  const end = `${year}-12-31` < yesterday ? `${year}-12-31` : yesterday;
  const url =
    `https://archive-api.open-meteo.com/v1/archive?latitude=${LAT()}&longitude=${LON()}` +
    `&start_date=${year}-01-01&end_date=${end}` +
    `&daily=temperature_2m_max,temperature_2m_min,precipitation_sum&timezone=Europe%2FParis`;
  const res = await omFetch(url);
  if (!res.ok) throw new Error(`Archive HTTP ${res.status}`);
  const daily = (await res.json()).daily;
  yearDailyCache[key] = daily;
  if (finished) {
    try {
      localStorage.setItem(lsKey, JSON.stringify(daily));
    } catch {
      // quota plein : on purge les années cachées et on réessaie une fois
      Object.keys(localStorage).filter((k) => k.startsWith("omyear-")).forEach((k) => localStorage.removeItem(k));
      try { localStorage.setItem(lsKey, JSON.stringify(daily)); } catch {}
    }
  }
  return daily;
}

/* lance le chargement de l'archive climatique avec message + bouton réessayer en cas d'échec */
function startClimo() {
  const loading = $("climo-month-loading");
  loading.textContent = "Chargement de l'archive climatique…";
  loading.classList.remove("hidden");
  loadClimo().catch((e) => {
    loading.innerHTML = `Archive climatique indisponible (${e.message}). ` +
      `<button type="button" class="climo-toggle" id="climo-retry">Réessayer</button>`;
    $("climo-retry").addEventListener("click", startClimo);
  });
}

async function renderClimoMonth(monthNum) {
  if (!climoStats || !climoStats.months || !climoStats.months[monthNum]) return;
  const m = climoStats.months[monthNum];
  const monthLabel = new Date(2000, monthNum - 1, 1).toLocaleDateString("fr-FR", { month: "long" });
  $("climo-month-name").textContent = monthLabel;
  $("climo-month-title").innerHTML =
    `Climatologie à ${city().name} <span class="src">ERA5 1940 → hier · années complètes pour les moyennes</span>`;

  $("climo-month-loading").classList.add("hidden");
  $("climo-month-content").classList.remove("hidden");
  if (!m.days) return;
  const tok = ++climoRenderTok;
  const isYear = climoView === "year";
  if (isYear && !climoStats.weeks) return;

  const DOY = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  const weekIdx = (mon, day) => Math.min(51, Math.floor((DOY[mon - 1] + day - 1) / 7));
  const shortDate = (dt) => dt.toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
  const weekStart = (wk) => new Date(2001, 0, 1 + (wk - 1) * 7);

  // extrait les jours du mois d'une année spécifique
  const monthOfYear = async (year) => {
    const dd = await loadYearDaily(year);
    const byDay = {};
    dd.time.forEach((t, i) => {
      if (+t.slice(5, 7) === monthNum)
        byDay[+t.slice(8)] = { tmax: dd.temperature_2m_max[i], tmin: dd.temperature_2m_min[i], rain: dd.precipitation_sum[i] };
    });
    return byDay;
  };
  // agrège une année en 52 semaines (tmax/tmin moyens, pluie cumulée)
  const weeksOfYear = async (year) => {
    const dd = await loadYearDaily(year);
    const agg = Array.from({ length: 52 }, () => ({ sx: 0, sn: 0, sr: 0, n: 0 }));
    dd.time.forEach((t, i) => {
      const tmax = dd.temperature_2m_max[i], tmin = dd.temperature_2m_min[i];
      if (tmax == null || tmin == null) return;
      const a = agg[weekIdx(+t.slice(5, 7), +t.slice(8))];
      a.sx += tmax; a.sn += tmin; a.sr += dd.precipitation_sum[i] || 0; a.n++;
    });
    const byWeek = {};
    agg.forEach((a, wi) => {
      // semaine suffisamment complète uniquement (évite les artefacts en fin d'année en cours)
      if (a.n >= 4) byWeek[wi + 1] = { tmax: a.sx / a.n, tmin: a.sn / a.n, rain: a.sr };
    });
    return byWeek;
  };
  const ofYear = isYear ? weeksOfYear : monthOfYear;
  const base = isYear ? climoStats.weeks : m.days;

  // graphique : toutes les années (records + moyennes) ou une année spécifique
  let daysDraw;
  let yearMode = null;
  if (climoYear !== "all") {
    try {
      const byKey = await ofYear(+climoYear);
      daysDraw = base.map((p) => ({
        ...p,
        valMax: byKey[p.d] ? byKey[p.d].tmax : null,
        valMin: byKey[p.d] ? byKey[p.d].tmin : null,
        rain: byKey[p.d] ? byKey[p.d].rain : null,
      }));
      yearMode = +climoYear;
    } catch (e) {
      $("climo-chart-title").textContent = `Année ${climoYear} indisponible : ${e.message}`;
      return;
    }
  } else {
    daysDraw = base.map((p) => ({ ...p, valMax: p.meanMax, valMin: p.meanMin, rain: p.meanRain }));
  }

  // comparaison superposée : moyennes 1991-2020 ou une année spécifique
  let cmpYear = null;
  const cmpNorm = climoYearB === "norm";
  if (cmpNorm && yearMode) {
    // superpose les normales 1991-2020 sous l'année affichée
    daysDraw = daysDraw.map((p) => ({ ...p, cmpMax: p.meanMax, cmpMin: p.meanMin, cmpRain: p.meanRain }));
    cmpYear = "normales 1991-2020";
  } else if (!cmpNorm && climoYearB !== "none") {
    try {
      const byKeyB = await ofYear(+climoYearB);
      daysDraw = daysDraw.map((p) => ({
        ...p,
        cmpMax: byKeyB[p.d] ? byKeyB[p.d].tmax : null,
        cmpMin: byKeyB[p.d] ? byKeyB[p.d].tmin : null,
        cmpRain: byKeyB[p.d] ? byKeyB[p.d].rain : null,
      }));
      cmpYear = +climoYearB;
    } catch (e) {
      $("climo-chart-title").textContent = `Année ${climoYearB} indisponible : ${e.message}`;
      return;
    }
  }
  // vérifie que la sélection n'a pas changé pendant les fetchs
  if (tok !== climoRenderTok || monthNum !== climoMonth || isYear !== (climoView === "year")) return;

  // labels d'axe et de tooltip
  if (isYear) {
    let prevMon = -1;
    daysDraw = daysDraw.map((p) => {
      const start = weekStart(p.d);
      const end = new Date(start.getTime() + 6 * 86400000);
      const mon = start.getMonth();
      const lbl = mon !== prevMon ? start.toLocaleDateString("fr-FR", { month: "short" }) : "";
      prevMon = mon;
      return { ...p, lbl, hl: `S${p.d}`, tip: `Sem. ${p.d} · ${shortDate(start)} – ${shortDate(end)}` };
    });
  } else {
    daysDraw = daysDraw.map((p) => ({ ...p, lbl: String(p.d), hl: String(p.d), tip: `${p.d} ${monthLabel}` }));
  }

  const baseLbl = yearMode ? String(yearMode) : "moyennes 1991-2020";
  const periodTxt = isYear ? "sur l'année" : `en ${monthLabel}`;
  const granTxt = isYear ? "par semaine" : "par jour du mois";
  $("climo-chart-title").textContent = cmpYear
    ? `Comparaison ${baseLbl} vs ${cmpYear} ${periodTxt} (${granTxt})`
    : yearMode
      ? `Températures et pluviométrie ${periodTxt} ${yearMode} (${granTxt})`
      : `Records, moyennes et pluviométrie ${periodTxt} (${granTxt})`;

  // phrase de synthèse en mode comparaison
  const summary = $("climo-compare-summary");
  summary.classList.add("hidden");
  if (cmpYear) {
    const pairsT = daysDraw.filter((p) => p.valMax != null && p.cmpMax != null && p.valMin != null && p.cmpMin != null);
    const pairsR = daysDraw.filter((p) => p.rain != null && p.cmpRain != null);
    if (pairsT.length >= 5) {
      const avg = (arr, f) => arr.reduce((a, p) => a + f(p), 0) / arr.length;
      const dMax = avg(pairsT, (p) => p.valMax - p.cmpMax);
      const dMin = avg(pairsT, (p) => p.valMin - p.cmpMin);
      const dT = (dMax + dMin) / 2;
      const dR = pairsR.reduce((a, p) => a + (p.rain - p.cmpRain), 0);

      const subjA = isYear
        ? (yearMode ? `En ${yearMode}` : `Sur l'année (normales 1991-2020)`)
        : (yearMode ? `En ${monthLabel} ${yearMode}` : `En ${monthLabel} (normales 1991-2020)`);
      const refB = cmpNorm ? "que les normales 1991-2020" : `qu'en ${cmpYear}`;
      const sign = (v) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(1)}°`;
      const detT = `(${sign(dMin)} min / ${sign(dMax)} max)`;

      let tPhrase;
      if (dT >= 4) tPhrase = `il a fait <b>bien plus chaud</b> ${refB} ${detT}`;
      else if (dT >= 1.5) tPhrase = `il a fait <b>plus chaud</b> ${refB} ${detT}`;
      else if (dT > 0.5) tPhrase = `il a fait <b>légèrement plus chaud</b> ${refB} ${detT}`;
      else if (dT > -0.5) tPhrase = `les températures ont été <b>globalement équivalentes</b> ${cmpNorm ? "aux normales" : `à ${cmpYear}`} ${detT}`;
      else if (dT > -1.5) tPhrase = `il a fait <b>légèrement plus frais</b> ${refB} ${detT}`;
      else if (dT > -4) tPhrase = `il a fait <b>plus frais</b> ${refB} ${detT}`;
      else tPhrase = `il a fait <b>bien plus froid</b> ${refB} ${detT}`;

      let rPhrase = "";
      if (pairsR.length >= 5) {
        const eqT = isYear ? 30 : 5, bigT = isYear ? 150 : 30;
        const mm = Math.abs(dR).toFixed(0);
        if (Math.abs(dR) < eqT) rPhrase = `, avec une <b>pluviométrie comparable</b> (écart de ${mm} mm)`;
        else if (dR < 0) rPhrase = `, ainsi que <b>${Math.abs(dR) >= bigT ? "bien plus sec" : "plus sec"}</b> (${mm} mm de pluie en moins)`;
        else rPhrase = `, ainsi que <b>${dR >= bigT ? "bien plus arrosé" : "plus arrosé"}</b> (${mm} mm de pluie en plus)`;
      }
      summary.innerHTML = `${subjA}, ${tPhrase}${rPhrase}.`;
      summary.classList.remove("hidden");
    }
  }
  $("climo-chart-legend").innerHTML =
    (showRecords ? `<span><i style="background:#e040fb"></i>Extrêmes maximales (année)</span>` : "") +
    (cmpYear
      ? `<span><i style="background:#ffa726"></i>${yearMode ? yearMode : "Moyennes 1991-2020"} (max/min)</span>
         <span><i style="background:#b388ff"></i>${cmpYear} (max/min)</span>`
      : `<span><i style="background:#e53935"></i>${yearMode ? `Maximales ${yearMode}` : "Moyenne des maximales 1991-2020"}</span>
         <span><i style="background:#1e88e5"></i>${yearMode ? `Minimales ${yearMode}` : "Moyenne des minimales 1991-2020"}</span>`) +
    (showRecords ? `<span><i style="background:#4fc3f7"></i>Extrêmes minimales (année)</span>` : "") +
    (showRain
      ? (cmpYear
        ? `<span><i style="background:#ffa726"></i>Pluie ${yearMode ? yearMode : "moy. 1991-2020"} (mm)</span>
           <span><i style="background:#b388ff"></i>Pluie ${cmpYear} (mm)</span>`
        : `<span><i style="background:#64b5f6"></i>${yearMode ? `Pluie ${yearMode} (mm)` : "Pluie moyenne 1991-2020 (mm)"}</span>`)
      : "");
  drawClimoChart($("chart-climo"), daysDraw, monthLabel, yearMode, cmpYear);
}

/* Graphe records/moyennes + pluie par jour du mois (façon Infoclimat) */
function drawClimoChart(canvas, days, monthLabel, yearMode = null, cmpYear = null) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || canvas.parentElement.clientWidth;

  const pad = { l: 34, r: showRain ? 40 : 10, t: 30, b: 22 };
  const all = days.flatMap((p) =>
    (showRecords ? [p.recMax, p.recMin] : []).concat([p.valMax, p.valMin], cmpYear ? [p.cmpMax, p.cmpMin] : [])
  ).filter((v) => v != null);
  const min = Math.floor((Math.min(...all) - 3) / 5) * 5;
  const max = Math.ceil((Math.max(...all) + 3) / 5) * 5;
  // hauteur proportionnelle à l'amplitude : espacement constant entre les degrés d'un mois à l'autre
  const PX_PER_DEG = 5.5;
  const h = Math.round((max - min) * PX_PER_DEG + pad.t + pad.b);

  const x = (i) => pad.l + (i / (days.length - 1)) * (w - pad.l - pad.r);
  const y = (v) => pad.t + (1 - (v - min) / (max - min)) * (h - pad.t - pad.b);

  // échelle pluie (axe de droite, mm)
  const rains = days.flatMap((p) => cmpYear ? [p.rain, p.cmpRain] : [p.rain]).filter((v) => v != null);
  const rainMax = Math.max(5, Math.ceil(Math.max(0, ...rains) / 5) * 5);
  const yr = (v) => pad.t + (1 - v / rainMax) * (h - pad.t - pad.b);

  const monthLbl = monthLabel;
  // en mode comparaison : une seule couleur par année (A orange, B violet)
  const colValMax = cmpYear ? "#ffa726" : "#e53935";
  const colValMin = cmpYear ? "#ffa726" : "#1e88e5";
  const colCmp = "#b388ff";
  const colRainA = cmpYear ? "rgba(255,167,38,.4)" : "rgba(100,181,246,.45)";
  const colRainB = "rgba(179,136,255,.45)";
  const maxLbl = yearMode ? `Max ${yearMode}` : "Moy. max";
  const minLbl = yearMode ? `Min ${yearMode}` : "Moy. min";
  const rainLbl = yearMode ? `Pluie ${yearMode}` : "Pluie moy.";
  // libellé court pour l'infobulle (comparaison année ou normales)
  const cmpShort = typeof cmpYear === "string" ? "moy. 91-20" : cmpYear;
  attachChartTip(canvas, {
    padL: pad.l, padR: pad.r, count: days.length,
    onHover: (i) => paint(i),
    html: (i) => {
      const p = days[i];
      return `<b>${p.tip || `${p.d} ${monthLbl}`}</b>` +
        (showRecords ? `<br><span style="color:#e040fb">Record max</span> <b>${p.recMax.toFixed(1)}°</b> <span class="tip-sub">(${p.recMaxY})</span>` : "") +
        `<br><span style="color:${colValMax}">${maxLbl}</span> <b>${p.valMax != null ? p.valMax.toFixed(1) : "--"}°</b>` +
        (cmpYear ? `<br><span style="color:${colCmp}">Max ${cmpShort}</span> <b>${p.cmpMax != null ? p.cmpMax.toFixed(1) : "--"}°</b>` : "") +
        `<br><span style="color:${colValMin}">${minLbl}</span> <b>${p.valMin != null ? p.valMin.toFixed(1) : "--"}°</b>` +
        (cmpYear ? `<br><span style="color:${colCmp}">Min ${cmpShort}</span> <b>${p.cmpMin != null ? p.cmpMin.toFixed(1) : "--"}°</b>` : "") +
        (showRecords ? `<br><span style="color:#4fc3f7">Record min</span> <b>${p.recMin.toFixed(1)}°</b> <span class="tip-sub">(${p.recMinY})</span>` : "") +
        (showRain ? `<br><span style="color:${cmpYear ? "#ffa726" : "#64b5f6"}">${rainLbl}</span> <b>${p.rain != null ? p.rain.toFixed(1) : "--"} mm</b>` : "") +
        (showRain && cmpYear ? `<br><span style="color:${colCmp}">Pluie ${cmpShort}</span> <b>${p.cmpRain != null ? p.cmpRain.toFixed(1) : "--"} mm</b>` : "");
    },
  });

  const paint = (hoverI = null) => {
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.height = h + "px";
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);

  // bande de survol (jour pointé)
  const slotW = (w - pad.l - pad.r) / (days.length - 1);
  if (hoverI != null) {
    ctx.fillStyle = "rgba(255,255,255,.07)";
    ctx.fillRect(x(hoverI) - slotW / 2, pad.t, slotW, h - pad.t - pad.b);
  }

  // grille + axe Y températures (gauche)
  ctx.font = "10px sans-serif";
  ctx.fillStyle = "#8fa1bb";
  for (let v = min; v <= max; v += 5) {
    ctx.strokeStyle = "rgba(255,255,255,.07)";
    ctx.beginPath(); ctx.moveTo(pad.l, y(v)); ctx.lineTo(w - pad.r, y(v)); ctx.stroke();
    ctx.textAlign = "right";
    ctx.fillText(v + "°", pad.l - 5, y(v) + 3);
  }
  // axe Y pluie (droite, mm)
  if (showRain) {
    ctx.textAlign = "left";
    ctx.fillStyle = "#64b5f6";
    for (const v of [0, rainMax / 2, rainMax]) {
      ctx.fillText(v.toFixed(0) + " mm", w - pad.r + 5, yr(v) + 3);
    }
  }
  // axe X (élément survolé mis en évidence)
  ctx.textAlign = "center";
  const sparse = days.length > 40; // vue année : labels déjà espacés (débuts de mois)
  const stepX = sparse ? 1 : (w < 560 ? 2 : 1);
  days.forEach((p, i) => {
    const lbl = p.lbl != null ? p.lbl : String(p.d);
    if (i === hoverI) {
      ctx.font = "bold 11px sans-serif";
      ctx.fillStyle = "#e8eef7";
      ctx.fillText(p.hl != null ? p.hl : lbl, x(i), h - 6);
      ctx.font = "10px sans-serif";
      ctx.fillStyle = "#8fa1bb";
    } else if (lbl && i % stepX === 0) {
      ctx.fillStyle = "#8fa1bb";
      ctx.fillText(lbl, x(i), h - 6);
    }
  });

  // histogramme pluie (derrière les courbes) — barres côte à côte en mode comparaison
  if (showRain) {
    const slot = (w - pad.l - pad.r) / days.length;
    const barW = Math.max(2, slot * (cmpYear ? 0.3 : 0.55));
    const drawBars = (key, color, offset) => {
      ctx.fillStyle = color;
      days.forEach((p, i) => {
        if (p[key] == null || p[key] <= 0) return;
        ctx.fillRect(x(i) + offset, yr(p[key]), barW, h - pad.b - yr(p[key]));
      });
    };
    if (cmpYear) {
      drawBars("rain", colRainA, -barW);
      drawBars("cmpRain", colRainB, 0);
    } else {
      drawBars("rain", colRainA, -barW / 2);
    }
  }

  /* aire entre deux courbes (min/max d'une même année), en segments contigus */
  const band = (keyTop, keyBot, color) => {
    let seg = [];
    const flush = () => {
      if (seg.length > 1) {
        ctx.beginPath();
        seg.forEach(({ i, top }, k) => (k === 0 ? ctx.moveTo(x(i), y(top)) : ctx.lineTo(x(i), y(top))));
        [...seg].reverse().forEach(({ i, bot }) => ctx.lineTo(x(i), y(bot)));
        ctx.closePath();
        ctx.fillStyle = color;
        ctx.fill();
      }
      seg = [];
    };
    days.forEach((p, i) => {
      if (p[keyTop] == null || p[keyBot] == null) return flush();
      seg.push({ i, top: p[keyTop], bot: p[keyBot] });
    });
    flush();
  };

  const line = (key, color, width = 2, dash = []) => {
    ctx.beginPath();
    ctx.setLineDash(dash);
    let started = false;
    days.forEach((p, i) => {
      if (p[key] == null) { started = false; return; }
      if (!started) { ctx.moveTo(x(i), y(p[key])); started = true; }
      else ctx.lineTo(x(i), y(p[key]));
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.stroke();
    ctx.setLineDash([]);
  };
  const dots = (key, color, r = 2.5) => {
    ctx.fillStyle = color;
    days.forEach((p, i) => {
      if (p[key] == null) return;
      ctx.beginPath(); ctx.arc(x(i), y(p[key]), r, 0, Math.PI * 2); ctx.fill();
    });
  };
  // années des records (rotées, une sur N pour la lisibilité)
  const yearLabels = (vKey, yKey, above) => {
    const rstep = days.length > 40 ? 3 : stepX;
    ctx.fillStyle = "#8fa1bb";
    days.forEach((p, i) => {
      if (i % rstep !== 0 || p[vKey] == null) return;
      ctx.save();
      ctx.translate(x(i), y(p[vKey]) + (above ? -7 : 7));
      ctx.rotate(-Math.PI / 3);
      ctx.textAlign = above ? "left" : "right";
      ctx.fillText(p[yKey], 0, 3);
      ctx.restore();
    });
  };

  if (showRecords) {
    line("recMax", "#e040fb", 1.5, [4, 3]); dots("recMax", "#e040fb");
    line("recMin", "#4fc3f7", 1.5, [4, 3]); dots("recMin", "#4fc3f7");
  }
  // aires min-max par année en mode comparaison (sous les courbes)
  if (cmpYear) {
    band("valMax", "valMin", "rgba(255,167,38,.28)");
    band("cmpMax", "cmpMin", "rgba(179,136,255,.28)");
  }
  line("valMax", colValMax, 2.5); dots("valMax", colValMax, 3);
  line("valMin", colValMin, 2.5); dots("valMin", colValMin, 3);
  if (cmpYear) {
    line("cmpMax", colCmp, 2); dots("cmpMax", colCmp, 2.5);
    line("cmpMin", colCmp, 2); dots("cmpMin", colCmp, 2.5);
  }
  if (showRecords && showRecYears) {
    yearLabels("recMax", "recMaxY", true);
    yearLabels("recMin", "recMinY", false);
  }
  }; // fin paint

  paint();
}

/* ============================================================
   Onglets de villes
   ============================================================ */
/* affiche la page d'accueil si aucune ville, sinon le dashboard */
function updateView() {
  const hasCity = cities.length > 0;
  $("city-welcome").classList.toggle("hidden", hasCity);
  $("city-bar").classList.toggle("hidden", !hasCity);
  $("dashboard").classList.toggle("hidden", !hasCity);
  if (!hasCity) {
    document.title = "Météo — Dashboard";
    $("welcome-input").focus();
  }
}

function renderCityTabs() {
  const bar = $("city-tabs");
  bar.innerHTML = "";
  cities.forEach((c, i) => {
    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = "city-tab" + (i === activeCityIdx ? " active" : "");
    tab.innerHTML = `<span class="city-tab-name">${c.name}</span>` +
      `<span class="city-tab-close" title="Retirer ${c.name}">×</span>`;
    tab.addEventListener("click", (e) => {
      if (e.target.classList.contains("city-tab-close")) {
        const wasActive = i === activeCityIdx;
        cities.splice(i, 1);
        if (i < activeCityIdx) activeCityIdx--;
        activeCityIdx = Math.max(0, Math.min(activeCityIdx, cities.length - 1));
        saveCities();
        if (!cities.length) return updateView();
        if (wasActive) switchCity(activeCityIdx);
        else renderCityTabs();
        return;
      }
      if (i !== activeCityIdx) switchCity(i);
    });
    bar.appendChild(tab);
  });
  document.title = `Météo ${city().name} — Dashboard`;
}

function switchCity(i) {
  activeCityIdx = i;
  saveCities();
  updateView();
  renderCityTabs();
  // reset UI en état "chargement"
  climoStats = null;
  todayForecast = null;
  ["obs-content", "today-content", "agri-content", "climo-month-content"].forEach((id) => $(id).classList.add("hidden"));
  $("climo").classList.add("hidden");
  ["obs-loading", "today-loading", "daily-loading", "agri-loading", "climo-month-loading"].forEach((id) => {
    $(id).textContent = "Chargement…";
    $(id).classList.remove("hidden");
  });
  $("daily-grid").classList.add("hidden");
  refreshAll();
  startClimo();
}

/* géocodage Open-Meteo */
async function searchCities(name, count = 6) {
  const res = await omFetch(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=${count}&language=fr&format=json`
  );
  if (!res.ok) throw new Error(`Géocodage HTTP ${res.status}`);
  return (await res.json()).results || [];
}

function addCityObj(r) {
  const cityObj = { name: r.name, lat: r.latitude, lon: r.longitude };
  const existing = cities.findIndex((c) => c.lat === cityObj.lat && c.lon === cityObj.lon);
  if (existing !== -1) return switchCity(existing);
  cities.push(cityObj);
  switchCity(cities.length - 1);
}

async function addCity(name) {
  const results = await searchCities(name, 1);
  if (!results.length) throw new Error("Ville introuvable");
  addCityObj(results[0]);
}

/* ---------- Autocomplétion ---------- */
function attachCityAutocomplete(inputId, onError) {
  const input = $(inputId);
  const box = document.createElement("div");
  box.className = "city-suggest hidden";
  input.parentElement.style.position = "relative";
  input.parentElement.appendChild(box);

  let items = [];
  let sel = -1;
  let timer = null;
  let reqId = 0;

  const close = () => { box.classList.add("hidden"); box.innerHTML = ""; items = []; sel = -1; };

  const render = () => {
    box.innerHTML = items.map((r, i) => {
      const sub = [r.admin1, r.country].filter(Boolean).join(", ");
      return `<div class="city-suggest-item${i === sel ? " sel" : ""}" data-i="${i}">
        <span class="city-suggest-name">${r.name}</span>
        ${sub ? `<span class="city-suggest-sub">${sub}</span>` : ""}
      </div>`;
    }).join("");
    box.classList.toggle("hidden", !items.length);
  };

  const pick = (i) => {
    if (i < 0 || i >= items.length) return;
    const r = items[i];
    close();
    input.value = "";
    onError("");
    addCityObj(r);
  };

  input.addEventListener("input", () => {
    onError("");
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) return close();
    timer = setTimeout(async () => {
      const id = ++reqId;
      try {
        const results = await searchCities(q);
        if (id !== reqId) return; // réponse obsolète
        items = results;
        sel = -1;
        render();
      } catch { close(); }
    }, 250);
  });

  input.addEventListener("keydown", (e) => {
    if (box.classList.contains("hidden")) return;
    if (e.key === "ArrowDown") { e.preventDefault(); sel = (sel + 1) % items.length; render(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); sel = (sel - 1 + items.length) % items.length; render(); }
    else if (e.key === "Enter" && sel >= 0) { e.preventDefault(); pick(sel); }
    else if (e.key === "Escape") close();
  });

  box.addEventListener("mousedown", (e) => {
    const item = e.target.closest(".city-suggest-item");
    if (item) { e.preventDefault(); pick(+item.dataset.i); }
  });

  input.addEventListener("blur", () => setTimeout(close, 150));
}

function bindCityForm(formId, inputId, onError) {
  $(formId).addEventListener("submit", (e) => {
    e.preventDefault();
    const input = $(inputId);
    const name = input.value.trim();
    if (!name) return;
    input.disabled = true;
    onError("");
    addCity(name)
      .then(() => { input.value = ""; })
      .catch((err) => { onError(err.message); })
      .finally(() => { input.disabled = false; input.focus(); });
  });
}
bindCityForm("city-form", "city-input", (msg) => { if (msg) alert(msg); });
bindCityForm("welcome-form", "welcome-input", (msg) => { $("welcome-error").textContent = msg; });
attachCityAutocomplete("city-input", () => {});
attachCityAutocomplete("welcome-input", (msg) => { $("welcome-error").textContent = msg; });

/* ============================================================
   Init
   ============================================================ */
function refreshAll() {
  const dot = $("refresh-dot");
  const started = Date.now();
  dot.classList.add("refreshing");
  dot.title = "Actualisation en cours…";
  const done = (ok) => {
    // clignote pendant l'actualisation, minimum 5 s
    setTimeout(() => {
      dot.classList.remove("refreshing");
      dot.classList.toggle("error", !ok);
      const ts = new Date().toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "medium" });
      dot.title = ok ? `Dernière actualisation : ${ts}` : `Échec de l'actualisation : ${ts}`;
    }, Math.max(0, 5000 - (Date.now() - started)));
  };
  loadOpenMeteo()
    .then(() => done(true))
    .catch((e) => {
      done(false);
      ["obs-loading", "today-loading", "daily-loading", "agri-loading"].forEach((id) => {
        $(id).textContent = "Erreur Open-Meteo : " + e.message;
        $(id).classList.remove("hidden");
      });
    });
}

updateView();
if (cities.length) {
  renderCityTabs();
  refreshAll();
  startClimo(); // bloc facultatif, une fois par jour (cache localStorage)
}

/* switch vue Mois / Année de la climatologie */
function setClimoView(view) {
  if (climoView === view) return;
  climoView = view;
  const isYear = view === "year";
  $("climo-view-month").classList.toggle("on", !isYear);
  $("climo-view-year").classList.toggle("on", isYear);
  // la navigation par mois n'a pas de sens en vue année
  ["climo-prev", "climo-next", "climo-month-name"].forEach((id) => $(id).classList.toggle("hidden", isYear));
  renderClimoMonth(climoMonth);
}
$("climo-view-month").addEventListener("click", () => setClimoView("month"));
$("climo-view-year").addEventListener("click", () => setClimoView("year"));

/* navigation mois précédent / suivant dans la climatologie */
$("climo-prev").addEventListener("click", () => {
  climoMonth = climoMonth === 1 ? 12 : climoMonth - 1;
  renderClimoMonth(climoMonth);
});
$("climo-next").addEventListener("click", () => {
  climoMonth = climoMonth === 12 ? 1 : climoMonth + 1;
  renderClimoMonth(climoMonth);
});

/* sélecteurs d'année du graphique climato (année principale + comparaison) */
(() => {
  const sel = $("climo-year");
  const selB = $("climo-year-b");
  const curYear = new Date().getFullYear();
  for (let yy = curYear; yy >= 1940; yy--) {
    for (const s of [sel, selB]) {
      const opt = document.createElement("option");
      opt.value = String(yy);
      opt.textContent = String(yy);
      s.appendChild(opt);
    }
  }
  const normOpt = selB.querySelector('option[value="norm"]');
  normOpt.disabled = true; // activé dès qu'une année spécifique est sélectionnée
  sel.addEventListener("change", () => {
    climoYear = sel.value === "all" ? "all" : +sel.value;
    // comparer aux normales n'a de sens que si une année spécifique est affichée
    normOpt.disabled = climoYear === "all";
    if (climoYear === "all" && climoYearB === "norm") {
      climoYearB = "none";
      selB.value = "none";
    }
    renderClimoMonth(climoMonth);
  });
  selB.addEventListener("change", () => {
    climoYearB = selB.value === "none" || selB.value === "norm" ? selB.value : +selB.value;
    renderClimoMonth(climoMonth);
  });
})();

/* boutons on/off records & pluviométrie */
$("toggle-records").addEventListener("click", () => {
  showRecords = !showRecords;
  $("toggle-records").classList.toggle("on", showRecords);
  $("toggle-recyears").classList.toggle("hidden", !showRecords);
  renderClimoMonth(climoMonth);
});
$("toggle-recyears").addEventListener("click", () => {
  showRecYears = !showRecYears;
  $("toggle-recyears").classList.toggle("on", showRecYears);
  renderClimoMonth(climoMonth);
});
$("toggle-rain").addEventListener("click", () => {
  showRain = !showRain;
  $("toggle-rain").classList.toggle("on", showRain);
  renderClimoMonth(climoMonth);
});

setInterval(() => { if (cities.length) refreshAll(); }, 15 * 60 * 1000); // auto-refresh 15 min
