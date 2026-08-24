/* ============================================================
   APP.JS  — CleanFlow: Data Cleaning & Reporting Automation
   v2.0 — Proper pipeline: Profile RAW → User reviews → Clean → Profile CLEAN
   ============================================================ */

// ── Palette ────────────────────────────────────────────────
const COLORS = {
  amber: '#f59e0b', amber2: '#fcd34d',
  cyan:  '#22d3ee', cyan2:  '#67e8f9',
  green: '#22c55e', red:    '#f43f5e',
  orange:'#fb923c', purple: '#a78bfa',
};

// ── NULL-like strings (treated as missing) ─────────────────
const NULL_STRINGS = new Set([
  '', 'null', 'none', 'n/a', 'na', 'unknown', '-', 'undefined',
  'nan', 'nil', 'missing', '#n/a', 'not available', '?'
]);

// ── Business rules for known column types ─────────────────
const BUSINESS_RULES = {
  age:          { min: 0,  max: 130, hard_min: 18, hard_max: 100, label: 'Age (valid: 18–100)' },
  satisfaction: { min: 1,  max: 10,  label: 'Satisfaction (valid: 1–10)' },
  score:        { min: 0,  max: 100, label: 'Score (valid: 0–100)' },
  rating:       { min: 1,  max: 5,   label: 'Rating (valid: 1–5)' },
  salary:       { min: 0,  label: 'Salary (must be > 0)' },
  income:       { min: 0,  label: 'Income (must be > 0)' },
  price:        { min: 0,  label: 'Price (must be ≥ 0)' },
  revenue:      { min: 0,  label: 'Revenue (must be ≥ 0)' },
};

// ── Email regex ────────────────────────────────────────────
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/;

// ── State ──────────────────────────────────────────────────
let rawData     = [];
let cleanData   = [];
let headers     = [];
let rawProfile  = {};   // profile of RAW data (shown before pipeline)
let cleanProfile= {};   // profile of CLEAN data (shown after pipeline)
let rawDupes    = {};   // { exact: [], byField: {} }
let rawIssues   = {};   // summary counts before cleaning
let cleanIssues = {};   // summary counts after cleaning
let pipelineLog = [];
let currentView = 'before';
let currentPage = 1;
const PER_PAGE  = 12;
let chartMap    = {};
let tableData   = [];
let pipelineRan = false;

// ── Utils ──────────────────────────────────────────────────
const fmtN   = v => Number(v).toLocaleString();
const fmtPct = (a, b) => b ? ((a/b)*100).toFixed(1)+'%' : '0%';

function isMissing(v) {
  if (v === null || v === undefined) return true;
  return NULL_STRINGS.has(String(v).trim().toLowerCase());
}

