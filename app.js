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
  document.dispatchEvent(new Event("dashboard-city-change"));
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
  const fetchQueued = (url) => {
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
        const delay = retryAfter > 0 ? retryAfter * 1000 : RETRY_DELAYS[attempt];
        // exposé pour les indicateurs de chargement (« nouvel essai dans N s »)
        fetchQueued.retryAt = Date.now() + delay;
        await sleep(delay);
        fetchQueued.retryAt = 0;
      }
    });
    queue = task.catch(() => {}); // la file continue même si une requête échoue
    return task;
  };
  fetchQueued.retryAt = 0;
  return fetchQueued;
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

/* index du jour dans un calendrier bissextile (0-365) : même case pour une date donnée quelle que soit l'année */
const DOY366 = [0, 31, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335];
const daySlot = (mon, day) => DOY366[mon - 1] + day - 1;

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
  const cacheKey = `climo10-${LAT()},${LON()}-${today}`;

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
    // gardée en mémoire : sert aussi de source pour les années affichées (évite une requête par année,
    // qui échouerait souvent en 429 juste après ce gros téléchargement)
    climoArchive = { key: `${LAT()},${LON()}`, end: yesterday, daily: d };

    const mmdd = today.slice(5);
    const curYear = +today.slice(0, 4);
    let nTmax = 0, nTmin = 0, nCount = 0;

    // agrégats par mois : moyennes par année, records journaliers, stats par jour du mois
    const M = {};
    for (let m = 1; m <= 12; m++) M[m] = { byYear: {}, daysHot: [], daysCold: [], daysAmp: [], perDay: {} };

    // températures moyennes journalières de chaque année 1991-2020 (référence pour la variabilité)
    const ref = {};

    // dernier jour disponible : borne des périodes en cours (mois et année), comparées aux mêmes jours des autres années
    let lastI = d.time.length - 1;
    while (lastI > 0 && (d.temperature_2m_max[lastI] == null || d.temperature_2m_min[lastI] == null)) lastI--;
    const cut = d.time[lastI];
    const cutYear = +cut.slice(0, 4), cutMon = +cut.slice(5, 7), cutDay = +cut.slice(8);
    const cutSlot = daySlot(cutMon, cutDay);
    const Y = {}; // par année : année entière (s, r, n) et même période que l'année en cours (ps, pr, pn)
    const MP = {}; // par année : mois du dernier jour, du 1er au même jour
    // records quotidiens battus (chaleur : max > record, froid : min < record), comptés après 10 ans d'historique
    const REC_FROM = 1950;
    const recHi = Array(366).fill(null), recLo = Array(366).fill(null);
    const recs = {};

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
        if (year >= 1991 && year <= 2020) (ref[year] ||= Array(366).fill(null))[daySlot(mon, +dd)] = Math.round((tmax + tmin) * 5) / 10;

        const tm = (tmax + tmin) / 2, rr = d.precipitation_sum[i] || 0, slot = daySlot(mon, +dd);
        const ya = Y[year] || (Y[year] = { s: 0, r: 0, n: 0, ps: 0, pr: 0, pn: 0 });
        ya.s += tm; ya.r += rr; ya.n++;
        if (slot <= cutSlot) { ya.ps += tm; ya.pr += rr; ya.pn++; }
        if (mon === cutMon && +dd <= cutDay) {
          const mp = MP[year] || (MP[year] = { s: 0, r: 0, n: 0 });
          mp.s += tm; mp.r += rr; mp.n++;
        }
        if (recHi[slot] == null || tmax > recHi[slot]) {
          if (recHi[slot] != null && year >= REC_FROM) (recs[year] ||= { hot: 0, cold: 0 }).hot++;
          recHi[slot] = tmax;
        }
        if (recLo[slot] == null || tmin < recLo[slot]) {
          if (recLo[slot] != null && year >= REC_FROM) (recs[year] ||= { hot: 0, cold: 0 }).cold++;
          recLo[slot] = tmin;
        }
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

    // classements : température moyenne ((max + min) / 2) et cumul de pluie, par année et par mois
    const daysIn = (yy, mm) => new Date(yy, mm, 0).getDate();
    const r2 = (v) => Math.round(v * 100) / 100;
    const entry = (y, s, r, n) => ({ y: +y, tm: r2(s / n), rr: Math.round(r * 10) / 10 });
    const change = {
      last: cut,
      recFrom: REC_FROM,
      // périodes complètes uniquement
      yearly: Object.entries(Y).filter(([, v]) => v.n >= 365).map(([y, v]) => entry(y, v.s, v.r, v.n)),
      monthly: {},
      // période en cours (si incomplète) : toutes les années sur les mêmes jours
      ytd: cutMon === 12 && cutDay === 31 ? null : {
        year: cutYear, mon: cutMon, day: cutDay,
        years: Object.entries(Y).filter(([, v]) => v.pn).map(([y, v]) => entry(y, v.ps, v.pr, v.pn)),
      },
      monthPart: cutDay === daysIn(cutYear, cutMon) ? null : {
        year: cutYear, mon: cutMon, day: cutDay,
        years: Object.entries(MP).map(([y, v]) => entry(y, v.s, v.r, v.n)),
      },
      records: Array.from({ length: cutYear - REC_FROM + 1 }, (_, k) => ({ y: REC_FROM + k, ...(recs[REC_FROM + k] || { hot: 0, cold: 0 }) })),
    };
    for (let m = 1; m <= 12; m++) {
      change.monthly[m] = Object.entries(M[m].byYear)
        .filter(([y, v]) => v.n >= daysIn(+y, m))
        .map(([y, v]) => entry(y, (v.sx + v.sn) / 2, v.sr, v.n));
    }

    stats = {
      recHot: { v: curMonth.dayHot[0].v, y: +curMonth.dayHot[0].d.slice(0, 4) },
      recCold: { v: curMonth.dayCold[0].v, y: +curMonth.dayCold[0].d.slice(0, 4) },
      normMax: nCount ? nTmax / nCount : null,
      normMin: nCount ? nTmin / nCount : null,
      months,
      refYears: Object.values(ref),
      change,
    };
    // on ne garde que les caches du jour (toutes villes) au format courant
    Object.keys(localStorage).filter((k) => k.startsWith("climo") && (!k.startsWith("climo10") || !k.endsWith(today))).forEach((k) => localStorage.removeItem(k));
    try { localStorage.setItem(cacheKey, JSON.stringify(stats)); } catch {}
  }

  climoStats = stats;
  renderClimo();
  renderClimoMonth(climoMonth);
}

/* ---------- Climatologie du mois (façon Infoclimat) ---------- */
let climoMonth = new Date().getMonth() + 1; // mois affiché (1-12)
let climoView = "year"; // "month" (par jour du mois) ou "year" (jour par jour sur l'année) — par défaut l'année
let climoYear = new Date().getFullYear(); // "all" ou année (nombre) — par défaut l'année en cours
let climoYearB = "norm"; // comparaison superposée : "none", "norm" (moyennes 1991-2020) ou année — par défaut les normales
let climoRenderTok = 0; // jeton anti-course pour les rendus asynchrones
let showRain = true; // histogramme pluviométrie
let showTemps = true; // courbes de températures (masquables pour ne voir que la pluie)
let showRecords = true; // courbes des records
let showRecYears = false; // années des records sur le graphe (masquées par défaut : chargent le graphe)
// étirement vertical du graphe (menu ⚙), mémorisé (clé hors préfixe « climo », purgé chaque jour)
let climoScale = [1, 1.5, 2].includes(Number(localStorage.getItem("chartScaleClimo"))) ? Number(localStorage.getItem("chartScaleClimo")) : 1;
// largeur du graphe (menu ⚙) : au-delà de ×1, défilement horizontal
let climoWidth = [1, 2, 3, 4].includes(Number(localStorage.getItem("chartWidthClimo"))) ? Number(localStorage.getItem("chartWidthClimo")) : 1;
// courbes (menu ⚙) : "none" brutes, "round" arrondies
let climoSmooth = localStorage.getItem("chartSmoothClimo") === "round" ? "round" : "none";
const yearDailyCache = {}; // données journalières d'une année : clé "lat,lon-année"
let climoArchive = null; // archive brute 1940 → hier de la ville active, quand elle vient d'être téléchargée

