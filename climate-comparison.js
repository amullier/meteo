/* Comparaison mensuelle : même modèle et même période pour les deux villes. */
(() => {
  const metrics = {
    tmin: { label: "Minimales moyennes", unit: "°C", field: "temperature_2m_min", divisor: 1, temperature: true },
    tmax: { label: "Maximales moyennes", unit: "°C", field: "temperature_2m_max", divisor: 1, temperature: true },
    rain: { label: "Précipitations", unit: "mm", field: "precipitation_sum", divisor: 1 },
    sun: { label: "Ensoleillement", unit: "h", field: "sunshine_duration", divisor: 3600 },
  };
  const months = Array.from({ length: 12 }, (_, i) => new Date(2000, i, 1).toLocaleDateString("fr-FR", { month: "long" }));
  const colors = ["#ffa726", "#b388ff"];
  const cache = new Map();
  const recordCache = new Map();
  const options = { records: true, years: true, rain: true };
  const extraCities = [];
  const key = (c) => `${c.lat},${c.lon}`;
  const escape = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const value = (v, unit) => Number.isFinite(v) ? `${v.toLocaleString("fr-FR", { maximumFractionDigits: 1 })} ${unit}` : "Indisponible";
  let enabled = false, selected = null, data = null, request = 0;
  let month = new Date().getMonth(), metric = "temperature";
  let period = "norm";
  const periodLabel = (p = period) => p === "norm" ? "normales 1991–2020" : `année ${p}`;
  let searchRequest = 0, searchTimer;
  let suggestions = [], activeSuggestion = -1;

  // Une valeur absente ne devient jamais un zéro. Les années incomplètes ne sont pas comparées.
  function monthlyValues(daily, selectedPeriod) {
    if (!Array.isArray(daily?.time)) throw new Error("Réponse climatique invalide");
    const firstYear = selectedPeriod === "norm" ? 1991 : +selectedPeriod;
    const lastYear = selectedPeriod === "norm" ? 2020 : +selectedPeriod;
    const buckets = Array.from({ length: 12 }, () => ({}));
    daily.time.forEach((date, i) => {
      const year = +date.slice(0, 4), m = +date.slice(5, 7) - 1;
      if (year < firstYear || year > lastYear || m < 0 || m > 11) return;
      const bucket = buckets[m][year] ||= Object.fromEntries(Object.keys(metrics).map((k) => [k, { sum: 0, count: 0 }]));
      Object.entries(metrics).forEach(([k, cfg]) => {
        const v = daily[cfg.field]?.[i];
        if (!Number.isFinite(v)) return;
        bucket[k].sum += v / cfg.divisor;
        bucket[k].count++;
      });
    });
    return Object.fromEntries(Object.keys(metrics).map((k) => [k, buckets.map((years, m) => {
      const complete = Object.entries(years).filter(([year, b]) => b[k].count === new Date(Date.UTC(+year, m + 1, 0)).getUTCDate());
      if (complete.length !== lastYear - firstYear + 1) return null;
      return complete.reduce((sum, [, b]) => sum + b[k].sum / (metrics[k].temperature ? b[k].count : 1), 0) / complete.length;
    })]));
  }

  function loadMonthly(c, selectedPeriod) {
    const yesterday = new Date(Date.now() - 86400000).toLocaleDateString("sv-SE");
    const isNormal = selectedPeriod === "norm";
    const start = isNormal ? "1991-01-01" : `${selectedPeriod}-01-01`;
    const end = isNormal ? "2020-12-31" : [`${selectedPeriod}-12-31`, yesterday].sort()[0];
    const storageKey = isNormal ? `citynormals-v2-era5-${key(c)}` : `citymonthly-v1-era5-${key(c)}-${selectedPeriod}-${end}`;
    const id = storageKey;
    if (cache.has(id)) return cache.get(id);
    const promise = (async () => {
      try {
        const saved = JSON.parse(localStorage.getItem(storageKey));
        if (saved && Object.keys(metrics).every((k) => Array.isArray(saved[k]) && saved[k].length === 12 && saved[k].every((v) => v === null || Number.isFinite(v)))) return saved;
      } catch {}
      const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${c.lat}&longitude=${c.lon}` +
        `&start_date=${start}&end_date=${end}&models=era5&timezone=auto` +
        "&daily=temperature_2m_min,temperature_2m_max,precipitation_sum,sunshine_duration";
      if (end < start) return monthlyValues({ time: [] }, selectedPeriod);
      const res = await omFetch(url);
      if (!res.ok) throw new Error(`Archive HTTP ${res.status}`);
      const monthly = monthlyValues((await res.json()).daily, selectedPeriod);
      if (isNormal && !Object.values(monthly).some((values) => values.some(Number.isFinite))) throw new Error("Normales indisponibles pour cette ville");
      try {
        if (!isNormal) Object.keys(localStorage).filter((k) => k.startsWith(`citymonthly-v1-era5-${key(c)}-${selectedPeriod}-`) && k !== storageKey).forEach((k) => localStorage.removeItem(k));
        localStorage.setItem(storageKey, JSON.stringify(monthly));
      } catch {}
      return monthly;
    })();
    cache.set(id, promise);
    promise.catch(() => cache.delete(id));
    return promise;
  }

  function syncCities() {
    const a = city();
    const available = [...cities, ...extraCities].filter((c, i, all) => a && key(c) !== key(a) && all.findIndex((other) => key(other) === key(c)) === i);
    if (!selected || !available.some((c) => key(c) === key(selected))) selected = available[0] || null;
    $("comparison-city-a").textContent = a?.name || "";
    closeSuggestions();
    $("comparison-city-b").value = selected?.name || "";
    if (enabled) refresh();
  }

  function loadRecords(c) {
    const end = new Date(Date.now() - 86400000).toLocaleDateString("sv-SE");
    const id = `cityrecords-v1-era5-${key(c)}-${end}`;
    if (recordCache.has(id)) return recordCache.get(id);
    const promise = (async () => {
      try {
        const saved = JSON.parse(localStorage.getItem(id));
        if (Array.isArray(saved) && saved.length === 12 && saved.every((p) =>
          p && ["min", "max"].every((k) => p[k] === null || (Number.isFinite(p[k]?.v) && /^\d{4}-\d{2}-\d{2}$/.test(p[k]?.date))))) return saved;
      } catch {}
      const res = await omFetch(`https://archive-api.open-meteo.com/v1/archive?latitude=${c.lat}&longitude=${c.lon}` +
        `&start_date=1940-01-01&end_date=${end}&models=era5&timezone=auto&daily=temperature_2m_min,temperature_2m_max`);
      if (!res.ok) throw new Error(`Archive HTTP ${res.status}`);
      const daily = (await res.json()).daily;
      if (!Array.isArray(daily?.time)) throw new Error("Réponse climatique invalide");
      const records = Array.from({ length: 12 }, () => ({ min: null, max: null }));
      daily.time.forEach((date, i) => {
        const m = +date.slice(5, 7) - 1;
        if (!records[m]) return;
        for (const k of ["min", "max"]) {
          const v = daily[`temperature_2m_${k}`]?.[i], prev = records[m][k];
          if (Number.isFinite(v) && (!prev || (k === "min" ? v < prev.v : v > prev.v))) records[m][k] = { v, date };
        }
      });
      if (!records.some((p) => p.min || p.max)) throw new Error("Records indisponibles");
      try {
        Object.keys(localStorage).filter((k) => k.startsWith(`cityrecords-v1-era5-${key(c)}-`) && k !== id).forEach((k) => localStorage.removeItem(k));
        localStorage.setItem(id, JSON.stringify(records));
      } catch {}
      return records;
    })();
    recordCache.set(id, promise);
    promise.catch(() => recordCache.delete(id));
    return promise;
  }

  async function ensureRecords() {
    const current = data;
    if (!current || current.records || current.recordsLoading || !options.records || metric !== "temperature") return;
    current.recordsLoading = true;
    current.recordsError = false;
    render();
    try {
      current.records = await Promise.all(current.cities.map(loadRecords));
    } catch {
      current.recordsError = true;
    } finally {
      current.recordsLoading = false;
      if (data === current) render();
    }
  }

  async function refresh() {
    chartTip.hide();
    const token = ++request;
    const selectedPeriod = period;
    $("comparison-period-label").textContent = periodLabel();
    $("comparison-intro").textContent = period === "norm"
      ? "Comparez le climat habituel sur une même période de 30 ans."
      : `Comparez les deux villes en ${period}. Seuls les mois complets sont affichés ; les mois incomplets, à venir ou sans données sont indiqués comme indisponibles.`;
    data = null;
    $("comparison-content").classList.add("hidden");
    $("comparison-retry").classList.add("hidden");
    const a = city(), b = selected;
    if (!enabled || !a || !b) {
      $("comparison-status").textContent = "Choisissez une seconde ville ou recherchez-la ci-dessus.";
      $("city-comparison").setAttribute("aria-busy", "false");
      return;
    }
    $("city-comparison").setAttribute("aria-busy", "true");
    $("comparison-status").textContent = `Chargement : ${a.name} et ${b.name} · ${periodLabel(selectedPeriod)}… Le premier chargement peut prendre quelques instants.`;
    try {
      const monthly = await Promise.all([loadMonthly(a, selectedPeriod), loadMonthly(b, selectedPeriod)]);
      if (token !== request) return;
      data = { cities: [a, b], monthly, period: selectedPeriod };
      $("comparison-status").textContent = "";
      $("comparison-content").classList.remove("hidden");
      render();
      ensureRecords();
    } catch (err) {
      if (token !== request) return;
      $("comparison-status").textContent = `Comparaison indisponible : ${err.message}.`;
      $("comparison-retry").classList.remove("hidden");
    } finally {
      if (token === request) $("city-comparison").setAttribute("aria-busy", "false");
    }
  }

  function conclusion(k, a, b) {
    if (!Number.isFinite(a) || !Number.isFinite(b)) return "Données insuffisantes pour comparer ce mois.";
    const diff = Math.round(Math.abs(b - a) * 10) / 10;
    if (!diff) return "Des valeurs équivalentes pour ce mois.";
    const name = data.cities[b > a ? 1 : 0].name;
    if (metrics[k].temperature) return `À ${name}, les ${k === "tmin" ? "minimales" : "maximales"} sont en moyenne ${value(diff, "°C")} plus élevées.`;
    const timing = data.period === "norm" ? "par mois" : "sur ce mois";
    if (k === "rain") return `${name} reçoit ${value(diff, "mm")} de précipitations de plus ${timing}.`;
    return `${name} bénéficie de ${value(diff, "h")} de soleil de plus ${timing}.`;
  }

  function render() {
    if (!data || !enabled) return;
    $("comparison-month").value = String(month);
    $("comparison-cards").innerHTML = Object.entries(metrics).map(([k, cfg]) => {
      const vals = data.monthly.map((n) => n[k][month]);
      return `<article class="comparison-card"><h3>${cfg.label}<span>${months[month]} · ${periodLabel(data.period)}</span></h3>` +
        data.cities.map((c, i) => `<div class="comparison-value comparison-value-${i}"><span>${escape(c.name)}</span><strong>${value(vals[i], cfg.unit)}</strong></div>`).join("") +
        `<p>${escape(conclusion(k, ...vals))}</p></article>`;
    }).join("");
    const temperature = metric === "temperature";
    const withRecords = temperature && options.records;
    $("comparison-options").classList.toggle("hidden", !temperature);
    $("comparison-options").querySelectorAll("button").forEach((button) => {
      const k = button.dataset.option;
      button.classList.toggle("on", options[k]);
      button.setAttribute("aria-pressed", String(options[k]));
      button.classList.toggle("hidden", k === "years" && !options.records);
    });
    $("comparison-record-status").textContent = !withRecords ? "" : data.recordsLoading
      ? "Chargement des records depuis 1940… Les valeurs mensuelles sont déjà affichées."
      : data.recordsError ? "Records indisponibles. Les valeurs mensuelles restent affichées." : "";
    $("comparison-record-retry").classList.toggle("hidden", !withRecords || !data.recordsError);
    $("comparison-legend").innerHTML = data.cities.map((c, i) => `<span class="comparison-legend-${i}"><i aria-hidden="true"></i>${escape(c.name)}${temperature ? " (min/max)" : ""}</span>`).join("") +
      (withRecords && data.records ? '<span class="comparison-record-legend"><i aria-hidden="true"></i>Records min/max · couleur de la ville</span>' : "") +
      (temperature && options.rain ? '<span class="comparison-rain-legend">▥ Pluie par ville · axe droit (mm)</span>' : "");
    $("comparison-chart-unit").textContent = temperature
      ? `Aires min/max · °C · ${periodLabel(data.period)}` + (withRecords ? " · records 1940 → hier" : "")
      : `Ensoleillement · h par mois · ${periodLabel(data.period)}`;
    $("comparison-source").textContent = "Source : Open-Meteo · réanalyse ERA5. Aires : moyennes mensuelles des minimales et maximales quotidiennes. " +
      (data.period === "norm" ? "Normales 1991–2020 : chaque valeur utilise 30 mois complets. Barres : cumuls mensuels moyens de précipitations (pluie et neige). " :
        `Année ${data.period} : seuls les mois complets sont affichés, avec des données demandées jusqu’à hier au plus tard. Barres : cumuls mensuels de précipitations (pluie et neige). `) +
      "Pluviométrie sur l’axe de droite. Records : extrêmes quotidiens de chaque mois depuis 1940 jusqu’à hier, propres à chaque ville (pointillés), quelle que soit l’année sélectionnée. Une donnée incomplète est indiquée comme indisponible.";
    $("comparison-metrics").querySelectorAll("button").forEach((button) => {
      const on = button.dataset.metric === metric;
      button.classList.toggle("on", on);
      button.setAttribute("aria-pressed", String(on));
    });
    $("comparison-table").innerHTML = `<caption>${temperature ? "Minimales / maximales (°C)" : "Ensoleillement (h)"} · ${periodLabel(data.period)}</caption><thead><tr><th scope="col">Mois</th>${data.cities.map((c) => `<th scope="col">${escape(c.name)}</th>`).join("")}</tr></thead><tbody>` +
      months.map((label, m) => `<tr${m === month ? ' class="selected"' : ""}><th scope="row">${label}</th>${data.monthly.map((n, i) => `<td>${temperature ?
        `${value(n.tmin[m], "°C")} / ${value(n.tmax[m], "°C")}${options.rain ? `<br>Pluie : ${value(n.rain[m], "mm")}` : ""}${withRecords && data.records ? `<br>${recordText(i, m, "min")}<br>${recordText(i, m, "max")}` : ""}` : value(n.sun[m], "h")}</td>`).join("")}</tr>`).join("") + "</tbody>";
    drawChart();
  }

  function recordText(i, m, k) {
    const record = data.records?.[i][m][k];
    return `Record ${k} : ${value(record?.v, "°C")}${record ? ` (${record.date.split("-").reverse().join("/")})` : ""}`;
  }

  function tooltip(m) {
    return `<b>${months[m]} · ${periodLabel(data.period)}</b>` + data.cities.map((c, i) => {
      const n = data.monthly[i];
      return `<br><b style="color:${colors[i]}">${escape(c.name)}</b>` + (metric === "temperature"
        ? `<br>Min : ${value(n.tmin[m], "°C")} · Max : ${value(n.tmax[m], "°C")}` +
          (options.rain ? `<br>Pluie : ${value(n.rain[m], "mm")}` : "") +
          (options.records && data.records ? `<br>${recordText(i, m, "min")}<br>${recordText(i, m, "max")}` : "")
        : `<br>Soleil : ${value(n.sun[m], "h")}`);
    }).join("");
  }

  function drawChart() {
    const temperature = metric === "temperature", withRecords = temperature && options.records && data.records;
    const withRain = temperature && options.rain;
    const values = data.monthly.flatMap((n) => temperature ? [...n.tmin, ...n.tmax] : n.sun)
      .concat(withRecords ? data.records.flatMap((records) => records.flatMap((p) => [p.min?.v, p.max?.v])) : []).filter(Number.isFinite);
    if (!values.length) {
      $("comparison-chart").innerHTML = '<p class="loading">Cet indicateur est indisponible pour les deux villes.</p>';
      return;
    }
    const width = Math.max(280, $("comparison-chart").clientWidth);
    const rawMin = temperature ? Math.min(...values) - 3 : 0;
    const rawMax = Math.max(...values) + (temperature ? 3 : 0);
    const step = temperature ? 5 : Math.max(5, Math.ceil((rawMax - rawMin) / 4));
    const min = Math.floor(rawMin / step) * step, max = Math.max(min + step, Math.ceil(rawMax / step) * step);
    const height = Math.max(300, temperature ? (max - min) * 5.5 + 65 : 300);
    const left = 36, right = width - (withRain ? 58 : 18), top = 35, bottom = height - 30;
    const x = (m) => left + m * (right - left) / 11;
    const y = (v) => bottom - (v - min) / (max - min) * (bottom - top);
    let svg = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${temperature ? "Aires de températures minimales et maximales" : "Ensoleillement"} : comparaison mensuelle de ${escape(data.cities[0].name)} et ${escape(data.cities[1].name)}. Valeurs disponibles dans le tableau ci-dessous.">`;
    for (let v = min; v <= max; v += step) {
      svg += `<line x1="${left}" x2="${right}" y1="${y(v)}" y2="${y(v)}" stroke="var(--border)"/><text x="${left - 8}" y="${y(v) + 4}" text-anchor="end">${v}${temperature ? "°" : ""}</text>`;
    }
    svg += `<line x1="${x(month)}" x2="${x(month)}" y1="${top}" y2="${bottom}" stroke="var(--muted)" stroke-dasharray="3 4"/>`;
    if (withRain) {
      const rains = data.monthly.flatMap((n) => n.rain).filter(Number.isFinite);
      const rainMax = Math.max(5, Math.ceil(Math.max(0, ...rains) / 5) * 5);
      const yr = (v) => bottom - v / rainMax * (bottom - top);
      const barWidth = Math.max(2, (right - left) / 12 * .3);
      [0, rainMax / 2, rainMax].forEach((v) => {
        svg += `<text class="comparison-rain-axis" x="${right + 8}" y="${yr(v) + 4}">${Math.round(v)} mm</text>`;
      });
      data.monthly.forEach((n, i) => n.rain.forEach((v, m) => {
        if (Number.isFinite(v)) svg += `<rect class="comparison-rain-bar" x="${x(m) + (i ? 0 : -barWidth)}" y="${yr(v)}" width="${barWidth}" height="${bottom - yr(v)}" fill="${colors[i]}" fill-opacity=".4"/>`;
      }));
    }
    // Aires contiguës uniquement : une donnée manquante coupe la bande min/max.
    if (temperature) data.monthly.forEach((n, i) => {
      let segment = [];
      const flush = () => {
        if (segment.length > 1) {
          const points = [...segment.map((m) => `${x(m)},${y(n.tmax[m])}`), ...[...segment].reverse().map((m) => `${x(m)},${y(n.tmin[m])}`)].join(" ");
          svg += `<polygon class="comparison-temperature-band" points="${points}" fill="${colors[i]}" fill-opacity=".28"/>`;
        }
        segment = [];
      };
      n.tmin.forEach((v, m) => {
        if (Number.isFinite(v) && Number.isFinite(n.tmax[m])) segment.push(m);
        else flush();
      });
      flush();
    });
    const line = (vals, i, record = false, kind = "") => {
      let path = "", connected = false;
      vals.forEach((v, m) => {
        if (!Number.isFinite(v)) { connected = false; return; }
        path += `${connected ? "L" : "M"}${x(m)},${y(v)} `;
        connected = true;
      });
      svg += `<path class="${record ? "comparison-record-line" : "comparison-normal-line"}" d="${path}" fill="none" stroke="${colors[i]}" stroke-width="${record ? 1.5 : 2.5}"${record ? ' stroke-dasharray="4 3"' : ""}/>`;
      vals.forEach((v, m) => {
        if (Number.isFinite(v)) svg += `<circle cx="${x(m)}" cy="${y(v)}" r="${m === month ? 5 : 3}" fill="${colors[i]}" stroke="var(--panel)" stroke-width="1.5"/>`;
        if (record && options.years && Number.isFinite(v) && (width >= 560 || m % 2 === i)) {
          const ty = y(v) + (kind === "max" ? -9 : 14);
          svg += `<text class="comparison-record-year" transform="translate(${x(m)},${ty}) rotate(-45)" style="fill:${colors[i]}" text-anchor="${kind === "max" ? "start" : "end"}">${data.records[i][m][kind].date.slice(0, 4)}</text>`;
        }
      });
    };
    data.monthly.forEach((n, i) => {
      if (temperature) { line(n.tmin, i); line(n.tmax, i); }
      else line(n.sun, i);
      if (withRecords) for (const k of ["min", "max"]) line(data.records[i].map((p) => p[k]?.v), i, true, k);
    });
    months.forEach((label, m) => {
      const short = width < 480 ? label[0] : new Date(2000, m, 1).toLocaleDateString("fr-FR", { month: "short" }).replace(".", "");
      const cell = (right - left) / 11;
      svg += `<text x="${x(m)}" y="${height - 8}" text-anchor="middle"${m === month ? ' class="selected"' : ""}>${short}</text>`;
      svg += `<rect data-month="${m}" x="${Math.max(0, x(m) - cell / 2)}" y="${top}" width="${cell}" height="${height - top}" fill="transparent"/>`;
    });
    $("comparison-chart").innerHTML = svg + "</svg>";
  }

  function setMode(on) {
    chartTip.hide();
    closeSuggestions();
    enabled = on;
    $("climo-single").classList.toggle("hidden", on);
    $("city-comparison").classList.toggle("hidden", !on);
    ["single", "compare"].forEach((mode) => {
      const active = (mode === "compare") === on;
      $("climo-mode-" + mode).classList.toggle("on", active);
      $("climo-mode-" + mode).setAttribute("aria-pressed", String(active));
    });
    if (on) syncCities();
    else {
      ++request;
      $("city-comparison").setAttribute("aria-busy", "false");
      renderClimoMonth(climoMonth);
    }
  }

  const normalize = (s) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

  function localSuggestions(query = "") {
    return [...cities, ...extraCities].filter((c, i, all) =>
      city() && key(c) !== key(city()) && all.findIndex((other) => key(other) === key(c)) === i &&
      normalize(c.name).includes(normalize(query)));
  }

  function closeSuggestions() {
    ++searchRequest;
    clearTimeout(searchTimer);
    suggestions = [];
    activeSuggestion = -1;
    $("comparison-search-results").replaceChildren();
    $("comparison-search-results").classList.add("hidden");
    $("comparison-city-b").setAttribute("aria-expanded", "false");
    $("comparison-city-b").removeAttribute("aria-activedescendant");
    $("comparison-search-status").textContent = "";
  }

  function pickSuggestion(i) {
    const c = suggestions[i];
    if (!c) return;
    if (![...cities, ...extraCities].some((other) => key(other) === key(c))) extraCities.push(c);
    selected = c;
    closeSuggestions();
    $("comparison-city-b").value = c.name;
    refresh();
  }

  function showSuggestions(found) {
    suggestions = found;
    activeSuggestion = -1;
    const results = $("comparison-search-results");
    results.replaceChildren();
    $("comparison-city-b").removeAttribute("aria-activedescendant");
    found.forEach((c, i) => {
      const option = document.createElement("div");
      option.id = `comparison-option-${i}`;
      option.setAttribute("role", "option");
      option.setAttribute("aria-selected", "false");
      option.textContent = c.label || c.name;
      option.addEventListener("mousedown", (e) => e.preventDefault());
      option.addEventListener("click", () => pickSuggestion(i));
      results.appendChild(option);
    });
    results.classList.toggle("hidden", !found.length);
    $("comparison-city-b").setAttribute("aria-expanded", String(!!found.length));
  }

  async function search(query, token) {
    const status = $("comparison-search-status");
    status.textContent = "Recherche…";
    try {
      const found = await searchCities(query);
      if (token !== searchRequest) return;
      const merged = [...localSuggestions(query), ...found.map((r) => ({
        name: r.name, lat: r.latitude, lon: r.longitude,
        label: [r.name, r.admin1, r.country].filter(Boolean).join(" · "),
      }))].filter((c, i, all) => city() && key(c) !== key(city()) && all.findIndex((other) => key(other) === key(c)) === i);
      showSuggestions(merged);
      status.textContent = merged.length ? `${merged.length} ville(s) proposée(s).` : "Aucune autre ville trouvée.";
    } catch {
      if (token === searchRequest) status.textContent = "Recherche indisponible. Vous pouvez choisir une ville enregistrée ou réessayer.";
    }
  }

  $("climo-mode-single").addEventListener("click", () => setMode(false));
  $("climo-mode-compare").addEventListener("click", () => setMode(true));
  const cityInput = $("comparison-city-b");
  cityInput.addEventListener("focus", () => {
    showSuggestions(localSuggestions());
    cityInput.select();
  });
  cityInput.addEventListener("click", () => {
    if (cityInput.getAttribute("aria-expanded") === "false") showSuggestions(localSuggestions());
  });
  cityInput.addEventListener("input", () => {
    closeSuggestions();
    const query = cityInput.value.trim();
    showSuggestions(localSuggestions(query));
    if (query.length >= 2) {
      const token = searchRequest;
      searchTimer = setTimeout(() => search(query, token), 350);
    }
  });
  cityInput.addEventListener("blur", () => {
    closeSuggestions();
    cityInput.value = selected?.name || "";
  });
  cityInput.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!suggestions.length) showSuggestions(localSuggestions(cityInput.value === selected?.name ? "" : cityInput.value.trim()));
      if (!suggestions.length) return;
      activeSuggestion = activeSuggestion < 0 ? (e.key === "ArrowDown" ? 0 : suggestions.length - 1) :
        (activeSuggestion + (e.key === "ArrowDown" ? 1 : -1) + suggestions.length) % suggestions.length;
      Array.from($("comparison-search-results").children).forEach((el, i) => el.setAttribute("aria-selected", String(i === activeSuggestion)));
      const option = $("comparison-search-results").children[activeSuggestion];
      cityInput.setAttribute("aria-activedescendant", option.id);
      option.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") {
      e.preventDefault();
      pickSuggestion(activeSuggestion < 0 ? 0 : activeSuggestion);
    } else if (e.key === "Escape") {
      closeSuggestions();
      cityInput.value = selected?.name || "";
    }
  });
  $("comparison-retry").addEventListener("click", refresh);
  for (let year = new Date().getFullYear(); year >= 1940; year--) $("comparison-year").add(new Option(String(year), String(year)));
  $("comparison-year").addEventListener("change", (e) => {
    period = e.target.value;
    refresh();
  });
  months.forEach((label, i) => $("comparison-month").add(new Option(label, i)));
  $("comparison-month").addEventListener("change", (e) => { month = +e.target.value; render(); });
  $("comparison-prev").addEventListener("click", () => { month = (month + 11) % 12; render(); });
  $("comparison-next").addEventListener("click", () => { month = (month + 1) % 12; render(); });
  $("comparison-metrics").addEventListener("click", (e) => {
    const button = e.target.closest("button[data-metric]");
    if (button) { metric = button.dataset.metric; chartTip.hide(); render(); ensureRecords(); }
  });
  $("comparison-options").addEventListener("click", (e) => {
    const button = e.target.closest("button[data-option]");
    if (!button) return;
    const k = button.dataset.option;
    options[k] = !options[k];
    chartTip.hide();
    render();
    ensureRecords();
  });
  $("comparison-record-retry").addEventListener("click", ensureRecords);
  $("comparison-chart").addEventListener("mousemove", (e) => {
    const target = e.target.closest("[data-month]");
    if (target && data) chartTip.show(tooltip(+target.dataset.month), e.clientX, e.clientY);
    else chartTip.hide();
  });
  $("comparison-chart").addEventListener("mouseleave", () => chartTip.hide());
  $("comparison-chart").addEventListener("click", (e) => {
    const target = e.target.closest("[data-month]");
    if (target) { month = +target.dataset.month; render(); }
  });
  document.addEventListener("dashboard-city-change", () => {
    syncCities();
  });
  new ResizeObserver(() => { if (enabled && data) drawChart(); }).observe($("comparison-chart"));
  syncCities();
})();
