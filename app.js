/* ============================================================
   APP.JS  — CleanFlow v3 (Full Logic Rewrite)
   Pipeline flow: Upload → Profile RAW → Show issues → Clean → Profile CLEAN
   ============================================================ */

const COLORS = { blue:'#0070f3', green:'#10b981', red:'#ef4444', amber:'#f5a623', white:'#ededed', dim:'#333333' };

const NULL_STRINGS = new Set(['','null','none','n/a','na','unknown','-','undefined','nan','nil','missing','#n/a','?']);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/;

// Extended business rules: keyword → {min, max}
const BUSINESS_RULES = {
  age:            { min: 0,  max: 130 },
  attendance_pct: { min: 0,  max: 100 },
  attendance:     { min: 0,  max: 100 },
  math_score:     { min: 0,  max: 100 },
  science_score:  { min: 0,  max: 100 },
  english_score:  { min: 0,  max: 100 },
  score:          { min: 0,  max: 100 },
  satisfaction:   { min: 1,  max: 10  },
  salary:         { min: 0             },
  fees_paid:      { min: 0             },
  fees:           { min: 0             },
};

// Quality score penalty weights
const PENALTIES = {
  missing:    10,  // per % of cells that are missing
  duplicate:  10,  // flat if any exact dupes exist
  badEmail:    5,  // flat if any invalid emails
  ruleViolation: 10, // flat if any business rule violations
  iqrOutlier:  5,  // flat if any IQR outliers
};

let rawData = [], cleanData = [], headers = [];
let rawProfile = {}, cleanProfile = {};
let rawIssues = {}, rawDupes = {};
let currentView = 'before', currentPage = 1;
const PER_PAGE = 15;
let chartMap = {};
let tableData = [];
let pipelineRan = false;
let removedDupes = 0;

const fmtN = v => Number(v).toLocaleString();
const sleep = ms => new Promise(r => setTimeout(r, ms));

function isMissing(v) {
  if (v === null || v === undefined) return true;
  return NULL_STRINGS.has(String(v).trim().toLowerCase());
}

function showToast(msg, type='info') {
  const t = document.getElementById('toast');
  t.innerHTML = msg;
  t.className = `toast ${type==='success'?'toast-ok':type==='error'?'toast-err':''} show`;
  setTimeout(() => t.className='toast', 3500);
}

function destroyChart(id) {
  if (chartMap[id]) { chartMap[id].destroy(); delete chartMap[id]; }
}

// ── TYPE DETECTION (fixed) ────────────────────────────────
function detectType(colName, values) {
  const col = colName.trim().toLowerCase();

  // 1. Name-based semantic rules (highest priority)
  if (col.includes('email') || col.includes('mail')) return 'email';

  // ID: must be named like an ID AND have high uniqueness — NOT catch-all
  const isIdName = col === 'id' || /^(student|user|cust|emp|employee|product|order|record)_?id$/.test(col) || col.endsWith('_id');

  const nonMissing = values.filter(v => !isMissing(v));
  if (!nonMissing.length) return 'string';

  // Uniqueness ratio
  const uniqueVals = new Set(nonMissing.map(v => String(v).trim().toLowerCase()));
  const uniqueRatio = uniqueVals.size / nonMissing.length;

  // 2. Check for date patterns
  const dateCount = nonMissing.filter(v => /^\d{4}-\d{2}-\d{2}/.test(String(v))).length;
  if (dateCount / nonMissing.length > 0.6) return 'date';

  // 3. Numeric: only if > 80% parse cleanly AND not categorical-looking
  //    KEY FIX: check if values contain mixed alpha chars like "10-A", "11-B"
  const hasAlphaPattern = nonMissing.some(v => /\d+[-\/][A-Za-z]/.test(String(v)));
  if (hasAlphaPattern) return 'categorical';

  const numericVals = nonMissing.filter(v => {
    const cleaned = String(v).replace(/[$,₹€£]/g, '').trim();
    return cleaned !== '' && !isNaN(Number(cleaned));
  });
  const numRatio = numericVals.length / nonMissing.length;

  // 4. ID: numeric-looking + id-named + very high uniqueness
  if (isIdName && numRatio > 0.8 && uniqueRatio > 0.85) return 'id';

  // 5. Numeric (regular)
  if (numRatio > 0.8) return 'numeric';

  // 6. Categorical: low uniqueness string
  if (uniqueRatio < 0.15 && nonMissing.length > 5) return 'categorical';

  // 7. ID catch: purely alpha/string identifiers with id-like name + high uniqueness
  if (isIdName && uniqueRatio > 0.9) return 'id';

  return 'string';
}