/* extrait une année (jusqu'à `end`) de l'archive en mémoire, ou null si elle ne la couvre pas */
function yearFromArchive(year, end) {
  const arch = climoArchive;
  if (!arch || arch.key !== `${LAT()},${LON()}` || end > arch.end) return null;
  const t = arch.daily.time;
  const from = t.indexOf(`${year}-01-01`), to = t.indexOf(end);
  if (from < 0 || to < from) return null;
  const pick = (k) => arch.daily[k].slice(from, to + 1);
  return {
    time: t.slice(from, to + 1),
    temperature_2m_max: pick("temperature_2m_max"),
    temperature_2m_min: pick("temperature_2m_min"),
    precipitation_sum: pick("precipitation_sum"),
  };
}

/* données journalières (tmax/tmin/pluie) d'une année pour la ville active
   — cache mémoire (promesses, pour mutualiser les appels concurrents) + localStorage pour les années terminées (immuables) */
function loadYearDaily(year) {
  const yesterday = new Date(Date.now() - 86400000).toLocaleDateString("sv-SE");
  const end = `${year}-12-31` < yesterday ? `${year}-12-31` : yesterday;
  // l'année en cours grandit chaque jour : la date de fin fait partie de la clé
  const key = `${LAT()},${LON()}-${year}-${end}`;
  if (yearDailyCache[key]) return yearDailyCache[key];
  const lsKey = `omyear-${LAT()},${LON()}-${year}`;
  const finished = year < new Date().getFullYear();
  const promise = (async () => {
    // 1er janvier : rien encore pour l'année en cours (l'API refuserait une fin avant le début)
    if (end < `${year}-01-01`) return { time: [], temperature_2m_max: [], temperature_2m_min: [], precipitation_sum: [] };
    const fromArchive = yearFromArchive(year, end);
    if (fromArchive) return fromArchive;
    if (finished) {
      try {
        const cached = JSON.parse(localStorage.getItem(lsKey));
        if (cached) return cached;
      } catch {}
    }
    const url =
      `https://archive-api.open-meteo.com/v1/archive?latitude=${LAT()}&longitude=${LON()}` +
      `&start_date=${year}-01-01&end_date=${end}` +
      `&daily=temperature_2m_max,temperature_2m_min,precipitation_sum&timezone=Europe%2FParis`;
    const res = await omFetch(url);
    if (!res.ok) throw new Error(`Archive HTTP ${res.status}`);
    const daily = (await res.json()).daily;
    if (!Array.isArray(daily?.time)) throw new Error("Réponse archive invalide");
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
  })();
  yearDailyCache[key] = promise;
  promise.catch(() => delete yearDailyCache[key]); // un échec ne reste pas en cache
  return promise;
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

/* station Infoclimat la plus proche (liste locale IC_STATIONS : [id, nom, lat, lon, genre]) */
function nearestIcStation(lat, lon) {
  if (typeof IC_STATIONS === "undefined") return null;
  const R = 6371, rad = Math.PI / 180;
  let best = null, bestD = Infinity;
  for (const [id, name, sLat, sLon] of IC_STATIONS) {
    const dLat = (sLat - lat) * rad, dLon = (sLon - lon) * rad;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat * rad) * Math.cos(sLat * rad) * Math.sin(dLon / 2) ** 2;
    const d = 2 * R * Math.asin(Math.sqrt(a));
    if (d < bestD) { bestD = d; best = { id, name }; }
  }
  return best ? { ...best, dist: bestD } : null;
}

/* indicateur de chargement du graphique climato : affiché seulement si le chargement dure (> 200 ms),
   avec le délai d'attente quand Open-Meteo limite les requêtes. Renvoie la fonction qui l'arrête. */