function showToast(msg, type = 'info') {
  const t = document.getElementById('toast');
  t.textContent = msg; t.className = `toast ${type} show`;
  setTimeout(() => { t.className = 'toast'; }, 3400);
}
function destroyChart(id) {
  if (chartMap[id]) { chartMap[id].destroy(); delete chartMap[id]; }
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Type Detection ─────────────────────────────────────────
function detectType(colName, values) {
  const col = colName.toLowerCase();
  // Email column
  if (col.includes('email') || col.includes('mail')) return 'email';
  // ID-like columns
  if (col === 'id' || col.endsWith('_id') || col.endsWith('id')) return 'id';

  const nonMissing = values.filter(v => !isMissing(v));
  if (!nonMissing.length) return 'string';

  // Date detection
  const dateCount = nonMissing.filter(v => {
    const s = String(v);
    return /^\d{4}-\d{2}-\d{2}/.test(s) || /^\d{2}[\/\-]\d{2}[\/\-]\d{4}/.test(s);
  }).length;
  if (dateCount / nonMissing.length > 0.6) return 'date';

  // Numeric detection — ONLY truly numeric strings count
  const numCount = nonMissing.filter(v => {
    const n = parseFloat(String(v).replace(/[$,]/g, ''));
    return !isNaN(n) && isFinite(n);
  }).length;
  if (numCount / nonMissing.length > 0.75) return 'numeric';

  return 'string';
}

// ── Email Validation ───────────────────────────────────────
function validateEmails(values) {
  const nonMissing = values.filter(v => !isMissing(v));
  const invalid    = nonMissing.filter(v => !EMAIL_RE.test(String(v).trim()));
  return { total: nonMissing.length, invalid: invalid.length, invalidList: invalid.slice(0, 5) };
}

// ── Duplicate Detection (3 kinds) ─────────────────────────
function detectDuplicates(data) {
  // 1. Exact full-row duplicates
  const rowSeen = new Map();
  const exactDupeIdxs = [];
  data.forEach((row, i) => {
    const key = headers.map(h => String(row[h] ?? '').trim().toLowerCase()).join('\x00');
    if (rowSeen.has(key)) exactDupeIdxs.push(i);
    else rowSeen.set(key, i);
  });

  // 2. Key-field duplicates (id, email columns)
  const byField = {};
  headers.forEach(col => {
    const colL = col.toLowerCase();
    if (!colL.includes('id') && !colL.includes('email') && !colL.includes('mail')) return;
    const seen = new Map(); const dupeRows = [];
    data.forEach((row, i) => {
      const v = String(row[col] ?? '').trim().toLowerCase();
      if (!v || isMissing(row[col])) return;
      if (seen.has(v)) dupeRows.push({ idx: i, value: row[col], firstIdx: seen.get(v) });
      else seen.set(v, i);
    });
    if (dupeRows.length) byField[col] = dupeRows;
  });

  return { exact: exactDupeIdxs, byField };
}

// ── Profile Dataset ────────────────────────────────────────
function profileDataset(data) {
  const p = {};
  headers.forEach(col => {
    const vals      = data.map(r => r[col]);
    const type      = detectType(col, vals);
    const missing   = vals.filter(v => isMissing(v)).length;

    // For numeric: also count "invalid numeric" strings like "unknown", "N/A"
    const invalidNumeric = type === 'numeric'
      ? vals.filter(v => !isMissing(v) && (isNaN(parseFloat(String(v))) || !isFinite(parseFloat(String(v))))).length
      : 0;

    const nonMissing = vals.filter(v => !isMissing(v));
    const unique     = new Set(nonMissing.map(v => String(v).trim().toLowerCase())).size;

    let min, max, mean, median, iqrOutliers = [], ruleViolations = [];

    if (type === 'numeric') {
      const nums = nonMissing
        .map(v => parseFloat(String(v).replace(/[$,]/g, '')))
        .filter(n => !isNaN(n) && isFinite(n));

      if (nums.length) {
        min  = Math.min(...nums);
        max  = Math.max(...nums);
        mean = nums.reduce((s, n) => s + n, 0) / nums.length;
        const sorted = [...nums].sort((a, b) => a - b);
        median = sorted.length % 2 === 0
          ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
          : sorted[Math.floor(sorted.length / 2)];

        // IQR outliers
        const q1  = sorted[Math.floor(sorted.length * 0.25)];
        const q3  = sorted[Math.floor(sorted.length * 0.75)];
        const iqr = q3 - q1;
        iqrOutliers = nums.filter(n => n < q1 - 1.5 * iqr || n > q3 + 1.5 * iqr);

        // Business rules
        const colKey = Object.keys(BUSINESS_RULES).find(k => col.toLowerCase().includes(k));
        if (colKey) {
          const rule = BUSINESS_RULES[colKey];
          ruleViolations = nums.filter(n => {
            if (rule.min !== undefined && n < rule.min) return true;
            if (rule.max !== undefined && n > rule.max) return true;
            return false;
          });
        }
      }
    }

    // Email validation
    let emailStats = null;
    if (type === 'email') {
      emailStats = validateEmails(vals);
    }

    // All unique outliers (IQR ∪ rule violations)
    const allOutlierVals = new Set([...iqrOutliers, ...ruleViolations]);

    p[col] = {
      type, missing, invalidNumeric, unique,
      min, max, mean, median,
      iqrOutliers, ruleViolations,
      outlierCount: allOutlierVals.size,
      emailStats,
      total: vals.length
    };
  });
  return p;
}

// ── Summarise Issues ───────────────────────────────────────
function summariseIssues(data, prof, dupes) {
  const totalMissing     = headers.reduce((s, c) => s + prof[c].missing, 0);
  const totalInvalidNum  = headers.reduce((s, c) => s + (prof[c].invalidNumeric || 0), 0);
  const totalOutliers    = headers.reduce((s, c) => s + (prof[c].outlierCount || 0), 0);
  const totalInvalidEmail= headers.reduce((s, c) => s + (prof[c].emailStats?.invalid || 0), 0);
  const exactDupes       = dupes?.exact?.length || 0;
  const keyDupes         = Object.values(dupes?.byField || {}).reduce((s, arr) => s + arr.length, 0);
  return { totalMissing, totalInvalidNum, totalOutliers, totalInvalidEmail, exactDupes, keyDupes };
}

// ── Quality Score ──────────────────────────────────────────
function calcQualityScore(data, issues) {
  if (!data.length || !headers.length) return 0;
  const totalCells = data.length * headers.length;
  const totalIssues = issues.totalMissing
    + issues.totalInvalidNum
    + issues.exactDupes
    + (issues.totalOutliers * 0.5)
    + (issues.totalInvalidEmail * 0.75);
  return Math.round(Math.max(0, Math.min(100, 100 - (totalIssues / totalCells) * 100)));
}

// ── Update KPIs ────────────────────────────────────────────
function updateKPIs(score, issues, rowCount, cleanRowCount) {
  const circumference = 2 * Math.PI * 34;
  const fill   = document.getElementById('scoreRingFill');
  const offset = circumference * (1 - score / 100);
  fill.style.strokeDashoffset = offset;
  fill.style.stroke = score >= 80 ? COLORS.green : score >= 50 ? COLORS.amber : COLORS.red;
  document.getElementById('scoreNum').textContent = score;
  const grade = score >= 90 ? 'Excellent' : score >= 75 ? 'Good' : score >= 50 ? 'Fair' : 'Poor';
  document.getElementById('scoreGrade').textContent = grade + ' Quality';

  // Missing = blanks + invalid-numeric strings
  const totalMissing = issues.totalMissing + issues.totalInvalidNum;
  document.getElementById('kpiMissing').textContent = fmtN(totalMissing);
  document.getElementById('kpiMissingPct').textContent =
    `${issues.totalMissing} blank, ${issues.totalInvalidNum} invalid strings`;

  // Dupes
  const totalDupes = issues.exactDupes + issues.keyDupes;
  document.getElementById('kpiDupes').textContent = fmtN(totalDupes);
  document.getElementById('kpiDupesPct').textContent =
    `${issues.exactDupes} exact rows, ${issues.keyDupes} key-field dupes`;

  document.getElementById('kpiRows').textContent = fmtN(rowCount);
  document.getElementById('kpiCols').textContent = `${headers.length} columns detected`;

  document.getElementById('kpiCleanRows').textContent = cleanRowCount !== null ? fmtN(cleanRowCount) : '—';
  document.getElementById('kpiFixed').textContent = cleanRowCount !== null
    ? `${fmtN(rowCount - cleanRowCount)} rows removed, ${fmtN(totalMissing)} cells fixed`
    : 'Run pipeline to clean';
}

// ── Pipeline Step UI ───────────────────────────────────────
function setStep(id, state, detail) {
  const el   = document.getElementById(id);
  if (!el) return;
  const icon = el.querySelector('.step-icon');
  const det  = document.getElementById(`${id}-detail`);
  icon.className = 'step-icon step-icon--' +
    (state === 'active' ? 'active' : state === 'complete' ? 'complete' : 'done');
  if (det) det.textContent = detail;
}
function activateConnector(id) {
  const el = document.getElementById(id);
  if (el) el.classList.add('done');
}

// ── Run Pipeline ───────────────────────────────────────────
async function runPipeline() {
  if (!rawData.length) return;
  pipelineLog = [];
  const opts = {
    missing:    document.getElementById('opt-missing').checked,
    dupes:      document.getElementById('opt-dupes').checked,
    caseNorm:   document.getElementById('opt-case').checked,
    whitespace: document.getElementById('opt-whitespace').checked,
    outliers:   document.getElementById('opt-outliers').checked,
    types:      document.getElementById('opt-types').checked,
    strategy:   document.getElementById('missingStrategy').value,
  };

  document.getElementById('btnRunPipeline').disabled = true;

  // Deep clone raw data
  let data = rawData.map(r => ({ ...r }));

  // ── Step: Profile ──────────────────────────────
  setStep('step-profile', 'active', 'Profiling raw…');
  await sleep(350);
  const rIssues = rawIssues; // already computed on load
  setStep('step-profile', 'complete',
    `${rIssues.totalMissing} missing, ${rIssues.exactDupes} dupes`);
  activateConnector('conn-2');
  pipelineLog.push({ step: 'Profile', detail: `${rIssues.totalMissing} missing cells, ${rIssues.exactDupes} exact dupes, ${rIssues.totalOutliers} outliers, ${rIssues.totalInvalidEmail} invalid emails` });

  // ── Step: Missing Values ───────────────────────
  setStep('step-missing', 'active', 'Processing…');
  await sleep(450);
  let missingFixed = 0;
  if (opts.missing) {
    // Recompute per-column stats for the current data
    const freshProf = profileDataset(data);
    headers.forEach(col => {
      if (!freshProf[col].missing && !freshProf[col].invalidNumeric) return;
      if (opts.strategy === 'drop') {
        data = data.filter(r => !isMissing(r[col]));
      } else {
        // numeric fill
        const fill = opts.strategy === 'mean'   ? freshProf[col].mean?.toFixed(2)
                   : opts.strategy === 'median' ? freshProf[col].median?.toFixed(2)
                   : opts.strategy === 'zero'   ? '0'
                   : opts.strategy === 'mode'   ? getMode(rawData.map(r => r[col]))
                   : null;
        data.forEach(r => {
          if (isMissing(r[col])) {
            r[col] = fill ?? 'N/A'; r.__fixed = true; missingFixed++;
          }
          // Also fix invalid numeric strings (N/A in numeric col)
          else if (freshProf[col].type === 'numeric' && isNaN(parseFloat(String(r[col])))) {
            r[col] = fill ?? 'N/A'; r.__fixed = true; missingFixed++;
          }
        });
      }
    });
  }
  setStep('step-missing', 'complete', `${missingFixed} cells fixed`);
  activateConnector('conn-3');
  pipelineLog.push({ step: 'Missing Values', detail: `Fixed ${missingFixed} cells (strategy: ${opts.strategy})` });

  // ── Step: Duplicates ──────────────────────────
  setStep('step-dupes', 'active', 'Scanning…');
  await sleep(400);
  let exactRemoved = 0, keyDupesRemoved = 0;
  if (opts.dupes) {
    const before = data.length;
    const seen = new Set();
    data = data.filter(row => {
      const key = headers.map(h => String(row[h] ?? '').trim().toLowerCase()).join('\x00');
      if (seen.has(key)) return false;
      seen.add(key); return true;
    });
    exactRemoved = before - data.length;

    // Key-field dupes (keep first occurrence)
    headers.forEach(col => {
      const colL = col.toLowerCase();
      if (!colL.includes('id') && !colL.includes('email')) return;
      const seen2 = new Set(); const before2 = data.length;
      data = data.filter(row => {
        const v = String(row[col] ?? '').trim().toLowerCase();
        if (!v || isMissing(row[col])) return true;
        if (seen2.has(v)) return false;
        seen2.add(v); return true;
      });
      keyDupesRemoved += before2 - data.length;
    });
  }
  const totalDupesRemoved = exactRemoved + keyDupesRemoved;
  setStep('step-dupes', 'complete',
    `${exactRemoved} exact + ${keyDupesRemoved} key-field removed`);
  activateConnector('conn-4');
  pipelineLog.push({ step: 'Duplicates', detail: `Removed ${exactRemoved} exact rows, ${keyDupesRemoved} key-field dupes` });

  // ── Step: Normalize ────────────────────────────
  setStep('step-normalize', 'active', 'Normalizing…');
  await sleep(400);
  let normFixed = 0;
  const freshP2 = profileDataset(data);
  data.forEach(row => {
    headers.forEach(col => {
      if (typeof row[col] !== 'string') return;
      let v = row[col];
      if (opts.whitespace && v !== v.trim()) { v = v.trim(); normFixed++; }
      if (opts.caseNorm && v && freshP2[col].type === 'string' && freshP2[col].type !== 'email') {
        const proper = v.charAt(0).toUpperCase() + v.slice(1).toLowerCase();
        if (proper !== v) { v = proper; normFixed++; }
      }
      row[col] = v;
    });
  });
  setStep('step-normalize', 'complete', `${normFixed} values normalized`);
  activateConnector('conn-5');
  pipelineLog.push({ step: 'Normalize', detail: `${normFixed} text values trimmed/cased` });

  // ── Step: Outliers ─────────────────────────────
  setStep('step-outliers', 'active', 'Detecting…');
  await sleep(400);
  let outliersFlagged = 0;
  if (opts.outliers) {
    const outProf = profileDataset(data);
    data.forEach(row => {
      headers.forEach(col => {
        if (outProf[col].type !== 'numeric') return;
        const n = parseFloat(String(row[col] ?? '').replace(/[$,]/g, ''));
        if (isNaN(n)) return;

        // IQR check
        const { iqrOutliers, ruleViolations } = outProf[col];
        const isIQR  = iqrOutliers.includes(n);
        const colKey = Object.keys(BUSINESS_RULES).find(k => col.toLowerCase().includes(k));
        const rule   = colKey ? BUSINESS_RULES[colKey] : null;
        const isRule = rule
          ? (rule.min !== undefined && n < rule.min) || (rule.max !== undefined && n > rule.max)
          : false;

        if (isIQR || isRule) {
          row.__outlier = row.__outlier || {};
          row.__outlier[col] = { value: n, reason: isRule ? 'Business rule' : 'IQR' };
          outliersFlagged++;
        }
      });
    });
  }
  setStep('step-outliers', 'complete', `${outliersFlagged} flagged`);
  activateConnector('conn-6');
  pipelineLog.push({ step: 'Outliers', detail: `Flagged ${outliersFlagged} outlier values using IQR + business rules` });

  // ── Done ────────────────────────────────────────
  cleanData    = data;
  cleanProfile = profileDataset(cleanData);
  const cleanDupes  = detectDuplicates(cleanData);
  cleanIssues  = summariseIssues(cleanData, cleanProfile, cleanDupes);
  const cleanScore  = calcQualityScore(cleanData, cleanIssues);

  setStep('step-export', 'complete', `${fmtN(cleanData.length)} clean rows`);
  pipelineLog.push({ step: 'Clean Export', detail: `${cleanData.length} rows, score: ${cleanScore}%` });

  updateKPIs(cleanScore, cleanIssues, rawData.length, cleanData.length);
  buildPostCharts(rawProfile, cleanProfile, { missingFixed, exactRemoved, keyDupesRemoved, normFixed, outliersFlagged });
  buildProfilerCards(cleanProfile, rawProfile);
  buildSummaryBanner(rawIssues, cleanIssues, rawData.length, cleanData.length);
  buildReport(cleanScore, rawIssues, cleanIssues, rawData.length, cleanData.length);

  // Switch table to cleaned view
  tableData   = cleanData;
  currentView = 'after';
  document.getElementById('tabBefore').className = 'compare-tab';
  document.getElementById('tabAfter').className  = 'compare-tab active';
  currentPage = 1;
  renderTable(tableData);

  pipelineRan = true;
  document.getElementById('btnRunPipeline').disabled = false;
  document.getElementById('btnExport').disabled      = false;
  document.getElementById('btnReport').disabled      = false;

  showToast(`Pipeline complete — score improved to ${cleanScore}%!`, 'success');
}

function getMode(vals) {
  const freq = {};
  vals.filter(v => !isMissing(v)).forEach(v => { freq[v] = (freq[v] || 0) + 1; });
  return Object.entries(freq).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'N/A';
}

// ── Summary Banner (Before → After) ───────────────────────
function buildSummaryBanner(raw, clean, rawRows, cleanRows) {
  const existingBanner = document.getElementById('summaryBanner');
  if (existingBanner) existingBanner.remove();

  const banner = document.createElement('div');
  banner.id = 'summaryBanner';
  banner.className = 'summary-banner';
  banner.innerHTML = `
    <div class="banner-col banner-col--before">
      <span class="banner-label">RAW DATA</span>
      <div class="banner-stats">
        <span class="bstat"><span class="bstat-num">${fmtN(rawRows)}</span> rows</span>
        <span class="bstat bstat--red"><span class="bstat-num">${fmtN(raw.totalMissing + raw.totalInvalidNum)}</span> missing</span>
        <span class="bstat bstat--red"><span class="bstat-num">${fmtN(raw.exactDupes)}</span> exact dupes</span>
        <span class="bstat bstat--amber"><span class="bstat-num">${fmtN(raw.totalOutliers)}</span> outliers</span>
        <span class="bstat bstat--amber"><span class="bstat-num">${fmtN(raw.totalInvalidEmail)}</span> bad emails</span>
      </div>
    </div>
    <div class="banner-arrow">
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none"><path d="M5 12h14M12 5l7 7-7 7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </div>
    <div class="banner-col banner-col--after">
      <span class="banner-label">CLEAN DATA</span>
      <div class="banner-stats">
        <span class="bstat"><span class="bstat-num">${fmtN(cleanRows)}</span> rows</span>
        <span class="bstat bstat--green"><span class="bstat-num">${fmtN(clean.totalMissing + clean.totalInvalidNum)}</span> missing</span>
        <span class="bstat bstat--green"><span class="bstat-num">${fmtN(clean.exactDupes)}</span> exact dupes</span>
        <span class="bstat bstat--green"><span class="bstat-num">${fmtN(clean.totalOutliers)}</span> outliers</span>
        <span class="bstat bstat--green"><span class="bstat-num">${fmtN(clean.totalInvalidEmail)}</span> bad emails</span>
      </div>
    </div>`;

  // Insert before charts section
  const chartsSection = document.getElementById('charts');
  if (chartsSection) chartsSection.parentNode.insertBefore(banner, chartsSection);
}

// ── Charts (pre-pipeline: raw data only) ───────────────────
function buildRawCharts(prof, issues) {
  // Missing Values per column — single bar, all columns
  destroyChart('missingChart');
  const missingCols = headers.filter(h => prof[h].missing > 0 || prof[h].invalidNumeric > 0);
  const ctx1 = document.getElementById('missingChart').getContext('2d');
  document.getElementById('missingChartTitle').textContent = 'Missing Values per Column';
  document.getElementById('missingChartSub').textContent   = 'Nulls, blanks & invalid strings detected in raw data';
  chartMap['missingChart'] = new Chart(ctx1, {
    type: 'bar',
    data: {
      labels: missingCols.length ? missingCols : ['(none)'],
      datasets: [{
        label: 'Missing / Invalid',
        data: missingCols.length
          ? missingCols.map(h => prof[h].missing + (prof[h].invalidNumeric || 0))
          : [0],
        backgroundColor: missingCols.map(h => {
          const pct = (prof[h].missing + (prof[h].invalidNumeric||0)) / prof[h].total;
          return pct > 0.1 ? COLORS.red + '99' : COLORS.amber + '99';
        }),
        borderColor: missingCols.map(h => {
          const pct = (prof[h].missing + (prof[h].invalidNumeric||0)) / prof[h].total;
          return pct > 0.1 ? COLORS.red : COLORS.amber;
        }),
        borderWidth: 1.5, borderRadius: 6, borderSkipped: false,
      }]
    },
    options: {
      responsive: true, animation: { duration: 700 },
      plugins: {
        legend: { display: false },
        tooltip: { backgroundColor: 'rgba(12,14,24,0.97)', borderColor: 'rgba(255,255,255,0.1)', borderWidth: 1, padding: 12,
          callbacks: { label: ctx => `  ${ctx.parsed.y} missing / invalid cells` } }
      },
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: 11 }, color: '#7a8499' } },
        y: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { font: { size: 11 }, stepSize: 1 }, beginAtZero: true }
      }
    }
  });

  // Type Distribution Donut
  buildTypeChart(prof);

  // Quality Score per Column — horizontal bar
  destroyChart('fixChart');
  document.getElementById('fixChartTitle').textContent = 'Column Quality Scores';
  document.getElementById('fixChartSub').textContent   = 'Data health per column (before cleaning)';
  const qualities = headers.map(h => {
    const p = prof[h];
    return Math.max(0, Math.round(100
      - (p.missing / p.total) * 100
      - (p.invalidNumeric || 0) / p.total * 100
      - (p.outlierCount || 0) / p.total * 50
      - (p.emailStats?.invalid || 0) / p.total * 100
    ));
  });
  const ctx3 = document.getElementById('fixChart').getContext('2d');
  chartMap['fixChart'] = new Chart(ctx3, {
    type: 'bar',
    data: {
      labels: headers,
      datasets: [{
        label: 'Quality %',
        data: qualities,
        backgroundColor: qualities.map(q => q >= 80 ? COLORS.green + '99' : q >= 50 ? COLORS.amber + '99' : COLORS.red + '99'),
        borderColor:     qualities.map(q => q >= 80 ? COLORS.green : q >= 50 ? COLORS.amber : COLORS.red),
        borderWidth: 1.5, borderRadius: 6, borderSkipped: false,
      }]
    },
    options: {
      responsive: true, animation: { duration: 700 },
      plugins: {
        legend: { display: false },
        tooltip: { backgroundColor: 'rgba(12,14,24,0.97)', borderColor: 'rgba(255,255,255,0.1)', borderWidth: 1, padding: 12,
          callbacks: { label: ctx => `  Quality: ${ctx.parsed.y}%` } }
      },
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: 10 }, color: '#7a8499' } },
        y: { grid: { color: 'rgba(255,255,255,0.05)' }, min: 0, max: 100,
          ticks: { font: { size: 11 }, callback: v => v + '%' } }
      }
    }
  });
}