function validateEmails(values) {
  const nonMissing = values.filter(v => !isMissing(v));
  const invalid = nonMissing.filter(v => !EMAIL_RE.test(String(v).trim()));
  return { total: nonMissing.length, invalid: invalid.length, invalidVals: new Set(invalid.map(v => String(v).trim())) };
}

// ── PROFILE ───────────────────────────────────────────────
function profileDataset(data) {
  const p = {};
  headers.forEach(col => {
    const vals = data.map(r => r[col]);
    const type = detectType(col, vals);
    const missing = vals.filter(v => isMissing(v)).length;

    // Invalid numerics: non-missing cells that can't be parsed as number, in a numeric column
    const invalidNumeric = type === 'numeric'
      ? vals.filter(v => !isMissing(v) && isNaN(Number(String(v).replace(/[$,₹€£]/g,'').trim()))).length
      : 0;

    const nonMissing = vals.filter(v => !isMissing(v));
    const unique = new Set(nonMissing.map(v => String(v).trim().toLowerCase())).size;

    let min, max, mean, median, iqrOutlierVals = [], ruleViolationVals = [];

    if (type === 'numeric') {
      const nums = nonMissing
        .map(v => Number(String(v).replace(/[$,₹€£]/g,'').trim()))
        .filter(n => !isNaN(n));

      if (nums.length) {
        const sorted = [...nums].sort((a,b) => a-b);
        min = sorted[0]; max = sorted[sorted.length-1];
        mean = nums.reduce((s,n) => s+n, 0) / nums.length;
        median = sorted[Math.floor(sorted.length/2)];

        // IQR outliers
        const q1 = sorted[Math.floor(sorted.length*0.25)];
        const q3 = sorted[Math.floor(sorted.length*0.75)];
        const iqr = q3 - q1;
        if (iqr > 0) iqrOutlierVals = nums.filter(n => n < q1-1.5*iqr || n > q3+1.5*iqr);

        // Business rule violations
        const colKey = Object.keys(BUSINESS_RULES).find(k => col.toLowerCase().includes(k));
        if (colKey) {
          const rule = BUSINESS_RULES[colKey];
          ruleViolationVals = nums.filter(n =>
            (rule.min !== undefined && n < rule.min) ||
            (rule.max !== undefined && n > rule.max)
          );
        }
      }
    }

    const emailStats = type === 'email' ? validateEmails(vals) : null;
    const outlierCount = new Set([...iqrOutlierVals, ...ruleViolationVals]).size;

    p[col] = {
      type, missing, invalidNumeric, unique,
      min, max, mean, median,
      outlierCount, iqrOutlierVals, ruleViolationVals, emailStats,
      total: vals.length
    };
  });
  return p;
}

function detectDuplicates(data) {
  const rowSeen = new Map();
  const exactDupeIdxs = [];
  data.forEach((r, i) => {
    const k = headers.map(h => String(r[h]??'').trim().toLowerCase()).join('\x00');
    rowSeen.has(k) ? exactDupeIdxs.push(i) : rowSeen.set(k, i);
  });
  return { exact: exactDupeIdxs, count: exactDupeIdxs.length };
}

function summariseIssues(data, prof, dupes) {
  const missing    = headers.reduce((s,c) => s + prof[c].missing + (prof[c].invalidNumeric||0), 0);
  const outliers   = headers.reduce((s,c) => s + (prof[c].outlierCount||0), 0);
  const ruleViols  = headers.reduce((s,c) => s + (prof[c].ruleViolationVals?.length||0), 0);
  const badEmails  = headers.reduce((s,c) => s + (prof[c].emailStats?.invalid||0), 0);
  const exactDupes = dupes?.count || 0;
  const total = missing + outliers + badEmails + exactDupes;
  return { missing, outliers, ruleViols, badEmails, exactDupes, total };
}