let climoLoadingTok = 0;
function showClimoLoading(tok, years) {
  climoLoadingTok = tok;
  const el = $("climo-chart-loading");
  const update = () => {
    const wait = Math.ceil((omFetch.retryAt - Date.now()) / 1000);
    el.textContent = `Chargement des données ${years.join(" et ")}…` +
      (wait > 0 ? ` Limite de requêtes Open-Meteo atteinte, nouvel essai dans ${wait} s.` : "");
  };
  const show = setTimeout(() => {
    update();
    el.classList.remove("hidden");
    $("chart-climo").classList.add("is-loading");
  }, 200);
  const tick = setInterval(update, 1000);
  return () => {
    clearTimeout(show);
    clearInterval(tick);
    if (climoLoadingTok !== tok) return; // un rendu plus récent gère son propre indicateur
    el.classList.add("hidden");
    $("chart-climo").classList.remove("is-loading");
  };
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
  renderClimoRanks(climoView === "year", monthNum, monthLabel);
  renderClimoChange(climoView === "year", monthNum, monthLabel);
  const tok = ++climoRenderTok;
  const isYear = climoView === "year";
  const monthName = (mm, style) => new Date(2000, mm - 1, 1).toLocaleDateString("fr-FR", { month: style });
  const isLeap = (yy) => new Date(yy, 1, 29).getDate() === 29;

  // vue Année : le 29 février n'apparaît que si une des années affichées est bissextile
  const shownYears = [climoYear, climoYearB].filter((v) => typeof v === "number");
  const keepFeb29 = shownYears.some(isLeap);
  // points du graphique : jours du mois (clé = jour) ou jours de l'année (clé = case du calendrier bissextile)
  const base = isYear
    ? Array.from({ length: 12 }, (_, i) => i + 1).flatMap((mm) => (climoStats.months[mm]?.days || [])
      .filter((p) => !(mm === 2 && p.d === 29 && !keepFeb29))
      .map((p) => ({ ...p, m: mm, k: daySlot(mm, p.d), bridge: mm === 2 && p.d === 29 })))
    : m.days.map((p) => ({ ...p, m: monthNum, k: p.d }));

  // données journalières d'une année spécifique, indexées comme les points du graphique
  const ofYear = async (year) => {
    const dd = await loadYearDaily(year);
    const byKey = {};
    dd.time.forEach((t, i) => {
      const mm = +t.slice(5, 7), day = +t.slice(8);
      if (isYear || mm === monthNum)
        byKey[isYear ? daySlot(mm, day) : day] = { tmax: dd.temperature_2m_max[i], tmin: dd.temperature_2m_min[i], rain: dd.precipitation_sum[i] };
    });
    return byKey;
  };

  // charge d'abord les années affichées, avec un indicateur si ça traîne (données non encore en cache)
  if (shownYears.length) {
    const stopLoading = showClimoLoading(tok, shownYears);
    const results = await Promise.allSettled(shownYears.map(loadYearDaily));
    stopLoading();
    const failed = results.findIndex((r) => r.status === "rejected");
    if (failed >= 0) {
      if (tok === climoRenderTok) $("climo-chart-title").textContent = `Année ${shownYears[failed]} indisponible : ${results[failed].reason.message}`;
      return;
    }
  }
  // graphique : toutes les années (records + moyennes) ou une année spécifique
  let daysDraw;
  let yearMode = null;
  if (climoYear !== "all") {
    try {
      const byKey = await ofYear(+climoYear);
      daysDraw = base.map((p) => ({
        ...p,
        valMax: byKey[p.k] ? byKey[p.k].tmax : null,
        valMin: byKey[p.k] ? byKey[p.k].tmin : null,
        rain: byKey[p.k] ? byKey[p.k].rain : null,
      }));
      yearMode = +climoYear;
    } catch (e) {
      if (tok === climoRenderTok) $("climo-chart-title").textContent = `Année ${climoYear} indisponible : ${e.message}`;
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
        cmpMax: byKeyB[p.k] ? byKeyB[p.k].tmax : null,
        cmpMin: byKeyB[p.k] ? byKeyB[p.k].tmin : null,
        cmpRain: byKeyB[p.k] ? byKeyB[p.k].rain : null,
      }));
      cmpYear = +climoYearB;
    } catch (e) {
      if (tok === climoRenderTok) $("climo-chart-title").textContent = `Année ${climoYearB} indisponible : ${e.message}`;
      return;
    }
  }
  // séries journalières brutes (déjà en cache) pour les indicateurs de variabilité
  let dailyA = null, dailyB = null;
  try {
    if (yearMode) dailyA = await loadYearDaily(yearMode);
    if (typeof cmpYear === "number") dailyB = await loadYearDaily(cmpYear);
  } catch {}
  // vérifie que la sélection n'a pas changé pendant les fetchs
  if (tok !== climoRenderTok || monthNum !== climoMonth || isYear !== (climoView === "year")) return;

  // labels d'axe et de tooltip
  if (isYear) {
    daysDraw = daysDraw.map((p) => ({
      ...p,
      lbl: p.d === 1 ? monthName(p.m, "short") : "", // un repère par début de mois
      hl: `${p.d} ${monthName(p.m, "short")}`,
      tip: `${p.d} ${monthName(p.m, "long")}`,
    }));
  } else {
    daysDraw = daysDraw.map((p) => ({ ...p, lbl: String(p.d), hl: String(p.d), tip: `${p.d} ${monthLabel}` }));
  }
  // vue année : pluie en cumul depuis le 1er janvier (365 barres journalières seraient illisibles)
  if (isYear) {
    let sumA = 0, sumB = 0;
    daysDraw = daysDraw.map((p) => {
      if (p.rain != null) sumA += p.rain;
      if (p.cmpRain != null) sumB += p.cmpRain;
      return { ...p, rainCum: p.rain != null ? sumA : null, cmpRainCum: p.cmpRain != null ? sumB : null };
    });
  }

  const baseLbl = yearMode ? String(yearMode) : "moyennes 1991-2020";
  const periodTxt = isYear ? "sur l'année" : `en ${monthLabel}`;
  const granTxt = isYear ? (showTemps ? "jour par jour" : "cumul et totaux mensuels") : "par jour du mois";
  $("climo-chart-title").textContent = !showTemps
    ? (cmpYear
      ? `Pluviométrie ${baseLbl} vs ${cmpYear} ${periodTxt} (${granTxt})`
      : `Pluviométrie ${periodTxt}${yearMode ? ` ${yearMode}` : " (moyennes 1991-2020)"} (${granTxt})`)
    : cmpYear
      ? `Comparaison ${baseLbl} vs ${cmpYear} ${periodTxt} (${granTxt})`
      : yearMode
        ? `Températures et pluviométrie ${periodTxt} ${yearMode} (${granTxt})`
        : `Records, moyennes et pluviométrie ${periodTxt} (${granTxt})`;

  // phrase de synthèse en mode comparaison
  const summary = $("climo-compare-summary");
  summary.classList.add("hidden");
  $("climo-compare-chips").classList.add("hidden");
  if (cmpYear) {
    const pairsT = daysDraw.filter((p) => p.valMax != null && p.cmpMax != null && p.valMin != null && p.cmpMin != null);
    const pairsR = daysDraw.filter((p) => p.rain != null && p.cmpRain != null);
    if (!pairsT.length) {
      // typiquement le mois en cours (ou à venir) de l'année courante : pas encore de données
      const missing = daysDraw.some((p) => p.valMax != null) ? cmpYear : (yearMode || cmpYear);
      summary.innerHTML = `Pas encore de données ${missing} ${periodTxt} : comparaison impossible pour l'instant.`;
      summary.classList.remove("hidden");
    } else {
      const avg = (arr, f) => arr.reduce((a, p) => a + f(p), 0) / arr.length;
      const dMax = avg(pairsT, (p) => p.valMax - p.cmpMax);
      const dMin = avg(pairsT, (p) => p.valMin - p.cmpMin);
      const dT = (dMax + dMin) / 2;
      const dR = pairsR.reduce((a, p) => a + (p.rain - p.cmpRain), 0);

      // période partielle (année en cours) : on précise sur combien de jours porte la comparaison
      const years = [yearMode, typeof cmpYear === "number" ? cmpYear : null].filter(Boolean);
      const expected = Math.min(...years.map((yy) => isYear ? (isLeap(yy) ? 366 : 365) : new Date(yy, monthNum, 0).getDate()));
      const lastP = pairsT[pairsT.length - 1];
      const partial = pairsT.length < expected
        ? ` (sur ${pairsT.length} jour${pairsT.length > 1 ? "s" : ""} disponible${pairsT.length > 1 ? "s" : ""}, jusqu'au ${lastP.tip})`
        : "";
      const subjA = (isYear
        ? (yearMode ? `En ${yearMode}` : `Sur l'année (normales 1991-2020)`)
        : (yearMode ? `En ${monthLabel} ${yearMode}` : `En ${monthLabel} (normales 1991-2020)`)) + partial;
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
      if (pairsR.length) {
        const eqT = isYear ? 30 : 5, bigT = isYear ? 150 : 30;
        const mm = Math.abs(dR).toFixed(0);
        // cumuls des deux séries sur les mêmes jours/semaines que l'écart
        const sumA = pairsR.reduce((a, p) => a + p.rain, 0);
        const sumB = pairsR.reduce((a, p) => a + p.cmpRain, 0);
        const mmTxt = (v) => fmt(v, " mm", v < 10 ? 1 : 0);
        const totals = `${mmTxt(sumA)} ${yearMode ? `en ${yearMode}` : "en moyenne"} contre ` +
          `${mmTxt(sumB)} ${cmpNorm ? "en moyenne" : `en ${cmpYear}`}`;
        if (Math.abs(dR) < eqT) rPhrase = `, avec une <b>pluviométrie comparable</b> (${totals})`;
        else if (dR < 0) rPhrase = `, ainsi que <b>${Math.abs(dR) >= bigT ? "bien plus sec" : "plus sec"}</b> (${totals}, soit ${mm} mm de moins)`;
        else rPhrase = `, ainsi que <b>${dR >= bigT ? "bien plus arrosé" : "plus arrosé"}</b> (${totals}, soit ${mm} mm de plus)`;
      }
      summary.innerHTML = `${subjA}, ${tPhrase}${rPhrase}.`;
      // valeurs des deux séries, aux couleurs du graphique (mêmes jours que la phrase)
      // extrêmes de la période : minimale la plus basse et maximale la plus haute, avec leur date
      const extreme = (k, lowest) => pairsT.reduce((best, p) =>
        (lowest ? p[k] < best[k] : p[k] > best[k]) ? p : best);
      const ext = (p, k) => `<b>${fmt(p[k], "°")}</b> <span class="climo-cmp-date">(${p.tip})</span>`;
      const chip = (lbl, col, kMin, kMax, rain) =>
        `<span class="climo-cmp-chip" style="--c:${col}"><span class="climo-cmp-name">${lbl}</span>` +
        `<span>min ${ext(extreme(kMin, true), kMin)}</span><span>max ${ext(extreme(kMax, false), kMax)}</span>` +
        (rain != null ? `<span>pluie <b>${fmt(rain, " mm", rain < 10 ? 1 : 0)}</b></span>` : "") + `</span>`;
      const rainOf = (k) => (pairsR.length ? pairsR.reduce((a, p) => a + p[k], 0) : null);
      $("climo-compare-chips").innerHTML =
        chip(yearMode || "Normales 1991-2020", "#ffa726", "valMin", "valMax", rainOf("rain")) +
        chip(cmpNorm ? "Normales 1991-2020" : cmpYear, "#b388ff", "cmpMin", "cmpMax", rainOf("cmpRain"));
      $("climo-compare-chips").classList.remove("hidden");
      summary.classList.remove("hidden");
    }
  } else if (yearMode && !daysDraw.some((p) => p.valMax != null)) {
    summary.textContent = `Pas encore de données ${yearMode} ${periodTxt}.`;
    summary.classList.remove("hidden");
  }
  const rainWord = isYear ? (showTemps ? "Cumul de pluie" : "Cumul (ligne) et total mensuel (barres)") : "Pluie";
  const recLegend = showRecords && showTemps;
  $("climo-chart-legend").innerHTML =
    (recLegend ? `<span><i style="background:#e040fb"></i>Extrêmes maximales (année)</span>` : "") +
    (!showTemps ? "" : cmpYear
      ? `<span><i style="background:#ffa726"></i>${yearMode ? yearMode : "Moyennes 1991-2020"} (max/min)</span>
         <span><i style="background:#b388ff"></i>${cmpYear} (max/min)</span>`
      : `<span><i style="background:#e53935"></i>${yearMode ? `Maximales ${yearMode}` : "Moyenne des maximales 1991-2020"}</span>
         <span><i style="background:#1e88e5"></i>${yearMode ? `Minimales ${yearMode}` : "Moyenne des minimales 1991-2020"}</span>`) +
    (recLegend ? `<span><i style="background:#4fc3f7"></i>Extrêmes minimales (année)</span>` : "") +
    (showRain
      ? (cmpYear
        ? `<span><i style="background:#ffa726"></i>${rainWord} ${yearMode ? yearMode : "moy. 1991-2020"} (mm)</span>
           <span><i style="background:#b388ff"></i>${rainWord} ${cmpYear} (mm)</span>`
        : `<span><i style="background:#64b5f6"></i>${rainWord} ${yearMode ? yearMode : "moyenne 1991-2020"} (mm)</span>`)
      : "");
  renderClimoVariability({ isYear, monthNum, monthLabel, yearMode, cmpYear, dailyA, dailyB });
  drawClimoChart($("chart-climo"), daysDraw, monthLabel, yearMode, cmpYear);
}