// ── Charts (post-pipeline: before vs after) ─────────────────
function buildPostCharts(rProf, cProf, fixes) {
  // Before vs After: missing per column
  destroyChart('missingChart');
  const colsWithIssues = headers.filter(h => rProf[h].missing > 0 || rProf[h].invalidNumeric > 0);
  document.getElementById('missingChartTitle').textContent = 'Missing Values — Before vs After';
  document.getElementById('missingChartSub').textContent   = 'Count of nulls / invalid strings per column';
  const ctx1 = document.getElementById('missingChart').getContext('2d');
  chartMap['missingChart'] = new Chart(ctx1, {
    type: 'bar',
    data: {
      labels: colsWithIssues.length ? colsWithIssues : ['No issues'],
      datasets: [
        { label: 'Before', data: colsWithIssues.map(h => rProf[h].missing + (rProf[h].invalidNumeric || 0)),
          backgroundColor: COLORS.red + '88', borderColor: COLORS.red, borderWidth: 1.5, borderRadius: 5, borderSkipped: false },
        { label: 'After',  data: colsWithIssues.map(h => (cProf[h]?.missing || 0) + (cProf[h]?.invalidNumeric || 0)),
          backgroundColor: COLORS.green + '88', borderColor: COLORS.green, borderWidth: 1.5, borderRadius: 5, borderSkipped: false }
      ]
    },
    options: {
      responsive: true, animation: { duration: 600 },
      plugins: { legend: { position: 'top', labels: { usePointStyle: true, pointStyle: 'circle', padding: 14, font: { size: 11 } } },
        tooltip: { backgroundColor: 'rgba(12,14,24,0.97)', borderColor: 'rgba(255,255,255,0.1)', borderWidth: 1, padding: 10 } },
      scales: { x: { grid: { display: false }, ticks: { font: { size: 10 } } }, y: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { font: { size: 10 } }, beginAtZero: true } }
    }
  });

  // Type Distribution Donut
  buildTypeChart(rProf);

  // Issues Fixed by Stage
  destroyChart('fixChart');
  document.getElementById('fixChartTitle').textContent = 'Issues Fixed by Stage';
  document.getElementById('fixChartSub').textContent   = 'Cleaning impact per pipeline step';
  const fixLabels = ['Missing / Invalid', 'Exact Dupes', 'Key Dupes', 'Normalization', 'Outliers'];
  const fixVals   = [fixes.missingFixed, fixes.exactRemoved, fixes.keyDupesRemoved, fixes.normFixed, fixes.outliersFlagged];
  const fixColors = [COLORS.amber, COLORS.red, COLORS.orange, COLORS.cyan, COLORS.purple];
  const ctx3 = document.getElementById('fixChart').getContext('2d');
  chartMap['fixChart'] = new Chart(ctx3, {
    type: 'bar',
    data: {
      labels: fixLabels,
      datasets: [{ label: 'Fixed', data: fixVals,
        backgroundColor: fixColors.map(c => c + '99'), borderColor: fixColors,
        borderWidth: 1.5, borderRadius: 6, borderSkipped: false }]
    },
    options: {
      responsive: true, animation: { duration: 600 },
      plugins: { legend: { display: false },
        tooltip: { backgroundColor: 'rgba(12,14,24,0.97)', borderColor: 'rgba(255,255,255,0.1)', borderWidth: 1, padding: 10 } },
      scales: { x: { grid: { display: false }, ticks: { font: { size: 10 } } }, y: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { font: { size: 10 } }, beginAtZero: true } }
    }
  });
}