// ── QUALITY SCORE (Weighted, not cell-ratio) ──────────────
function calcScore(data, issues) {
  if (!data.length || !headers.length) return 0;
  const rows = data.length;
  let penalty = 0;

  // Missing: % of total cells that are missing/invalid
  const cells = rows * headers.length;
  const missingPct = (issues.missing / cells) * 100;
  penalty += Math.min(missingPct * 2, 25);  // up to 25pts penalty

  // Duplicates: flat 10 if any
  if (issues.exactDupes > 0) penalty += PENALTIES.duplicate;

  // Bad emails: flat 5 if any
  if (issues.badEmails > 0) penalty += PENALTIES.badEmail;

  // Business rule violations: up to 15
  if (issues.ruleViols > 0) {
    const rPct = (issues.ruleViols / rows) * 100;
    penalty += Math.min(rPct * 3, 15);
  }

  // IQR outliers: up to 10
  const pureOutliers = issues.outliers - issues.ruleViols;
  if (pureOutliers > 0) {
    const oPct = (pureOutliers / rows) * 100;
    penalty += Math.min(oPct * 2, 10);
  }

  return Math.max(0, Math.min(100, Math.round(100 - penalty)));
}

// ── KPI UPDATE ────────────────────────────────────────────
function updateRawKPIs(score, issues, rows) {
  // Score
  document.getElementById('scoreNum').textContent = score;
  const g = document.getElementById('scoreGrade');
  if (score >= 85)      { g.textContent = 'GOOD';           g.className = 'kpi-trend trend-good'; }
  else if (score >= 65) { g.textContent = 'NEEDS CLEANING'; g.className = 'kpi-trend trend-neutral'; }
  else                  { g.textContent = 'POOR';           g.className = 'kpi-trend trend-bad'; }

  // Label context: RAW
  document.getElementById('lblScore').textContent  = 'QUALITY SCORE';
  document.getElementById('lblRows').textContent   = 'RAW ROWS';
  document.getElementById('lblIssues').textContent = 'ISSUES FOUND';

  document.getElementById('kpiRows').textContent    = fmtN(rows);
  document.getElementById('kpiCols').textContent    = `${headers.length} attributes`;
  document.getElementById('kpiIssues').textContent  = fmtN(issues.total);
  document.getElementById('kpiIssuesSub').textContent = issues.total === 0 ? 'No issues found' : `${issues.missing} missing · ${issues.badEmails} bad email · ${issues.outliers} outliers`;
  document.getElementById('kpiDupes').textContent   = fmtN(issues.exactDupes);
  document.getElementById('kpiDupesSub').textContent = issues.exactDupes === 0 ? 'No duplicates' : 'Duplicate rows detected';
}

function updateCleanKPIs(score, rawIss, cleanIss, cleanRows) {
  document.getElementById('scoreNum').textContent = score;
  const g = document.getElementById('scoreGrade');
  if (score >= 90)      { g.textContent = 'EXCELLENT'; g.className = 'kpi-trend trend-good'; }
  else if (score >= 75) { g.textContent = 'GOOD';      g.className = 'kpi-trend trend-good'; }
  else                  { g.textContent = 'FAIR';       g.className = 'kpi-trend trend-neutral'; }

  document.getElementById('lblScore').textContent  = 'QUALITY SCORE';
  document.getElementById('lblRows').textContent   = 'CLEAN ROWS';
  document.getElementById('lblIssues').textContent = 'ISSUES RESOLVED';

  document.getElementById('kpiRows').textContent    = fmtN(cleanRows);
  document.getElementById('kpiCols').textContent    = `${headers.length} attributes`;
  const resolved = rawIss.total - cleanIss.total;
  document.getElementById('kpiIssues').textContent  = fmtN(resolved);
  document.getElementById('kpiIssuesSub').textContent = cleanIss.total === 0 ? 'All issues resolved ✓' : `${cleanIss.total} remaining`;
  document.getElementById('kpiDupes').textContent   = fmtN(removedDupes);
  document.getElementById('kpiDupesSub').textContent = removedDupes > 0 ? `${fmtN(cleanRows)} unique records` : 'No duplicates removed';
}