/* ---------- Climat qui change : rang de l'année affichée, classements, records chaud/froid ---------- */
let climoRecYear = null; // année choisie dans la carte des records quotidiens
const plMonth = (name) => (name.endsWith("s") ? name : name + "s");
const capFirst = (s) => s[0].toUpperCase() + s.slice(1);

/* rang d'une année dans une liste { y, tm, rr } : depuis le haut (hi) et depuis le bas (lo) */
function climoRank(list, y, key) {
  const me = list.find((e) => e.y === y);
  if (!me) return null;
  return {
    n: list.length,
    hi: 1 + list.filter((e) => e[key] > me[key]).length,
    lo: 1 + list.filter((e) => e[key] < me[key]).length,
  };
}

/* liste à laquelle comparer une année : période complète, ou mêmes jours pour toutes les années si elle est en cours */
function climoPeriodList(ch, y, isYear, monthNum) {
  const part = isYear ? ch.ytd : ch.monthPart;
  if (part && part.year === y && (isYear || part.mon === monthNum)) return { list: part.years, part };
  return { list: isYear ? ch.yearly : ch.monthly[monthNum], part: null };
}

function renderClimoRanks(isYear, monthNum, monthLabel) {
  const box = $("climo-rank");
  box.classList.add("hidden");
  const ch = climoStats.change;
  if (!ch) return;
  const art = isYear ? "la" : "le";
  const tW = isYear ? ["chaude", "froide"] : ["chaud", "froid"];
  const rW = isYear ? ["arrosée", "sèche"] : ["arrosé", "sec"];
  // côté du classement le plus proche d'un extrême : « le 3e plus chaud » plutôt que « le 85e plus froid »
  const side = (r, [hiW, loW]) => {
    const top = r.hi <= r.lo;
    const k = top ? r.hi : r.lo;
    return `<b>${art} ${k === 1 ? "" : `${k}e `}plus ${top ? hiW : loW}</b>`;
  };
  const series = [[climoYear, "#ffa726"], [climoYearB, "#b388ff"]].filter(([y]) => typeof y === "number");
  const cmp = climoYearB !== "none";
  const html = series.map(([y, col]) => {
    const { list, part } = climoPeriodList(ch, y, isYear, monthNum);
    const rt = list && climoRank(list, y, "tm");
    if (!rt) return "";
    const rr = climoRank(list, y, "rr");
    const from = Math.min(...list.map((e) => e.y));
    const name = isYear ? String(y) : `${capFirst(monthLabel)} ${y}`;
    const what = isYear ? "années" : plMonth(monthLabel);
    let partTxt = "";
    if (part) {
      const pm = new Date(2000, part.mon - 1, 1).toLocaleDateString("fr-FR", { month: "long" });
      partTxt = isYear
        ? `du 1er janvier au ${part.day === 1 ? "1er" : part.day} ${pm}`
        : (part.day === 1 ? "sur le 1er jour" : `sur les ${part.day} premiers jours`);
      partTxt = ` <span class="climo-rank-sub">(${partTxt}, même période pour chaque année)</span>`;
    }
    return `<div class="climo-rank-line" style="--c:${cmp ? col : "var(--accent-2)"}">` +
      `<span class="climo-rank-name">${name} :</span> ${side(rt, tW)} et ${side(rr, rW)} des ${rt.n} ${what} depuis ${from}${partTxt}</div>`;
  }).join("");
  if (!html) return;
  box.innerHTML = html;
  box.classList.remove("hidden");
}

function renderClimoChange(isYear, monthNum, monthLabel) {
  const box = $("climo-change");
  const ch = climoStats.change;
  const list = ch && (isYear ? ch.yearly : ch.monthly[monthNum]);
  if (!list?.length) { box.classList.add("hidden"); return; }
  const curYear = new Date().getFullYear();
  const recentFrom = curYear - 15;
  const ref = list.filter((e) => e.y >= 1991 && e.y <= 2020);
  const normOf = (k) => (ref.length ? ref.reduce((a, e) => a + e[k], 0) / ref.length : null);
  const norm = normOf("tm");
  const normRr = normOf("rr");
  const plural = isYear ? "années" : plMonth(monthLabel);
  const fem = isYear ? "es" : "s";
  const femSec = isYear ? "sèches" : "secs";

  // années affichées sur le graphique : surlignées aux couleurs des séries
  const selCol = (y) => (y === climoYear ? "#ffa726" : y === climoYearB ? "#b388ff" : null);
  const rowOf = (val, anom) => (e, i) => {
    const col = selCol(e.y);
    return `<div class="stat-row climo-top-row${e.y >= recentFrom ? " recent" : ""}${col ? " sel" : ""}"${col ? ` style="--c:${col}"` : ""}>` +
      `<span>${i + 1}. <b class="climo-top-year">${e.y}</b></span>` +
      `<b>${val(e)}${anom ? ` <em class="climo-top-anom">${anom(e)}</em>` : ""}</b></div>`;
  };
  const sign = (v) => (v >= 0 ? "+" : "−");
  // températures : écart en degrés ; pluie : écart en % du cumul normal
  const row = rowOf((e) => fmt(e.tm, "°"), norm != null && ((e) => `${sign(e.tm - norm)}${Math.abs(e.tm - norm).toFixed(1)}°`));
  const rowRr = rowOf((e) => fmt(e.rr, " mm", 0), normRr > 0 && ((e) => `${sign(e.rr - normRr)}${Math.abs(Math.round((100 * (e.rr - normRr)) / normRr))} %`));
  const hot = [...list].sort((a, b) => b.tm - a.tm).slice(0, 10);
  const cold = [...list].sort((a, b) => a.tm - b.tm).slice(0, 10);
  const dry = [...list].sort((a, b) => a.rr - b.rr).slice(0, 10);
  const sub = `<span class="stat-sub">temp. moyenne · écart aux normales 1991-2020</span>`;
  const subRr = `<span class="stat-sub">cumul de pluie · écart aux normales 1991-2020</span>`;

  // records quotidiens battus, par décennie
  const dec = {};
  ch.records.forEach((r) => {
    const k = Math.floor(r.y / 10) * 10;
    const o = dec[k] || (dec[k] = { hot: 0, cold: 0, to: r.y });
    o.hot += r.hot; o.cold += r.cold; o.to = r.y;
  });
  const recRow = (label, hot, cold, title) => {
    const tot = hot + cold;
    const pct = tot ? Math.round((100 * hot) / tot) : 50;
    return `<div class="climo-rec-row" title="${title} : ${hot} record${hot > 1 ? "s" : ""} de chaleur, ${cold} record${cold > 1 ? "s" : ""} de froid">` +
      `<span class="climo-rec-dec">${label}</span>` +
      `<span class="climo-rec-bar"><i class="hot" style="width:${pct}%"></i><i class="cold" style="width:${100 - pct}%"></i></span>` +
      `<span class="climo-rec-num"><b class="rec-hot">${hot}</b> / <b class="rec-cold">${cold}</b></span></div>`;
  };
  const lastY = ch.records[ch.records.length - 1].y;
  const lastDay = new Date(ch.last).toLocaleDateString("fr-FR", { day: "numeric", month: "long" });
  const yearRow = (r) => recRow(r.y === lastY && !ch.last.endsWith("12-31") ? `${r.y}*` : r.y, r.hot, r.cold,
    r.y === lastY ? `${r.y} (jusqu'au ${lastDay})` : String(r.y));
  const decRows = Object.entries(dec).map(([k, o]) => recRow(`${k}-${String(o.to).slice(2)}`, o.hot, o.cold, `${k}-${o.to}`)).join("");
  const recentRows = ch.records.slice(-5).map(yearRow).join("");
  const pickRow = () => {
    const r = ch.records.find((e) => e.y === climoRecYear);
    return r ? yearRow(r) : "";
  };

  $("climo-change-grid").innerHTML =
    `<div class="stat-card hot"><div class="stat-title">Les 10 ${plural} les plus chaud${fem}${sub}</div>${hot.map(row).join("")}</div>` +
    `<div class="stat-card cold"><div class="stat-title">Les 10 ${plural} les plus froid${fem}${sub}</div>${cold.map(row).join("")}</div>` +
    `<div class="stat-card dry"><div class="stat-title">Les 10 ${plural} les plus ${femSec}${subRr}</div>${dry.map(rowRr).join("")}</div>`;
  // records : carte pleine largeur, en trois colonnes (décennies, 5 dernières années, année au choix)
  $("climo-change-records").innerHTML =
    `<div class="stat-card climo-rec-card"><div class="stat-title climo-rec-title"><span>Records quotidiens battus</span>` +
    `<span class="climo-rec-legend"><span class="rec-hot">■ chaleur</span> <span class="rec-cold">■ froid</span></span></div>` +
    `<div class="climo-rec-cols">` +
    `<div><div class="climo-rec-head">Par décennie, depuis ${ch.recFrom}</div>${decRows}</div>` +
    `<div><div class="climo-rec-head">5 dernières années</div>${recentRows}` +
    (ch.last.endsWith("12-31") ? "" : `<div class="climo-change-note">* année en cours, jusqu'au ${lastDay}.</div>`) + `</div>` +
    `<div><div class="climo-rec-head"><label for="climo-rec-year">Une année</label>` +
    `<select id="climo-rec-year" class="climo-year-select" autocomplete="off"><option value="">Choisir…</option>` +
    ch.records.map((r) => r.y).reverse().map((y) => `<option value="${y}"${y === climoRecYear ? " selected" : ""}>${y}</option>`).join("") +
    `</select></div><div id="climo-rec-pick">${pickRow()}</div></div>` +
    `</div></div>`;
  $("climo-rec-year").addEventListener("change", (e) => {
    climoRecYear = e.target.value ? +e.target.value : null;
    $("climo-rec-pick").innerHTML = pickRow();
  });
  box.classList.remove("hidden");
}