// ── Type Donut (shared) ─────────────────────────────────────
function buildTypeChart(prof) {
  destroyChart('typeChart');
  const typeCounts = { numeric: 0, string: 0, date: 0, email: 0, id: 0 };
  headers.forEach(h => { typeCounts[prof[h].type] = (typeCounts[prof[h].type] || 0) + 1; });
  const typeLabels = Object.keys(typeCounts).filter(k => typeCounts[k] > 0);
  const typeColors = { numeric: COLORS.amber, string: COLORS.cyan, date: COLORS.purple, email: COLORS.orange, id: COLORS.green };
  document.getElementById('typeTotal').textContent = headers.length;
  const ctx2 = document.getElementById('typeChart').getContext('2d');
  chartMap['typeChart'] = new Chart(ctx2, {
    type: 'doughnut',
    data: {
      labels: typeLabels,
      datasets: [{ data: typeLabels.map(k => typeCounts[k]),
        backgroundColor: typeLabels.map(k => typeColors[k] + 'bb'),
        borderColor:     typeLabels.map(k => typeColors[k]),
        borderWidth: 2, borderRadius: 4, hoverBorderWidth: 0 }]
    },
    options: { cutout: '65%', responsive: true, animation: { duration: 700 },
      plugins: { legend: { position: 'bottom', labels: { usePointStyle: true, pointStyle: 'circle', padding: 14, font: { size: 11 } } },
        tooltip: { backgroundColor: 'rgba(12,14,24,0.97)', borderColor: 'rgba(255,255,255,0.1)', borderWidth: 1, padding: 10 } } }
  });
}