function setStep(id, state, detail) {
  const el = document.getElementById(id); if (!el) return;
  el.className = `pipeline-step step-${state}`;
  const det = document.getElementById(`${id}-detail`);
  if (det && detail) det.textContent = detail;
}

function resetSteps() {
  ['step-profile','step-missing','step-dupes','step-outliers','step-export'].forEach(id => {
    setStep(id, 'pending', 'Pending');
  });
}

// ── PIPELINE ──────────────────────────────────────────────
async function runPipeline() {
  if (!rawData.length) return;
  document.getElementById('btnRunPipeline').disabled = true;
  let data = rawData.map(r => ({ ...r }));

  // Step 1: Profile
  setStep('step-profile', 'active', 'Analyzing schema…'); await sleep(350);
  const p1 = profileDataset(data);
  setStep('step-profile', 'complete', `${headers.length} cols`);

  // Step 2: Impute missing values
  setStep('step-missing', 'active', 'Imputing…'); await sleep(400);
  let missingFixed = 0;
  headers.forEach(c => {
    data.forEach(r => {
      const isNum = p1[c].type === 'numeric';
      const needsFix = isMissing(r[c]) || (isNum && isNaN(Number(String(r[c]).replace(/[$,₹€£]/g,'').trim())));
      if (needsFix) {
        r[c] = isNum && p1[c].mean != null ? Number(p1[c].mean.toFixed(2)) : '';
        r.__fixed = true; missingFixed++;
      }
    });
  });
  setStep('step-missing', 'complete', `${missingFixed} cells fixed`);

  // Step 3: Deduplicate
  setStep('step-dupes', 'active', 'Deduplicating…'); await sleep(300);
  const beforeCount = data.length;
  const seenRows = new Set();
  data = data.filter(r => {
    const k = headers.map(h => String(r[h]??'').trim().toLowerCase()).join('\x00');
    if (seenRows.has(k)) return false; seenRows.add(k); return true;
  });
  removedDupes = beforeCount - data.length;
  setStep('step-dupes', 'complete', `${removedDupes} removed`);

  // Step 4: Validate / flag outliers
  setStep('step-outliers', 'active', 'Validating ranges…'); await sleep(350);
  const p2 = profileDataset(data);
  let flagged = 0;
  data.forEach(r => {
    headers.forEach(c => {
      if (p2[c].type !== 'numeric') return;
      const n = Number(String(r[c]??'').replace(/[$,₹€£]/g,'').trim());
      if (isNaN(n)) return;
      const isIQR  = p2[c].iqrOutlierVals?.includes(n);
      const isRule = p2[c].ruleViolationVals?.includes(n);
      if (isIQR || isRule) { r.__outlier = r.__outlier || {}; r.__outlier[c] = true; flagged++; }
    });
  });
  setStep('step-outliers', 'complete', `${flagged} flagged`);
  setStep('step-export', 'complete', 'Ready for output');

  // Final profiling of clean data
  cleanData = data;
  cleanProfile = profileDataset(cleanData);
  const cleanDupes = detectDuplicates(cleanData);
  cleanIssues = summariseIssues(cleanData, cleanProfile, cleanDupes);
  const cleanScore = calcScore(cleanData, cleanIssues);

  updateCleanKPIs(cleanScore, rawIssues, cleanIssues, cleanData.length);
  buildPostCharts(rawProfile, cleanProfile);
  buildProfilerCards(cleanProfile);

  document.getElementById('btnRunPipeline').disabled = false;
  document.getElementById('btnExport').disabled = false;
  document.getElementById('btnReport').disabled = false;

  pipelineRan = true;
  switchTab('after');
  showToast(`✓ Pipeline complete. ${missingFixed} cells fixed · ${removedDupes} dupes removed · ${flagged} outliers flagged.`, 'success');
}