/* ---------- Stabilité / variabilité des températures ----------
   Calculée sur la température moyenne journalière ((max + min) / 2) :
   - variation d'un jour à l'autre : moyenne des |T(j) − T(j−1)|, le « yo-yo » du temps
   - dispersion : écart-type des écarts aux normales du jour, autour de leur moyenne sur la période
     (le cycle saisonnier est retiré : un mois uniformément chaud n'est pas « variable »)
   Chaque valeur est située dans la distribution des 30 années 1991-2020, calculée sur exactement les mêmes jours. */
const SHOW_VARIABILITY = false; // bloc masqué pour l'instant (présentation à retravailler)
const dailyMeanSeries = (daily) => {
  const s = Array(366).fill(null);
  daily.time.forEach((t, i) => {
    const tx = daily.temperature_2m_max[i], tn = daily.temperature_2m_min[i];
    if (tx != null && tn != null) s[daySlot(+t.slice(5, 7), +t.slice(8))] = (tx + tn) / 2;
  });
  return s;
};

/* normales journalières 1991-2020 de la température moyenne, lissées sur ±7 jours (30 valeurs par jour = bruitées) */
function smoothedDailyNormals(stats) {
  const raw = Array(366).fill(null);
  for (let m = 1; m <= 12; m++) {
    (stats.months[m]?.days || []).forEach((p) => {
      if (p.meanMax != null && p.meanMin != null) raw[daySlot(m, p.d)] = (p.meanMax + p.meanMin) / 2;
    });
  }
  return raw.map((_, i) => {
    let s = 0, n = 0;
    for (let k = -7; k <= 7; k++) {
      const v = raw[(i + k + 366) % 366];
      if (v != null) { s += v; n++; }
    }
    return n ? s / n : null;
  });
}

function tempVariability(series, slots, norm) {
  let prev = null, sumD = 0, nD = 0, sA = 0, sA2 = 0, nA = 0;
  for (const i of slots) {
    const t = series[i];
    if (t == null || norm[i] == null) continue; // 29 février des années non bissextiles : on enjambe la case
    if (prev != null) { sumD += Math.abs(t - prev); nD++; }
    prev = t;
    const a = t - norm[i];
    sA += a; sA2 += a * a; nA++;
  }
  if (nD < 6) return null; // une semaine au minimum
  const mA = sA / nA;
  return { dtd: sumD / nD, sd: Math.sqrt(Math.max(0, sA2 / nA - mA * mA)) };
}

function renderClimoVariability({ isYear, monthNum, monthLabel, yearMode, cmpYear, dailyA, dailyB }) {
  const box = $("climo-variability");
  box.classList.add("hidden");
  if (!SHOW_VARIABILITY) return;
  const cmp = cmpYear != null;
  const series = [];
  if (yearMode && dailyA) series.push({ lbl: String(yearMode), s: dailyMeanSeries(dailyA), col: cmp ? "#ffa726" : null });
  if (typeof cmpYear === "number" && dailyB) series.push({ lbl: String(cmpYear), s: dailyMeanSeries(dailyB), col: "#b388ff" });
  if (!series.length || !climoStats.refYears?.length) return;

  // mêmes jours pour toutes les colonnes : ceux où chaque année affichée a une donnée
  const first = isYear ? 0 : DOY366[monthNum - 1];
  const last = isYear || monthNum === 12 ? 365 : DOY366[monthNum] - 1;
  const slots = [];
  for (let i = first; i <= last; i++) if (series.every(({ s }) => s[i] != null)) slots.push(i);
  if (!slots.length) return; // période sans données (déjà signalé par la phrase de synthèse)

  const periodTxt = isYear ? "sur l'année" : `en ${monthLabel}`;
  const head = `<div class="climo-var-head">Stabilité des températures <span class="climo-sub">${periodTxt} · ${slots.length} jours comparés</span></div>`;
  const norm = smoothedDailyNormals(climoStats);
  const vals = series.map(({ s }) => tempVariability(s, slots, norm));
  const refs = climoStats.refYears.map((r) => tempVariability(r, slots, norm)).filter(Boolean);
  if (vals.every((v) => !v) || refs.length < 10) {
    box.innerHTML = head + `<p class="climo-var-note">Pas encore assez de jours disponibles pour évaluer la variabilité (une semaine minimum).</p>`;
    box.classList.remove("hidden");
    return;
  }

  const quantile = (sorted, q) => {
    const pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.min(lo + 1, sorted.length - 1);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  };
  const deg = (v) => `${v.toFixed(1).replace(".", ",")}°`;
  const badge = (v, sorted) => {
    // rang dans la distribution 1991-2020 (part des années de référence en dessous)
    const p = sorted.reduce((a, r) => a + (r < v ? 1 : r === v ? 0.5 : 0), 0) / sorted.length;
    const [label, color] =
      p >= 0.9 ? ["très variable", "#e57373"]
      : p >= 2 / 3 ? ["plus variable que d'habitude", "#ffb74d"]
      : p > 1 / 3 ? ["habituel", "#81c784"]
      : p > 0.1 ? ["plus stable que d'habitude", "#4fc3f7"]
      : ["très stable", "#9575cd"];
    return `<span class="diff-badge climo-var-badge" style="color:${color};border-color:${color}" ` +
      `title="Plus élevé que ${Math.round(p * 100)} % des années 1991-2020 sur les mêmes jours">${label}</span>`;
  };
  const rows = [
    { k: "dtd", lbl: "Variation d'un jour à l'autre",
      help: "Écart moyen de température moyenne entre deux jours consécutifs : plus il est grand, plus le temps fait le yo-yo." },
    { k: "sd", lbl: "Dispersion autour des normales",
      help: "Écart-type des écarts aux normales du jour : mesure l'ampleur des épisodes chauds et froids, une fois retiré le cycle des saisons." },
  ];
  box.innerHTML = head +
    `<div class="climo-var-scroll"><table class="climo-var-table">` +
    `<thead><tr><th></th>${series.map(({ lbl, col }) => `<th${col ? ` style="color:${col}"` : ""}>${lbl}</th>`).join("")}` +
    `<th>Habituel 1991-2020</th></tr></thead><tbody>` +
    rows.map(({ k, lbl, help }) => {
      const sorted = refs.map((r) => r[k]).sort((a, b) => a - b);
      return `<tr><th scope="row" title="${help}">${lbl} <span class="climo-var-help" aria-hidden="true">ⓘ</span></th>` +
        vals.map((v) => `<td>${v ? `<b>${deg(v[k])}</b> ${badge(v[k], sorted)}` : "--"}</td>`).join("") +
        `<td><b>${deg(quantile(sorted, 0.5))}</b> <span class="climo-sub">(${deg(quantile(sorted, 0.1))} – ${deg(quantile(sorted, 0.9))})</span></td></tr>`;
    }).join("") +
    `</tbody></table></div>` +
    `<p class="climo-var-note">Température moyenne journalière = (max + min) / 2. « Habituel » : médiane des années 1991-2020 ` +
    `sur les mêmes jours, entre parenthèses la fourchette de 8 années sur 10.</p>`;
  box.classList.remove("hidden");
}