// ── Column Profiler Cards ──────────────────────────────────
function buildProfilerCards(prof, rawProf) {
  const grid = document.getElementById('profilerGrid');
  grid.innerHTML = headers.map(col => {
    const p      = prof[col];
    const rp     = rawProf ? rawProf[col] : p;
    const missPct= ((rp.missing / rp.total) * 100).toFixed(0);
    const quality= Math.max(0, 100
      - (rp.missing / rp.total) * 100
      - (rp.invalidNumeric || 0) / rp.total * 100
      - (rp.outlierCount || 0) / rp.total * 50
      - (rp.emailStats?.invalid || 0) / rp.total * 100
    );
    const qColor = quality >= 80 ? COLORS.green : quality >= 50 ? COLORS.amber : COLORS.red;
    const typeBadge = p.type === 'numeric' ? 'type-num'
                    : p.type === 'date'    ? 'type-date'
                    : p.type === 'email'   ? 'type-email'
                    : p.type === 'id'      ? 'type-id'
                    : 'type-str';

    let statsHtml = `
      <div class="profiler-stat">Missing <span style="color:${rp.missing>0?COLORS.red:'inherit'}">${rp.missing} (${missPct}%)</span></div>`;
    if (rp.invalidNumeric) statsHtml += `<div class="profiler-stat">Invalid strings <span style="color:${COLORS.red}">${rp.invalidNumeric}</span></div>`;
    statsHtml += `<div class="profiler-stat">Unique <span>${p.unique}</span></div>`;

    if (p.type === 'numeric' && p.mean !== undefined) {
      statsHtml += `
        <div class="profiler-stat">Mean <span>${(+p.mean).toFixed(1)}</span></div>
        <div class="profiler-stat">Min / Max <span>${p.min} / ${p.max}</span></div>
        <div class="profiler-stat">IQR outliers <span style="color:${rp.iqrOutliers?.length?COLORS.amber:'inherit'}">${rp.iqrOutliers?.length || 0}</span></div>
        <div class="profiler-stat">Rule violations <span style="color:${rp.ruleViolations?.length?COLORS.red:'inherit'}">${rp.ruleViolations?.length || 0}</span></div>`;
    }
    if (p.type === 'email' && rp.emailStats) {
      statsHtml += `<div class="profiler-stat">Valid emails <span>${rp.emailStats.total - rp.emailStats.invalid}</span></div>
        <div class="profiler-stat">Invalid emails <span style="color:${rp.emailStats.invalid>0?COLORS.red:'inherit'}">${rp.emailStats.invalid}</span></div>`;
      if (rp.emailStats.invalidList?.length) {
        statsHtml += `<div class="profiler-stat" style="flex-direction:column;gap:2px;font-size:10px;color:${COLORS.red};font-family:'JetBrains Mono',monospace">${rp.emailStats.invalidList.map(e=>`<span>${e}</span>`).join('')}</div>`;
      }
    }

    return `<div class="profiler-col">
      <div class="profiler-col-top">
        <span class="profiler-col-name">${col}</span>
        <span class="profiler-type-badge ${typeBadge}">${p.type}</span>
      </div>
      ${statsHtml}
      <div class="profiler-bar-wrap">
        <div class="profiler-bar-fill" style="width:${Math.max(0,quality).toFixed(0)}%;background:${qColor}"></div>
      </div>
      <p class="profiler-quality-label" style="color:${qColor}">${quality.toFixed(0)}% quality</p>
    </div>`;
  }).join('');
}