// ── CHART DEFAULTS ────────────────────────────────────────
Chart.defaults.color = '#666666';
Chart.defaults.borderColor = '#222222';
Chart.defaults.font.family = "'Inter', sans-serif";

// ── RAW CHARTS ────────────────────────────────────────────
function buildRawCharts(prof) {
  destroyChart('missingChart');

  // Show ALL columns with their missing count (shows zeros too, for context)
  const hasMissing = headers.filter(h => prof[h].missing > 0 || prof[h].invalidNumeric > 0);

  document.getElementById('missingChartTitle').textContent = 'Data Health';
  document.getElementById('missingChartSub').textContent   = 'Missing values and invalid entries per column.';

  chartMap['missingChart'] = new Chart(
    document.getElementById('missingChart').getContext('2d'), {
    type: 'bar',
    data: {
      labels: hasMissing.length ? hasMissing : ['(none)'],
      datasets: [{
        label: 'Missing / Invalid',
        data: hasMissing.length ? hasMissing.map(h => prof[h].missing + (prof[h].invalidNumeric||0)) : [0],
        backgroundColor: hasMissing.map(h => {
          const pct = (prof[h].missing + (prof[h].invalidNumeric||0)) / prof[h].total;
          return pct > 0.1 ? 'rgba(239,68,68,0.7)' : 'rgba(245,166,35,0.7)';
        }),
        borderRadius: 4, maxBarThickness: 40
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: { x: { grid:{display:false} }, y: { beginAtZero:true, border:{display:false} } }
    }
  });

  buildTypeChart(prof);
}

// ── POST PIPELINE CHARTS ──────────────────────────────────
function buildPostCharts(rProf, cProf) {
  destroyChart('missingChart');
  const cols = headers.filter(h => rProf[h].missing > 0 || rProf[h].invalidNumeric > 0);
  document.getElementById('missingChartTitle').textContent = 'Before vs After';
  document.getElementById('missingChartSub').textContent   = 'Missing / invalid cells resolved by pipeline.';

  chartMap['missingChart'] = new Chart(
    document.getElementById('missingChart').getContext('2d'), {
    type: 'bar',
    data: {
      labels: cols.length ? cols : ['None'],
      datasets: [
        { label: 'Raw',       data: cols.map(h => rProf[h].missing+(rProf[h].invalidNumeric||0)),
          backgroundColor:'rgba(239,68,68,0.7)', borderRadius:4, maxBarThickness:20 },
        { label: 'Processed', data: cols.map(h => (cProf[h]?.missing||0)),
          backgroundColor:'rgba(16,185,129,0.7)', borderRadius:4, maxBarThickness:20 }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend:{ position:'top', labels:{ usePointStyle:true, boxWidth:6 } } },
      scales: { x: { grid:{display:false} }, y: { beginAtZero:true, border:{display:false} } }
    }
  });

  buildTypeChart(rProf);
}

// ── TYPE DONUT ────────────────────────────────────────────
function buildTypeChart(prof) {
  destroyChart('typeChart');
  const tc = {};
  headers.forEach(h => { tc[prof[h].type] = (tc[prof[h].type]||0)+1; });
  const labels = Object.keys(tc);
  const palette = { numeric:'#ededed', string:'#555555', date:'#0070f3', email:'#f5a623', id:'#10b981', categorical:'#a78bfa' };
  document.getElementById('typeTotal').textContent = headers.length;
  chartMap['typeChart'] = new Chart(
    document.getElementById('typeChart').getContext('2d'), {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{ data: labels.map(k=>tc[k]), backgroundColor: labels.map(k=>palette[k]||'#444'), borderWidth:0, hoverOffset:4 }]
    },
    options: {
      cutout:'72%', responsive:true, maintainAspectRatio:false,
      plugins: { legend:{ position:'right', labels:{ usePointStyle:true, boxWidth:6, font:{size:11} } } }
    }
  });
}