/* Graphe records/moyennes + pluie par jour du mois (façon Infoclimat) */
/* trace une courbe passant par les points [x, y] : segments droits, ou cubique monotone (Fritsch-Carlson)
   qui arrondit les pics sans jamais dépasser les valeurs réelles. connect : prolonge le chemin courant */
function curveThrough(ctx, pts, smooth, connect = false) {
  const n = pts.length;
  if (!n) return;
  if (connect) ctx.lineTo(pts[0][0], pts[0][1]);
  else ctx.moveTo(pts[0][0], pts[0][1]);
  if (!smooth || n < 3) {
    for (let k = 1; k < n; k++) ctx.lineTo(pts[k][0], pts[k][1]);
    return;
  }
  const d = [];
  for (let k = 0; k < n - 1; k++) d.push((pts[k + 1][1] - pts[k][1]) / (pts[k + 1][0] - pts[k][0]));
  const m = pts.map((_, k) => (k === 0 ? d[0] : k === n - 1 ? d[n - 2] : d[k - 1] * d[k] <= 0 ? 0 : (d[k - 1] + d[k]) / 2));
  for (let k = 0; k < n - 1; k++) {
    if (d[k] === 0) { m[k] = 0; m[k + 1] = 0; continue; }
    const a = m[k] / d[k], b = m[k + 1] / d[k], s = a * a + b * b;
    if (s > 9) { const t = 3 / Math.sqrt(s); m[k] = t * a * d[k]; m[k + 1] = t * b * d[k]; }
  }
  for (let k = 0; k < n - 1; k++) {
    const [x0, y0] = pts[k], [x1, y1] = pts[k + 1], dx = (x1 - x0) / 3;
    ctx.bezierCurveTo(x0 + dx, y0 + m[k] * dx, x1 - dx, y1 - m[k + 1] * dx, x1, y1);
  }
}