// ── Table ──────────────────────────────────────────────────
function switchTab(view) {
  currentView = view;
  tableData   = view === 'before' ? rawData : cleanData;
  document.getElementById('tabBefore').className = 'compare-tab' + (view === 'before' ? ' active' : '');
  document.getElementById('tabAfter').className  = 'compare-tab' + (view === 'after'  ? ' active' : '');
  currentPage = 1; renderTable(tableData);
}

function renderTable(data) {
  const search = document.getElementById('tableSearch').value.toLowerCase();
  let rows = data.filter(r =>
    !search || headers.some(h => String(r[h] ?? '').toLowerCase().includes(search))
  );

  const total = rows.length;
  const pages = Math.max(1, Math.ceil(total / PER_PAGE));
  if (currentPage > pages) currentPage = pages;

  const start    = (currentPage - 1) * PER_PAGE;
  const pageRows = rows.slice(start, start + PER_PAGE);

  document.getElementById('tableHead').innerHTML =
    `<tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr>`;

  document.getElementById('tableBody').innerHTML = pageRows.map(row => {
    const cells = headers.map(col => {
      const val     = row[col];
      const missing = isMissing(val);
      const isOutlier = row.__outlier?.[col];
      const isInvalidEmail = rawProfile[col]?.type === 'email' && !isMissing(val) && !EMAIL_RE.test(String(val).trim());

      let cls = '', disp = missing ? '<em class="cell-null">null</em>' : String(val);
      if (missing)       cls = 'cell-null';
      if (isOutlier)     cls = 'cell-outlier';
      if (isInvalidEmail && currentView === 'before') { cls = 'cell-bad-email'; disp = `⚠ ${val}`; }
      return `<td class="${cls}">${disp}</td>`;
    }).join('');
    return `<tr>${cells}</tr>`;
  }).join('') || `<tr><td colspan="${headers.length}" style="text-align:center;padding:24px;color:var(--txt3)">No rows found</td></tr>`;

  document.getElementById('tableRowsBadge').textContent = `${fmtN(total)} rows`;
  document.getElementById('rowsInfo').textContent = `Page ${currentPage} / ${pages}`;
  buildPagination(pages);
}

function buildPagination(pages) {
  const el = document.getElementById('pagination');
  let html = `<button class="page-btn" onclick="goPage(${currentPage-1})" ${currentPage===1?'disabled':''}>‹</button>`;
  const range = [];
  for (let i = 1; i <= pages; i++) {
    if (i === 1 || i === pages || Math.abs(i - currentPage) <= 1) range.push(i);
    else if (range[range.length - 1] !== '…') range.push('…');
  }
  range.forEach(p => {
    if (p === '…') html += `<button class="page-btn" disabled>…</button>`;
    else html += `<button class="page-btn ${p===currentPage?'active':''}" onclick="goPage(${p})">${p}</button>`;
  });
  html += `<button class="page-btn" onclick="goPage(${currentPage+1})" ${currentPage===pages?'disabled':''}>›</button>`;
  el.innerHTML = html;
}

function goPage(p) {
  const pages = Math.ceil(tableData.length / PER_PAGE);
  if (p < 1 || p > pages) return;
  currentPage = p; renderTable(tableData);
}