// ── PROFILER CARDS ────────────────────────────────────────
function buildProfilerCards(prof) {
  const typeColors = { numeric:'#ededed', string:'#555', date:'#0070f3', email:'#f5a623', id:'#10b981', categorical:'#a78bfa' };
  document.getElementById('profilerGrid').innerHTML = headers.map(col => {
    const p = prof[col];
    const q = Math.max(0, 100 - (p.missing/p.total)*100 - (p.invalidNumeric||0)/p.total*100 - (p.outlierCount||0)/p.total*50);
    const qColor = q >= 80 ? '#10b981' : q >= 50 ? '#f5a623' : '#ef4444';
    let stats = '';

    stats += `<div class="prof-stat"><span>Total</span><span>${p.total}</span></div>`;
    stats += `<div class="prof-stat ${p.missing>0?'alert':''}"><span>Missing</span><span>${p.missing}</span></div>`;
    stats += `<div class="prof-stat"><span>Unique</span><span>${p.unique}</span></div>`;

    if (p.type === 'numeric') {
      if (p.min !== undefined) stats += `<div class="prof-stat"><span>Min / Max</span><span>${p.min} / ${p.max}</span></div>`;
      if (p.mean !== undefined) stats += `<div class="prof-stat"><span>Mean</span><span>${p.mean.toFixed(2)}</span></div>`;
      if (p.outlierCount > 0) stats += `<div class="prof-stat alert"><span>Outliers</span><span>${p.outlierCount}</span></div>`;
      if (p.ruleViolationVals?.length > 0) stats += `<div class="prof-stat alert"><span>Rule violations</span><span>${p.ruleViolationVals.length}</span></div>`;
    }
    if (p.type === 'email' && p.emailStats) {
      stats += `<div class="prof-stat ${p.emailStats.invalid>0?'alert':''}"><span>Invalid emails</span><span>${p.emailStats.invalid}</span></div>`;
    }

    return `<div class="profiler-card">
      <div class="prof-top">
        <span class="prof-name">${col}</span>
        <span class="prof-type" style="color:${typeColors[p.type]||'#888'}">${p.type}</span>
      </div>
      ${stats}
      <div class="prof-bar-bg" title="Quality: ${Math.round(q)}%">
        <div class="prof-bar-fg" style="width:${q}%; background:${qColor}"></div>
      </div>
    </div>`;
  }).join('');
}

// ── TABLE ─────────────────────────────────────────────────
window.switchTab = function(view) {
  currentView = view;
  tableData = view === 'before' ? rawData : cleanData;
  document.getElementById('tabBefore').className = `table-tab ${view==='before'?'active':''}`;
  document.getElementById('tabAfter').className  = `table-tab ${view==='after'?'active':''}`;
  currentPage = 1; renderTable();
};

function renderTable() {
  const total = tableData.length;
  const pages = Math.max(1, Math.ceil(total / PER_PAGE));
  const pageRows = tableData.slice((currentPage-1)*PER_PAGE, currentPage*PER_PAGE);

  document.getElementById('tableHead').innerHTML =
    `<tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr>`;

  document.getElementById('tableBody').innerHTML = pageRows.map(r => `<tr>${
    headers.map(c => {
      const v = r[c];
      const missing = isMissing(v);
      let cls = '';
      if (missing) cls = 'cell-null';
      else if (r.__outlier?.[c]) cls = 'cell-outlier';
      else if (currentView === 'before' && rawProfile[c]?.type === 'email' && !EMAIL_RE.test(String(v))) cls = 'cell-bad';
      return `<td class="${cls}">${missing ? '∅ null' : v}</td>`;
    }).join('')
  }</tr>`).join('');

  document.getElementById('rowsInfo').textContent = `Page ${currentPage} of ${pages} · ${total} rows`;
  document.getElementById('pagination').innerHTML = `
    <button class="page-btn" onclick="currentPage=Math.max(1,currentPage-1);renderTable()" ${currentPage===1?'disabled':''}>←</button>
    <button class="page-btn" onclick="currentPage=Math.min(${pages},currentPage+1);renderTable()" ${currentPage===pages?'disabled':''}>→</button>
  `;
}