function drawClimoChart(canvas, days, monthLabel, yearMode = null, cmpYear = null) {
  const dpr = window.devicePixelRatio || 1;
  // largeur : celle de la zone visible, multipliée par le réglage « Largeur » (défilement horizontal au-delà)
  const scroller = canvas.closest(".climo-chart-scroll");
  const baseW = scroller ? scroller.clientWidth : canvas.clientWidth || canvas.parentElement.clientWidth;
  const wide = !!scroller && climoWidth > 1;
  const w = Math.round(baseW * (wide ? climoWidth : 1));
  canvas.style.width = w + "px";
  const dense = days.length > 40; // vue année jour par jour
  // courbes « arrondies » : interpolation qui passe par les valeurs réelles
  const curved = climoSmooth === "round";
  const rainOnly = !showTemps; // températures masquées : seule la pluie est dessinée
  const monthBars = rainOnly && dense; // vue année sans températures : totaux mensuels sur l'axe gauche

  const pad = { l: rainOnly && monthBars ? 44 : 34, r: showRain ? (dense ? 52 : 40) : 10, t: 30, b: 22 };
  const all = days.flatMap((p) =>
    (showRecords ? [p.recMax, p.recMin] : []).concat([p.valMax, p.valMin], cmpYear ? [p.cmpMax, p.cmpMin] : [])
  ).filter((v) => v != null);
  // aucune valeur (mois à venir, records masqués) : on garde l'échelle des moyennes pour un graphe lisible
  if (!all.length) all.push(...days.flatMap((p) => [p.meanMax, p.meanMin]).filter((v) => v != null));
  const min = Math.floor((Math.min(...all) - 3) / 5) * 5;
  const max = Math.ceil((Math.max(...all) + 3) / 5) * 5;
  // hauteur proportionnelle à l'amplitude : espacement constant entre les degrés d'un mois à l'autre
  const PX_PER_DEG = 5.5;
  let h = Math.round((rainOnly ? 300 : (max - min) * PX_PER_DEG + pad.t + pad.b) * climoScale);
  // en plein écran : occupe la hauteur disponible (nav + titres + légende ≈ 200 px)
  if (document.fullscreenElement) h = Math.max(h, window.innerHeight - 200);

  const x = (i) => pad.l + (i / (days.length - 1)) * (w - pad.l - pad.r);
  const y = (v) => pad.t + (1 - (v - min) / (max - min)) * (h - pad.t - pad.b);

  // échelle pluie (axe de droite, mm) — cumul depuis le 1er janvier en vue année
  const rains = days.flatMap((p) => dense
    ? (cmpYear ? [p.rainCum, p.cmpRainCum] : [p.rainCum])
    : (cmpYear ? [p.rain, p.cmpRain] : [p.rain])).filter((v) => v != null);
  // maximum « rond » divisible en 4 graduations (mode pluie seule)
  const quarterMax = (v) => 4 * ([1, 2, 2.5, 5, 10, 15, 20, 25, 30, 40, 50, 75, 100, 150, 200, 250, 300, 400, 500].find((s) => 4 * s >= v) || Math.ceil(v / 4000) * 1000);
  const rawRain = Math.max(0, ...rains);
  const rainMax = rainOnly
    ? quarterMax(Math.max(dense ? 100 : 5, rawRain))
    : dense
      ? Math.max(100, Math.ceil(rawRain / 100) * 100)
      : Math.max(5, Math.ceil(rawRain / 5) * 5);
  const yr = (v) => pad.t + (1 - v / rainMax) * (h - pad.t - pad.b);

  // totaux mensuels (vue année) : étendue de chaque mois et cumul par série — barres en mode pluie seule, infobulle
  const months = [];
  if (dense) {
    days.forEach((p, i) => {
      const mo = months[months.length - 1];
      const cur = mo && mo.m === p.m ? mo : (months.push({ m: p.m, i0: i, i1: i, a: null, b: null }), months[months.length - 1]);
      cur.i1 = i;
      if (p.rain != null) cur.a = (cur.a || 0) + p.rain;
      if (p.cmpRain != null) cur.b = (cur.b || 0) + p.cmpRain;
    });
  }
  const monthMax = quarterMax(Math.max(20, ...months.flatMap((mo) => [mo.a, mo.b]).filter((v) => v != null)));
  const ym = (v) => pad.t + (1 - v / monthMax) * (h - pad.t - pad.b);
  const monthOf = (i) => months.find((mo) => i >= mo.i0 && i <= mo.i1);

  const monthLbl = monthLabel;
  // en mode comparaison : une seule couleur par année (A orange, B violet)
  const colValMax = cmpYear ? "#ffa726" : "#e53935";
  const colValMin = cmpYear ? "#ffa726" : "#1e88e5";
  const colCmp = "#b388ff";
  const colRainA = cmpYear ? "rgba(255,167,38,.4)" : "rgba(100,181,246,.45)";
  const colRainB = "rgba(179,136,255,.45)";
  const maxLbl = yearMode ? `Max ${yearMode}` : "Moy. max";
  const minLbl = yearMode ? `Min ${yearMode}` : "Moy. min";
  // vue année : total du mois survolé en valeur principale, cumul annuel en complément
  const fmtRain = (v, cum, monthTot) => dense
    ? (monthTot != null ? monthTot.toFixed(0) : "--") + " mm" +
      (cum != null ? ` <span class="tip-sub">(cumul annuel ${cum.toFixed(0)} mm)</span>` : "")
    : (v != null ? v.toFixed(1) : "--") + " mm";
  // libellé court pour l'infobulle (comparaison année ou normales)
  const cmpShort = typeof cmpYear === "string" ? "moy. 91-20" : cmpYear;
  attachChartTip(canvas, {
    padL: pad.l, padR: pad.r, count: days.length,
    onHover: (i) => paint(i),
    html: (i) => {
      const p = days[i];
      const mo = monthOf(i);
      const recs = showRecords && !rainOnly;
      const rainWord = dense ? `Pluie ${p.tip.replace(/^\d+\s+/, "")}` : "Pluie";
      return `<b>${p.tip || `${p.d} ${monthLbl}`}</b>` +
        (recs ? `<br><span style="color:#e040fb">Record max</span> <b>${p.recMax.toFixed(1)}°</b> <span class="tip-sub">(${p.recMaxY})</span>` : "") +
        (rainOnly ? "" :
          `<br><span style="color:${colValMax}">${maxLbl}</span> <b>${p.valMax != null ? p.valMax.toFixed(1) : "--"}°</b>` +
          (cmpYear ? `<br><span style="color:${colCmp}">Max ${cmpShort}</span> <b>${p.cmpMax != null ? p.cmpMax.toFixed(1) : "--"}°</b>` : "") +
          `<br><span style="color:${colValMin}">${minLbl}</span> <b>${p.valMin != null ? p.valMin.toFixed(1) : "--"}°</b>` +
          (cmpYear ? `<br><span style="color:${colCmp}">Min ${cmpShort}</span> <b>${p.cmpMin != null ? p.cmpMin.toFixed(1) : "--"}°</b>` : "")) +
        (recs ? `<br><span style="color:#4fc3f7">Record min</span> <b>${p.recMin.toFixed(1)}°</b> <span class="tip-sub">(${p.recMinY})</span>` : "") +
        (showRain ? `<br><span style="color:${cmpYear ? "#ffa726" : "#64b5f6"}">${rainWord} ${yearMode || "moy."}</span> <b>${fmtRain(p.rain, p.rainCum, mo?.a)}</b>` : "") +
        (showRain && cmpYear ? `<br><span style="color:${colCmp}">${rainWord} ${cmpShort}</span> <b>${fmtRain(p.cmpRain, p.cmpRainCum, mo?.b)}</b>` : "");
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

  // grille + axe Y températures (gauche) — en mode pluie seule : grille de l'axe pluie (quarts)
  ctx.font = "10px sans-serif";
  ctx.fillStyle = "#8fa1bb";
  if (rainOnly) {
    for (let q = 0; q <= 4; q++) {
      const gy = pad.t + (1 - q / 4) * (h - pad.t - pad.b);
      ctx.strokeStyle = "rgba(255,255,255,.07)";
      ctx.beginPath(); ctx.moveTo(pad.l, gy); ctx.lineTo(w - pad.r, gy); ctx.stroke();
      if (monthBars) {
        ctx.textAlign = "right";
        ctx.fillStyle = "#8fa1bb";
        ctx.fillText(Math.round((monthMax * q) / 4) + " mm", pad.l - 5, gy + 3);
      }
    }
    // titres des axes
    ctx.font = "9px sans-serif";
    if (monthBars) { ctx.textAlign = "left"; ctx.fillStyle = "#8fa1bb"; ctx.fillText("PAR MOIS", 2, pad.t - 14); }
    if (dense) { ctx.textAlign = "right"; ctx.fillStyle = "#64b5f6"; ctx.fillText("CUMUL", w - 2, pad.t - 14); }
    ctx.font = "10px sans-serif";
  } else {
    for (let v = min; v <= max; v += 5) {
      ctx.strokeStyle = "rgba(255,255,255,.07)";
      ctx.beginPath(); ctx.moveTo(pad.l, y(v)); ctx.lineTo(w - pad.r, y(v)); ctx.stroke();
      ctx.textAlign = "right";
      ctx.fillText(v + "°", pad.l - 5, y(v) + 3);
    }
  }
  // axe Y pluie (droite, mm)
  if (showRain) {
    ctx.textAlign = "left";
    ctx.fillStyle = "#64b5f6";
    for (const v of rainOnly ? [0, 1, 2, 3, 4].map((q) => (rainMax * q) / 4) : [0, rainMax / 2, rainMax]) {
      ctx.fillText(v.toFixed(0) + " mm", w - pad.r + 5, yr(v) + 3);
    }
  }
  // axe X (élément survolé mis en évidence)
  ctx.textAlign = "center";
  const stepX = dense ? 1 : (w < 560 ? 2 : 1); // vue année : labels déjà espacés (débuts de mois)
  days.forEach((p, i) => {
    let lbl = p.lbl != null ? p.lbl : String(p.d);
    if (dense && w < 560 && lbl) lbl = lbl.charAt(0).toUpperCase(); // mobile : initiale du mois
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
  if (showRain && dense) {
    // vue année sans températures : un bloc par mois (A puis B côte à côte), sous les cumuls
    if (monthBars) {
      months.forEach((mo) => {
        const left = x(mo.i0), right = x(mo.i1);
        const gap = Math.max(1, (right - left) * 0.08);
        const bw = cmpYear ? (right - left - 3 * gap) / 2 : right - left - 2 * gap;
        const bar = (v, color, bx) => {
          if (v == null || v <= 0) return;
          ctx.fillStyle = color;
          ctx.fillRect(bx, ym(v), bw, h - pad.b - ym(v));
        };
        bar(mo.a, cmpYear ? "rgba(255,167,38,.5)" : "rgba(100,181,246,.5)", left + gap);
        if (cmpYear) bar(mo.b, "rgba(179,136,255,.5)", left + 2 * gap + bw);
      });
    }
    // vue année : courbes de cumul en pointillés
    const cumLine = (key, stroke) => {
      ctx.beginPath();
      curveThrough(ctx, days.flatMap((p, i) => (p[key] == null ? [] : [[x(i), yr(p[key])]])), curved);
      ctx.setLineDash(rainOnly ? [] : [6, 4]);
      ctx.strokeStyle = stroke;
      ctx.lineWidth = rainOnly ? 2.5 : 1.5;
      ctx.stroke();
      ctx.setLineDash([]);
    };
    cumLine("rainCum", cmpYear ? "rgba(255,167,38,.9)" : "rgba(100,181,246,.9)");
    if (cmpYear) cumLine("cmpRainCum", "rgba(179,136,255,.9)");
  } else if (showRain) {
    const slot = (w - pad.l - pad.r) / days.length;
    const barW = Math.max(2, slot * (cmpYear ? (rainOnly ? 0.4 : 0.3) : (rainOnly ? 0.7 : 0.55)));
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
        curveThrough(ctx, seg.map(({ i, top }) => [x(i), y(top)]), curved);
        curveThrough(ctx, [...seg].reverse().map(({ i, bot }) => [x(i), y(bot)]), curved, true);
        ctx.closePath();
        ctx.fillStyle = color;
        ctx.fill();
      }
      seg = [];
    };
    days.forEach((p, i) => {
      if (p[keyTop] == null || p[keyBot] == null) return p.bridge ? undefined : flush();
      seg.push({ i, top: p[keyTop], bot: p[keyBot] });
    });
    flush();
  };

  const line = (key, color, width = 2, dash = []) => {
    ctx.beginPath();
    ctx.setLineDash(dash);
    let seg = [];
    const flush = () => { curveThrough(ctx, seg, curved); seg = []; };
    days.forEach((p, i) => {
      // 29 février absent d'une année non bissextile : la courbe l'enjambe sans se couper
      if (p[key] == null) { if (!p.bridge) flush(); return; }
      seg.push([x(i), y(p[key])]);
    });
    flush();
    ctx.strokeStyle = color;
    ctx.lineWidth = dense ? Math.max(1, width * 0.6) : width;
    ctx.stroke();
    ctx.setLineDash([]);
  };
  const dots = (key, color, r = 2.5) => {
    if (dense) return; // 365 points : les courbes suffisent
    ctx.fillStyle = color;
    days.forEach((p, i) => {
      if (p[key] == null) return;
      ctx.beginPath(); ctx.arc(x(i), y(p[key]), r, 0, Math.PI * 2); ctx.fill();
    });
  };
  // années des records (rotées) : une sur N en vue mois, le record le plus marquant de chaque quinzaine en vue année
  const yearLabels = (vKey, yKey, above) => {
    const picked = [];
    if (dense) {
      // environ une étiquette tous les 45 px
      const win = Math.ceil(days.length / Math.max(6, Math.min(24, Math.floor((w - pad.l - pad.r) / 45))));
      for (let s = 0; s < days.length; s += win) {
        let best = -1;
        for (let i = s; i < Math.min(s + win, days.length); i++) {
          if (days[i][vKey] == null) continue;
          if (best < 0 || (above ? days[i][vKey] > days[best][vKey] : days[i][vKey] < days[best][vKey])) best = i;
        }
        if (best >= 0 && (!picked.length || best - picked[picked.length - 1] >= win / 2)) picked.push(best);
      }
    } else {
      days.forEach((p, i) => { if (i % stepX === 0 && p[vKey] != null) picked.push(i); });
    }
    ctx.fillStyle = "#8fa1bb";
    picked.forEach((i) => {
      const p = days[i];
      ctx.save();
      ctx.translate(x(i), y(p[vKey]) + (above ? -7 : 7));
      ctx.rotate(-Math.PI / 3);
      ctx.textAlign = above ? "left" : "right";
      ctx.fillText(p[yKey], 0, 3);
      ctx.restore();
    });
  };

  if (rainOnly) return; // températures masquées : rien d'autre à dessiner
  if (showRecords) {
    // en comparaison, les records passent au second plan derrière les deux séries
    const recMaxCol = cmpYear ? "rgba(224,64,251,.45)" : "#e040fb";
    const recMinCol = cmpYear ? "rgba(79,195,247,.45)" : "#4fc3f7";
    const recW = cmpYear ? 1 : 1.5;
    line("recMax", recMaxCol, recW, dense ? [3, 2] : [4, 3]); dots("recMax", recMaxCol, cmpYear ? 1.5 : 2.5);
    line("recMin", recMinCol, recW, dense ? [3, 2] : [4, 3]); dots("recMin", recMinCol, cmpYear ? 1.5 : 2.5);
  }
  // aires min-max par année en mode comparaison (sous les courbes)
  if (cmpYear) {
    band("valMax", "valMin", "rgba(255,167,38,.35)");
    band("cmpMax", "cmpMin", "rgba(179,136,255,.35)");
  }
  const serieW = cmpYear ? 3 : 2.5;
  line("valMax", colValMax, serieW); dots("valMax", colValMax, 3);
  line("valMin", colValMin, serieW); dots("valMin", colValMin, 3);
  if (cmpYear) {
    line("cmpMax", colCmp, serieW); dots("cmpMax", colCmp, 3);
    line("cmpMin", colCmp, serieW); dots("cmpMin", colCmp, 3);
  }
  if (showRecords && showRecYears) {
    yearLabels("recMax", "recMaxY", true);
    yearLabels("recMin", "recMinY", false);
  }
  }; // fin paint

  paint();

  if (!scroller) return;
  scroller.classList.toggle("wide", wide);
  if (wide) {
    // axes Y recopiés dans deux canvas collés aux bords de la zone de défilement
    // (hauteur limitée à la zone des courbes : les libellés de l'axe X défilent dessous)
    const axH = Math.min(h, h - pad.b + 7);
    const axis = (el, sx, sw, margin) => {
      el.width = sw * dpr; el.height = axH * dpr;
      el.style.width = sw + "px"; el.style.height = axH + "px";
      el.style[margin] = -sw + "px";
      el.getContext("2d").drawImage(canvas, sx * dpr, 0, sw * dpr, axH * dpr, 0, 0, sw * dpr, axH * dpr);
    };
    axis($("climo-axis-l"), 0, pad.l, "marginRight");
    axis($("climo-axis-r"), w - pad.r, pad.r, "marginLeft");
  }
  // position de départ à chaque changement de vue ou de largeur : vue année centrée sur aujourd'hui
  const scrollKey = `${dense}-${climoWidth}`;
  if (scroller._key !== scrollKey) {
    scroller._key = scrollKey;
    const now = new Date();
    const iNow = dense ? days.findIndex((p) => p.m === now.getMonth() + 1 && p.d === now.getDate()) : -1;
    scroller.scrollLeft = wide && iNow >= 0 ? x(iNow) - baseW / 2 : 0;
  }
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
  climoArchive = null;
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
  // lien (titre) + vignette temps réel (bloc observations) de la station Infoclimat la plus proche
  const st = nearestIcStation(LAT(), LON());
  $("ic-station").innerHTML = st
    ? `<a class="ic-link" href="https://www.infoclimat.fr/stations-meteo/?s=${encodeURIComponent(st.id)}" target="_blank" rel="noopener" title="Station Infoclimat la plus proche">Infoclimat : ${st.name} (${st.dist.toFixed(0)} km)</a>`
    : "";
  $("ic-vignette-slot").innerHTML = st
    ? `<iframe class="ic-vignette" src="https://www.infoclimat.fr/infoclimat/vignette_fiche_temps.php?s=${encodeURIComponent(st.id)}" title="Vignette Infoclimat ${st.name}" loading="lazy" scrolling="no" width="112" height="85"></iframe>`
    : "";
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
  // l'état JS fait foi (Firefox peut restaurer une ancienne valeur des listes au rechargement)
  sel.value = String(climoYear);
  selB.value = String(climoYearB);
  normOpt.disabled = climoYear === "all"; // comparer aux normales exige une année spécifique
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

/* boutons on/off températures, records & pluviométrie (au moins un des deux, températures ou pluie, reste affiché) */
const syncClimoToggles = () => {
  $("toggle-temps").classList.toggle("on", showTemps);
  $("toggle-rain").classList.toggle("on", showRain);
  $("toggle-records").classList.toggle("on", showRecords);
  $("toggle-recyears").classList.toggle("on", showRecYears);
  // les records sont des températures : sans objet quand elles sont masquées
  $("toggle-records").classList.toggle("hidden", !showTemps);
  $("toggle-recyears").classList.toggle("hidden", !showTemps || !showRecords);
};
$("toggle-temps").addEventListener("click", () => {
  showTemps = !showTemps;
  if (!showTemps) showRain = true;
  syncClimoToggles();
  renderClimoMonth(climoMonth);
});
$("toggle-records").addEventListener("click", () => {
  showRecords = !showRecords;
  syncClimoToggles();
  renderClimoMonth(climoMonth);
});
$("toggle-recyears").addEventListener("click", () => {
  showRecYears = !showRecYears;
  syncClimoToggles();
  renderClimoMonth(climoMonth);
});
$("toggle-rain").addEventListener("click", () => {
  showRain = !showRain;
  if (!showRain) showTemps = true;
  syncClimoToggles();
  renderClimoMonth(climoMonth);
});

/* menu de paramètres d'affichage du graphique (⚙) */
(() => {
  const btn = $("climo-settings");
  const menu = $("climo-settings-menu");
  const opts = [...menu.querySelectorAll("[data-scale], [data-width], [data-smooth]")];
  const sync = () => opts.forEach((o) => {
    const on = o.dataset.scale ? Number(o.dataset.scale) === climoScale
      : o.dataset.width ? Number(o.dataset.width) === climoWidth
        : o.dataset.smooth === climoSmooth;
    o.classList.toggle("on", on);
    o.setAttribute("aria-checked", on);
  });
  const setOpen = (open) => {
    menu.classList.toggle("hidden", !open);
    btn.setAttribute("aria-expanded", open);
  };
  sync();
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    setOpen(menu.classList.contains("hidden"));
  });
  opts.forEach((o) => o.addEventListener("click", () => {
    if (o.dataset.scale) {
      climoScale = Number(o.dataset.scale);
      localStorage.setItem("chartScaleClimo", climoScale);
    } else if (o.dataset.width) {
      climoWidth = Number(o.dataset.width);
      localStorage.setItem("chartWidthClimo", climoWidth);
    } else {
      climoSmooth = o.dataset.smooth;
      localStorage.setItem("chartSmoothClimo", climoSmooth);
    }
    sync();
    renderClimoMonth(climoMonth);
  }));
  document.addEventListener("click", (e) => { if (!menu.contains(e.target)) setOpen(false); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !menu.classList.contains("hidden")) { setOpen(false); btn.focus(); }
  });
})();

/* plein écran du panneau climato (redessine le graphe au changement de taille) */
$("climo-fullscreen").addEventListener("click", () => {
  const panel = $("panel-climo-month");
  if (document.fullscreenElement) document.exitFullscreen();
  else panel.requestFullscreen().catch(() => {});
});
document.addEventListener("fullscreenchange", () => {
  const on = document.fullscreenElement === $("panel-climo-month");
  const btn = $("climo-fullscreen");
  btn.textContent = on ? "✕" : "⛶";
  btn.title = on ? "Quitter le plein écran" : "Plein écran";
  renderClimoMonth(climoMonth);
});

setInterval(() => { if (cities.length) refreshAll(); }, 15 * 60 * 1000); // auto-refresh 15 min