// ── Report ─────────────────────────────────────────────────
function buildReport(score, rIssues, cIssues, rawRows, cleanRows) {
  const ts = new Date().toLocaleString();
  document.getElementById('rTitle').textContent    = 'Data Quality Report';
  document.getElementById('rTimestamp').textContent= `Generated: ${ts}`;
  const grade = score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 60 ? 'C' : score >= 45 ? 'D' : 'F';
  document.getElementById('rGrade').textContent = grade;
  document.getElementById('rGrade').style.color = score >= 75 ? COLORS.green : score >= 50 ? COLORS.amber : COLORS.red;

  const numCols = headers.filter(h => rawProfile[h].type === 'numeric').length;
  const dateCols = headers.filter(h => rawProfile[h].type === 'date').length;
  const emailCols= headers.filter(h => rawProfile[h].type === 'email').length;
  document.getElementById('reportBody').innerHTML = `
    <div class="report-stat"><p class="report-stat-label">Original Rows</p><h3 class="report-stat-value">${fmtN(rawRows)}</h3><p class="report-stat-sub">before cleaning</p></div>
    <div class="report-stat"><p class="report-stat-label">Clean Rows</p><h3 class="report-stat-value" style="color:var(--green)">${fmtN(cleanRows)}</h3><p class="report-stat-sub">after pipeline</p></div>
    <div class="report-stat"><p class="report-stat-label">Columns</p><h3 class="report-stat-value">${headers.length}</h3><p class="report-stat-sub">${numCols} numeric, ${dateCols} date, ${emailCols} email</p></div>
    <div class="report-stat"><p class="report-stat-label">Quality Score</p><h3 class="report-stat-value" style="color:${score>=75?COLORS.green:COLORS.amber}">${score}%</h3><p class="report-stat-sub">grade: ${grade}</p></div>
  `;

  const icons = {
    ok:   `<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><polyline points="20 6 9 17 4 12" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    warn: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" stroke="currentColor" stroke-width="2"/><line x1="12" y1="9" x2="12" y2="13" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="12" y1="17" x2="12.01" y2="17" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
    info: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/><line x1="12" y1="8" x2="12" y2="12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="12" y1="16" x2="12.01" y2="16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
    err:  `<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/><line x1="15" y1="9" x2="9" y2="15" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="9" y1="9" x2="15" y2="15" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
  };

  const totalRawMissing = rIssues.totalMissing + rIssues.totalInvalidNum;
  const findings = [
    totalRawMissing > 0
      ? { t:'warn', title:`${totalRawMissing} Missing / Invalid Cells Found`,
          body:`${rIssues.totalMissing} blank cells and ${rIssues.totalInvalidNum} invalid strings (e.g. "N/A", "unknown") across ${headers.filter(h=>rawProfile[h].missing>0||rawProfile[h].invalidNumeric>0).length} columns. Handled using "${document.getElementById('missingStrategy').value}" strategy.` }
      : { t:'ok', title:'No Missing Values', body:'All cells contain valid data. No imputation was required.' },

    rIssues.exactDupes > 0 || rIssues.keyDupes > 0
      ? { t:'warn', title:`${rIssues.exactDupes + rIssues.keyDupes} Duplicates Detected`,
          body:`${rIssues.exactDupes} exact row duplicates and ${rIssues.keyDupes} key-field duplicates (in ID/email columns) were found. Dataset reduced from ${rawRows} to ${cleanRows} rows.` }
      : { t:'ok', title:'No Duplicates Found', body:'No duplicate rows or key-field duplicates were detected.' },

    rIssues.totalOutliers > 0
      ? { t:'warn', title:`${rIssues.totalOutliers} Outliers Detected`,
          body:`Outliers were identified using IQR (Interquartile Range) and business rules (e.g. Age: 18–100, Salary: ≥ 0, Satisfaction: 1–10). These are flagged in amber in the data table.` }
      : { t:'ok', title:'No Outliers Detected', body:'All numeric values fall within expected IQR and business rule ranges.' },

    rIssues.totalInvalidEmail > 0
      ? { t:'err', title:`${rIssues.totalInvalidEmail} Invalid Email Addresses`,
          body:`Malformed email addresses were found in email columns. Invalid examples: ${headers.flatMap(h=>rawProfile[h].emailStats?.invalidList||[]).slice(0,3).join(', ') || 'see table'}. These require manual review or removal.` }
      : emailCols > 0
        ? { t:'ok', title:'All Email Addresses Valid', body:'All email addresses passed RFC-style format validation.' }
        : { t:'info', title:'No Email Columns', body:'No email-type columns were detected in this dataset.' },

    dateCols > 0
      ? { t:'info', title:`${dateCols} Date Column(s) Detected`,
          body:`Columns classified as DATE type: ${headers.filter(h=>rawProfile[h].type==='date').join(', ')}. These are treated as strings during cleaning. Future versions will support date parsing and range validation.` }
      : { t:'info', title:'No Date Columns Detected', body:'No columns matched the date pattern (YYYY-MM-DD or DD/MM/YYYY).' },
  ];

  document.getElementById('reportFindings').innerHTML = findings.map(f => `
    <div class="finding-row">
      <div class="finding-icon finding-icon--${f.t}">${icons[f.t]}</div>
      <div><p class="finding-title">${f.title}</p><p class="finding-body">${f.body}</p></div>
    </div>`).join('');
}

// ── Update loadData to use buildRawCharts ─────────────────
function loadData(rows) {
  if (!rows?.length) { showToast('No valid data found', 'error'); return; }
  rawData    = rows;
  headers    = Object.keys(rows[0]);
  cleanData  = [];
  pipelineRan= false;

  document.getElementById('dashboardArea').classList.remove('hidden');
  document.getElementById('btnRunPipeline').disabled = false;
  document.getElementById('btnExport').disabled      = true;
  document.getElementById('btnReport').disabled      = true;

  // Reset pipeline steps
  ['step-profile','step-missing','step-dupes','step-normalize','step-outliers','step-export'].forEach(id => setStep(id, 'pending', 'Pending'));
  ['conn-2','conn-3','conn-4','conn-5','conn-6'].forEach(id => { const el = document.getElementById(id); if (el) el.classList.remove('done'); });
  document.getElementById('step-ingest-detail').textContent = `${fmtN(rows.length)} rows × ${headers.length} cols`;

  // ── Profile RAW data immediately ──────────────
  rawProfile = profileDataset(rawData);
  rawDupes   = detectDuplicates(rawData);
  rawIssues  = summariseIssues(rawData, rawProfile, rawDupes);
  const rawScore = calcQualityScore(rawData, rawIssues);

  // Show RAW KPIs (no clean rows yet)
  updateKPIs(rawScore, rawIssues, rawData.length, null);

  // Build initial charts based on raw data only
  buildRawCharts(rawProfile, rawIssues);
  buildProfilerCards(rawProfile, rawProfile);

  // Show raw data in table
  tableData   = rawData;
  currentView = 'before';
  document.getElementById('tabBefore').className = 'compare-tab active';
  document.getElementById('tabAfter').className  = 'compare-tab';
  currentPage = 1;
  renderTable(tableData);

  document.getElementById('dashboardArea').scrollIntoView({ behavior: 'smooth' });
  showToast(
    `Loaded ${fmtN(rows.length)} rows — ${fmtN(rawIssues.totalMissing)} missing, ${fmtN(rawIssues.exactDupes)} dupes, ${fmtN(rawIssues.totalInvalidEmail)} bad emails. Click Run Pipeline to clean!`,
    rawScore >= 80 ? 'success' : 'info'
  );
}

// ── CSV Parse ──────────────────────────────────────────────
function parseCsvText(text) {
  const result = Papa.parse(text.trim(), { header: true, skipEmptyLines: true, dynamicTyping: false });
  if (!result.data?.length) throw new Error('No valid rows found');
  return result.data;
}

// ── Export ─────────────────────────────────────────────────
function exportClean() {
  const data = pipelineRan ? cleanData : rawData;
  const rows = data.map(r => headers.map(h => r[h] ?? '').join(','));
  const csv  = [headers.join(','), ...rows].join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = (pipelineRan ? 'cleaned_data' : 'raw_data') + '.csv'; a.click();
  URL.revokeObjectURL(url);
  showToast('Data exported as CSV!', 'success');
}