// ── LOAD ──────────────────────────────────────────────────
function loadData(rows, filename = 'dataset.csv') {
  if (!rows || !rows.length) { showToast('No data found in file.', 'error'); return; }
  rawData = rows; headers = Object.keys(rows[0]); cleanData = []; pipelineRan = false; removedDupes = 0;

  // Hide upload zone, show dashboard
  document.getElementById('uploadSection').classList.add('hidden');
  document.getElementById('dashboardArea').classList.remove('hidden');
  document.getElementById('btnUploadNew').classList.remove('hidden');

  // Topbar filename
  document.getElementById('fileSeparator').classList.remove('hidden');
  const fnEl = document.getElementById('fileName');
  fnEl.textContent = filename; fnEl.classList.remove('hidden');

  // Reset buttons & steps
  document.getElementById('btnRunPipeline').disabled = false;
  document.getElementById('btnExport').disabled = true;
  document.getElementById('btnReport').disabled = true;
  resetSteps();

  // ⬇ Profile RAW data FIRST — do not clean yet
  rawProfile = profileDataset(rawData);
  rawDupes   = detectDuplicates(rawData);
  rawIssues  = summariseIssues(rawData, rawProfile, rawDupes);
  const rawScore = calcScore(rawData, rawIssues);

  // Show raw KPIs
  updateRawKPIs(rawScore, rawIssues, rawData.length);

  // Build raw charts
  buildRawCharts(rawProfile);
  buildProfilerCards(rawProfile);
  switchTab('before');

  showToast(`Loaded ${filename} · ${rawData.length} rows · ${headers.length} cols · score: ${rawScore}`);
}

function parseCsvText(text) {
  const res = Papa.parse(text.trim(), { header:true, skipEmptyLines:true, dynamicTyping: false });
  return res.data?.length ? res.data : [];
}

// ── SAMPLE DATA ────────────────────────────────────────────
function generateSample() {
  const names = ['Alice','Bob','Carol','David','Eve','Frank','Grace','Hank','Iris','Jack'];
  const depts = ['Engineering','Marketing','Sales','HR'];
  const rows = [];
  for (let i=1; i<=100; i++) {
    const age = i===5 ? 999 : i===10 ? '' : 22 + Math.round(Math.random()*35);
    const email = i===3 ? 'not-an-email' : i===7 ? '' : `user${i}@example.com`;
    rows.push({
      id: `USR-${String(i).padStart(3,'0')}`,
      name: i===20 ? '' : names[i%names.length],
      age, department: i===15 ? '' : depts[i%depts.length],
      email, salary: i===25 ? -5000 : Math.round(50000+Math.random()*60000)
    });
  }
  // Add exact duplicates
  rows.push({...rows[0]}, {...rows[1]});
  return rows;
}

// ── EXPORT ────────────────────────────────────────────────
function exportData(data, filename) {
  const csv = [headers.join(','), ...data.map(r => headers.map(h => `"${String(r[h]??'').replace(/"/g,'""')}"`).join(','))].join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], {type:'text/csv'}));
  a.download = filename; a.click();
}

// ── INIT ──────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('btnSample').onclick       = () => loadData(generateSample(), 'sample_dataset.csv');
  document.getElementById('btnRunPipeline').onclick  = runPipeline;
  document.getElementById('btnExport').onclick       = () => exportData(cleanData, 'cleanflow_output.csv');

  const handleFile = file => {
    if (!file) return;
    const fr = new FileReader();
    fr.onload = ev => loadData(parseCsvText(ev.target.result), file.name);
    fr.readAsText(file);
  };

  const fi = document.getElementById('fileInputMain');
  fi.onchange = e => handleFile(e.target.files[0]);
  document.getElementById('btnBrowse').onclick = () => fi.click();

  const fiNew = document.getElementById('fileInputNew');
  fiNew.onchange = e => handleFile(e.target.files[0]);
  document.getElementById('btnUploadNew').onclick = () => fiNew.click();

  const dz = document.getElementById('dropZoneMain');
  dz.ondragover = e => { e.preventDefault(); dz.style.borderColor='#ededed'; };
  dz.ondragleave = () => dz.style.borderColor='#333';
  dz.ondrop = e => { e.preventDefault(); dz.style.borderColor='#333'; handleFile(e.dataTransfer.files[0]); };
});