function exportReport() {
  const issues = pipelineRan ? cleanIssues : rawIssues;
  const prof   = pipelineRan ? cleanProfile : rawProfile;
  const lines  = [
    '# DATA QUALITY REPORT — CleanFlow',
    `Generated: ${new Date().toLocaleString()}`,
    `Dataset: ${rawData.length} original rows × ${headers.length} columns`,
    '',
    '## RAW DATA ISSUES',
    `- Missing / blank cells: ${rawIssues.totalMissing}`,
    `- Invalid numeric strings (N/A, unknown, etc.): ${rawIssues.totalInvalidNum}`,
    `- Exact duplicate rows: ${rawIssues.exactDupes}`,
    `- Key-field duplicates: ${rawIssues.keyDupes}`,
    `- Statistical / rule outliers: ${rawIssues.totalOutliers}`,
    `- Invalid email addresses: ${rawIssues.totalInvalidEmail}`,
    '',
    '## AFTER CLEANING',
    `- Clean rows: ${cleanData.length || 'Pipeline not run'}`,
    `- Remaining missing: ${issues.totalMissing}`,
    `- Remaining duplicates: ${issues.exactDupes + issues.keyDupes}`,
    `- Remaining outliers: ${issues.totalOutliers}`,
    `- Remaining invalid emails: ${issues.totalInvalidEmail}`,
    '',
    '## PIPELINE LOG',
    ...pipelineLog.map(l => `- [${l.step}] ${l.detail}`),
    '',
    '## COLUMN PROFILES (RAW)',
    ...headers.map(h => {
      const p = rawProfile[h];
      let line = `- ${h} (${p.type}): ${p.missing} missing, ${p.unique} unique`;
      if (p.type === 'numeric') line += `, mean=${p.mean?.toFixed(2)}, iqr_outliers=${p.iqrOutliers?.length||0}, rule_violations=${p.ruleViolations?.length||0}`;
      if (p.type === 'email')   line += `, invalid_emails=${p.emailStats?.invalid||0}`;
      return line;
    }),
  ];
  const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = 'cleanflow_report.txt'; a.click();
  URL.revokeObjectURL(url);
  showToast('Report exported!', 'success');
}

// ── Sample Data Generator ──────────────────────────────────
function generateSample() {
  const firstNames = ['Alice','Bob','Carol','David','Eve','Frank','Grace','Henry','Iris','Jack',
    'Kate','Liam','Mia','Noah','Olivia','Paul','Quinn','Ryan','Sara','Tom'];
  const lastNames  = ['Johnson','Smith','White','Brown','Davis','Miller','Lee','Wilson','Taylor','Anderson'];
  const depts      = ['Engineering','Marketing','Sales','HR','Finance','Operations','Support','engineering','  Marketing  ',''];
  const cities     = ['New York','Los Angeles','Chicago','Houston','Phoenix','Philadelphia','','Chicago','Los Angeles',''];
  const statuses   = ['Active','Inactive','Pending','active','INACTIVE','Active','Pending','Active','','Active'];
  const emails     = (i) => {
    const base = `user${i}@company.com`;
    if (i === 15)  return 'user15example.com';       // missing @
    if (i === 30)  return 'missing-domain@';          // missing domain
    if (i === 45)  return 'bad-email';                // no @ at all
    return base;
  };

  const rows = [];
  for (let i = 1; i <= 120; i++) {
    const isDupe = i > 90 && Math.random() < 0.15;
    const srcIdx = isDupe ? Math.floor(Math.random() * 90) : -1;
    const src    = srcIdx >= 0 ? rows[srcIdx] : null;

    let age    = src ? src.age    : Math.round(22 + Math.random() * 45);
    let salary = src ? src.salary : Math.round(30000 + Math.random() * 120000);
    let sat    = src ? src.satisfaction : Math.round(1 + Math.random() * 10);

    // Inject intentional issues
    if (i === 5)   age    = 3;           // business rule violation
    if (i === 10)  age    = 142;         // business rule violation
    if (i === 20)  salary = -5000;       // negative salary
    if (i === 25)  salary = 2500000;     // extreme outlier
    if (i === 35)  sat    = 99;          // out of range
    if (i === 40)  age    = '';          // blank
    if (i === 50)  salary = 'N/A';       // invalid numeric string
    if (i === 60)  age    = 'unknown';   // invalid numeric string
    if (i === 70)  sat    = null;        // null
    if (i === 75)  salary = '';          // blank
    if (i === 80)  age    = '';          // blank

    rows.push({
      customer_id:   src ? src.customer_id : `C${String(i).padStart(4,'0')}`,
      name:          `${firstNames[(i-1)%firstNames.length]} ${lastNames[(i-1)%lastNames.length]}`,
      age,
      department:    Math.random() < 0.07 ? '' : depts[(i-1) % depts.length],
      city:          Math.random() < 0.05 ? '' : cities[(i-1) % cities.length],
      salary,
      status:        statuses[(i-1) % statuses.length],
      email:         emails(i),
      signup_date:   `2021-${String(Math.floor(Math.random()*12)+1).padStart(2,'0')}-${String(Math.floor(Math.random()*28)+1).padStart(2,'0')}`,
      satisfaction:  sat,
    });
  }
  return rows;
}

// ── Setup ──────────────────────────────────────────────────
function setupUI() {
  document.getElementById('sidebarToggle').onclick = () => {
    document.getElementById('sidebar').classList.toggle('collapsed');
    document.getElementById('main').classList.toggle('collapsed');
  };

  const dz = document.getElementById('dropZoneMain');
  const fi = document.getElementById('fileInputMain');
  fi.onchange = e => {
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => { try { loadData(parseCsvText(ev.target.result)); } catch(er){ showToast(er.message,'error'); } };
    reader.readAsText(file);
  };
  dz.ondragover  = e => { e.preventDefault(); dz.classList.add('dragover'); };
  dz.ondragleave = () => dz.classList.remove('dragover');
  dz.ondrop      = e => {
    e.preventDefault(); dz.classList.remove('dragover');
    const file = e.dataTransfer.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => { try { loadData(parseCsvText(ev.target.result)); } catch(er){ showToast(er.message,'error'); } };
    reader.readAsText(file);
  };

  document.getElementById('btnSample').onclick       = () => loadData(generateSample());
  document.getElementById('btnRunPipeline').onclick  = runPipeline;
  document.getElementById('btnExport').onclick       = exportClean;
  document.getElementById('btnReport').onclick       = exportReport;
  document.getElementById('tableSearch').oninput     = () => { currentPage = 1; renderTable(tableData); };
}

// ── Init ───────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  Chart.defaults.color       = '#7a8499';
  Chart.defaults.borderColor = 'rgba(255,255,255,0.06)';
  Chart.defaults.font.family = "'Inter', sans-serif";
  setupUI();
  loadData(generateSample()); // auto-load sample on boot
});
