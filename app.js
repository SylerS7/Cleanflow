/* ============================================================
   APP.JS  — CleanFlow (Observability/Vercel Theme Rebuild)
   ============================================================ */

// ── Palette (Monochrome & Accents) ─────────────────────────
const COLORS = {
  primary: '#ededed',
  muted: '#333333',
  bg: '#000000',
  blue: '#0070f3',
  green: '#10b981',
  red: '#ef4444',
  amber: '#f5a623'
};

const NULL_STRINGS = new Set(['', 'null', 'none', 'n/a', 'na', 'unknown', '-', 'undefined', 'nan', 'nil', 'missing', '#n/a', '?']);

const BUSINESS_RULES = {
  age: { min: 0, max: 130, hard_min: 18, hard_max: 100 },
  satisfaction: { min: 1, max: 10 },
  score: { min: 0, max: 100 },
  salary: { min: 0 },
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/;

let rawData = [], cleanData = [], headers = [];
let rawProfile = {}, cleanProfile = {};
let rawIssues = {}, cleanIssues = {};
let currentView = 'before', currentPage = 1;
const PER_PAGE = 15;
let chartMap = {};
let tableData = [];
let pipelineRan = false;

// ── Utils ──────────────────────────────────────────────────
const fmtN = v => Number(v).toLocaleString();
const sleep = ms => new Promise(r => setTimeout(r, ms));

function isMissing(v) {
  if (v === null || v === undefined) return true;
  return NULL_STRINGS.has(String(v).trim().toLowerCase());
}

function showToast(msg, type = 'info') {
  const t = document.getElementById('toast');
  t.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="${type==='success'?'M8 12l3 3 5-6':'M12 8v4m0 4h.01'}"/></svg> ${msg}`;
  t.className = `toast ${type === 'success' ? 'toast-ok' : type === 'error' ? 'toast-err' : ''} show`;
  setTimeout(() => { t.className = 'toast'; }, 3000);
}
function destroyChart(id) {
  if (chartMap[id]) { chartMap[id].destroy(); delete chartMap[id]; }
}

// ── Type Detection ─────────────────────────────────────────
function detectType(colName, values) {
  const col = colName.toLowerCase();
  if (col.includes('email') || col.includes('mail')) return 'email';
  if (col === 'id' || col.endsWith('_id') || col.endsWith('id')) return 'id';
  const nonMissing = values.filter(v => !isMissing(v));
  if (!nonMissing.length) return 'string';
  const dateCount = nonMissing.filter(v => /^\d{4}-\d{2}-\d{2}/.test(String(v))).length;
  if (dateCount / nonMissing.length > 0.6) return 'date';
  const numCount = nonMissing.filter(v => {
    const n = parseFloat(String(v).replace(/[$,]/g, ''));
    return !isNaN(n) && isFinite(n);
  }).length;
  if (numCount / nonMissing.length > 0.75) return 'numeric';
  return 'string';
}

function validateEmails(values) {
  const nonMissing = values.filter(v => !isMissing(v));
  const invalid = nonMissing.filter(v => !EMAIL_RE.test(String(v).trim()));
  return { total: nonMissing.length, invalid: invalid.length };
}

// ── Profile ────────────────────────────────────────────────
function profileDataset(data) {
  const p = {};
  headers.forEach(col => {
    const vals = data.map(r => r[col]);
    const type = detectType(col, vals);
    const missing = vals.filter(v => isMissing(v)).length;
    const invalidNumeric = type === 'numeric'
      ? vals.filter(v => !isMissing(v) && isNaN(parseFloat(String(v)))).length : 0;
    const nonMissing = vals.filter(v => !isMissing(v));
    const unique = new Set(nonMissing.map(v => String(v).trim().toLowerCase())).size;

    let min, max, mean, iqrOutliers = [], ruleViolations = [];
    if (type === 'numeric') {
      const nums = nonMissing.map(v => parseFloat(String(v).replace(/[$,]/g, ''))).filter(n => !isNaN(n));
      if (nums.length) {
        min = Math.min(...nums); max = Math.max(...nums);
        mean = nums.reduce((s, n) => s + n, 0) / nums.length;
        const sorted = [...nums].sort((a,b)=>a-b);
        const q1 = sorted[Math.floor(sorted.length*0.25)], q3 = sorted[Math.floor(sorted.length*0.75)];
        const iqr = q3 - q1;
        iqrOutliers = nums.filter(n => n < q1 - 1.5*iqr || n > q3 + 1.5*iqr);
        const colKey = Object.keys(BUSINESS_RULES).find(k => col.toLowerCase().includes(k));
        if (colKey) {
          const r = BUSINESS_RULES[colKey];
          ruleViolations = nums.filter(n => (r.min!==undefined && n<r.min) || (r.max!==undefined && n>r.max));
        }
      }
    }
    let emailStats = type === 'email' ? validateEmails(vals) : null;
    const allOutlierVals = new Set([...iqrOutliers, ...ruleViolations]);
    p[col] = { type, missing, invalidNumeric, unique, min, max, mean, outlierCount: allOutlierVals.size, emailStats, total: vals.length };
  });
  return p;
}

function detectDuplicates(data) {
  const rowSeen = new Map(), exactDupeIdxs = [];
  data.forEach((r, i) => {
    const k = headers.map(h => String(r[h]??'').trim().toLowerCase()).join('\x00');
    rowSeen.has(k) ? exactDupeIdxs.push(i) : rowSeen.set(k, i);
  });
  const byField = {};
  headers.forEach(col => {
    const colL = col.toLowerCase();
    if (!colL.includes('id') && !colL.includes('email')) return;
    const seen = new Map(), dupeRows = [];
    data.forEach((r, i) => {
      const v = String(r[col]??'').trim().toLowerCase();
      if (!v || isMissing(r[col])) return;
      seen.has(v) ? dupeRows.push(i) : seen.set(v, i);
    });
    if (dupeRows.length) byField[col] = dupeRows;
  });
  return { exact: exactDupeIdxs, byField };
}

function summariseIssues(data, prof, dupes) {
  const missing = headers.reduce((s, c) => s + prof[c].missing + (prof[c].invalidNumeric||0), 0);
  const outliers = headers.reduce((s, c) => s + (prof[c].outlierCount||0), 0);
  const badEmails = headers.reduce((s, c) => s + (prof[c].emailStats?.invalid||0), 0);
  const exactDupes = dupes?.exact?.length || 0;
  const keyDupes = Object.values(dupes?.byField||{}).reduce((s, a) => s + a.length, 0);
  return { missing, outliers, badEmails, exactDupes, keyDupes };
}

function calcScore(data, issues) {
  if (!data.length || !headers.length) return 0;
  const cells = data.length * headers.length;
  const total = issues.missing + issues.exactDupes + (issues.outliers*0.5) + (issues.badEmails*0.75);
  return Math.max(0, Math.min(100, Math.round(100 - (total/cells)*100)));
}

// ── UI Updates ─────────────────────────────────────────────
function updateKPIs(score, issues, rows) {
  document.getElementById('scoreNum').textContent = score;
  const g = document.getElementById('scoreGrade');
  if (score >= 90) { g.textContent = 'EXCELLENT'; g.className = 'kpi-trend trend-good'; }
  else if (score >= 70) { g.textContent = 'ACCEPTABLE'; g.className = 'kpi-trend trend-neutral'; }
  else { g.textContent = 'NEEDS ATTENTION'; g.className = 'kpi-trend trend-bad'; }

  document.getElementById('kpiRows').textContent = fmtN(rows);
  document.getElementById('kpiCols').textContent = `${headers.length} attributes`;
  document.getElementById('kpiMissing').textContent = fmtN(issues.missing);
  document.getElementById('kpiMissingPct').textContent = issues.missing === 0 ? 'Clean' : 'Needs imputation';
  document.getElementById('kpiDupes').textContent = fmtN(issues.exactDupes + issues.keyDupes);
  document.getElementById('kpiDupesPct').textContent = issues.exactDupes === 0 && issues.keyDupes === 0 ? 'Clean' : 'Needs deduplication';
}

function setStep(id, state, detail) {
  const el = document.getElementById(id); if (!el) return;
  el.className = `pipeline-step step-${state}`;
  if (detail) document.getElementById(`${id}-detail`).textContent = detail;
}

// ── Pipeline ───────────────────────────────────────────────
async function runPipeline() {
  if (!rawData.length) return;
  document.getElementById('btnRunPipeline').disabled = true;
  let data = rawData.map(r => ({ ...r }));

  setStep('step-profile', 'active', 'Analyzing schema...'); await sleep(300);
  setStep('step-profile', 'complete', `${headers.length} cols`);
  
  setStep('step-missing', 'active', 'Imputing...'); await sleep(400);
  const p1 = profileDataset(data);
  headers.forEach(c => {
    data.forEach(r => {
      if (isMissing(r[c]) || (p1[c].type === 'numeric' && isNaN(parseFloat(String(r[c]))))) {
        r[c] = p1[c].type === 'numeric' && p1[c].mean ? p1[c].mean.toFixed(2) : 'N/A';
        r.__fixed = true;
      }
    });
  });
  setStep('step-missing', 'complete', 'Cleaned');
  
  setStep('step-dupes', 'active', 'Deduplicating...'); await sleep(300);
  const seen = new Set();
  data = data.filter(r => {
    const k = headers.map(h => String(r[h]??'').trim().toLowerCase()).join('\x00');
    if (seen.has(k)) return false; seen.add(k); return true;
  });
  setStep('step-dupes', 'complete', 'Deduplicated');

  setStep('step-outliers', 'active', 'Validating...'); await sleep(300);
  const p2 = profileDataset(data);
  data.forEach(r => {
    headers.forEach(c => {
      if (p2[c].type !== 'numeric') return;
      const n = parseFloat(String(r[c]??''));
      if (!isNaN(n) && (p2[c].iqrOutliers?.includes(n) || p2[c].ruleViolations?.includes(n))) {
        r.__outlier = r.__outlier || {}; r.__outlier[c] = true;
      }
    });
  });
  setStep('step-outliers', 'complete', 'Flagged');
  setStep('step-export', 'complete', 'Ready for Output');

  cleanData = data;
  cleanProfile = profileDataset(cleanData);
  cleanIssues = summariseIssues(cleanData, cleanProfile, detectDuplicates(cleanData));
  
  updateKPIs(calcScore(cleanData, cleanIssues), cleanIssues, cleanData.length);
  buildPostCharts(rawProfile, cleanProfile);
  buildProfilerCards(cleanProfile);
  
  document.getElementById('btnRunPipeline').disabled = false;
  document.getElementById('btnExport').disabled = false;
  document.getElementById('btnReport').disabled = false;
  
  pipelineRan = true;
  switchTab('after');
  showToast('Pipeline execution completed successfully.', 'success');
}

// ── Charts (Monochrome/Vercel styling) ─────────────────────
Chart.defaults.color = '#888888';
Chart.defaults.borderColor = '#333333';
Chart.defaults.font.family = "'Inter', sans-serif";

function buildRawCharts(prof) {
  destroyChart('missingChart');
  const missingCols = headers.filter(h => prof[h].missing > 0 || prof[h].invalidNumeric > 0);
  chartMap['missingChart'] = new Chart(document.getElementById('missingChart').getContext('2d'), {
    type: 'bar',
    data: {
      labels: missingCols.length ? missingCols : ['No issues'],
      datasets: [{
        label: 'Missing/Invalid',
        data: missingCols.length ? missingCols.map(h => prof[h].missing + (prof[h].invalidNumeric||0)) : [0],
        backgroundColor: '#ededed',
        borderRadius: 4, barPercentage: 0.5, maxBarThickness: 40
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: { x: { grid: { display: false } }, y: { beginAtZero: true, border: { display: false } } }
    }
  });
  buildTypeChart(prof);
}

function buildPostCharts(rProf, cProf) {
  destroyChart('missingChart');
  const cols = headers.filter(h => rProf[h].missing > 0 || rProf[h].invalidNumeric > 0);
  chartMap['missingChart'] = new Chart(document.getElementById('missingChart').getContext('2d'), {
    type: 'bar',
    data: {
      labels: cols.length ? cols : ['No issues'],
      datasets: [
        { label: 'Raw', data: cols.map(h => rProf[h].missing + (rProf[h].invalidNumeric||0)), backgroundColor: '#333333', borderRadius: 4, barPercentage: 0.8, maxBarThickness: 30 },
        { label: 'Processed', data: cols.map(h => cProf[h]?.missing||0), backgroundColor: '#ededed', borderRadius: 4, barPercentage: 0.8, maxBarThickness: 30 }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: 'top', labels: { usePointStyle: true, boxWidth: 6 } } },
      scales: { x: { grid: { display: false } }, y: { beginAtZero: true, border: { display: false } } }
    }
  });
  buildTypeChart(rProf);
}

function buildTypeChart(prof) {
  destroyChart('typeChart');
  const tc = { numeric:0, string:0, date:0, email:0, id:0 };
  headers.forEach(h => { tc[prof[h].type] = (tc[prof[h].type]||0)+1; });
  const labels = Object.keys(tc).filter(k => tc[k]>0);
  const colors = { numeric: '#ededed', string: '#333333', date: '#0070f3', email: '#f5a623', id: '#10b981' };
  document.getElementById('typeTotal').textContent = headers.length;
  chartMap['typeChart'] = new Chart(document.getElementById('typeChart').getContext('2d'), {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{ data: labels.map(k => tc[k]), backgroundColor: labels.map(k=>colors[k]), borderWidth: 0, hoverOffset: 4 }]
    },
    options: { cutout: '75%', responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'right', labels: { usePointStyle: true, boxWidth: 6 } } } }
  });
}

function buildProfilerCards(prof) {
  document.getElementById('profilerGrid').innerHTML = headers.map(col => {
    const p = prof[col];
    const q = Math.max(0, 100 - (p.missing/p.total)*100 - (p.invalidNumeric||0)/p.total*100);
    let st = `<div class="prof-stat"><span>Missing</span><span>${p.missing}</span></div>`;
    st += `<div class="prof-stat"><span>Unique</span><span>${p.unique}</span></div>`;
    if (p.type === 'numeric' && p.mean) {
      st += `<div class="prof-stat"><span>Mean</span><span>${p.mean.toFixed(2)}</span></div>`;
      st += `<div class="prof-stat ${p.outlierCount?'alert':''}"><span>Outliers</span><span>${p.outlierCount}</span></div>`;
    }
    if (p.type === 'email' && p.emailStats) {
      st += `<div class="prof-stat ${p.emailStats.invalid?'alert':''}"><span>Invalid</span><span>${p.emailStats.invalid}</span></div>`;
    }
    return `<div class="profiler-card">
      <div class="prof-top"><span class="prof-name">${col}</span><span class="prof-type">${p.type}</span></div>
      ${st}
      <div class="prof-bar-bg"><div class="prof-bar-fg" style="width:${q}%; background:${q>80?'#ededed':'#f5a623'}"></div></div>
    </div>`;
  }).join('');
}

// ── Table ──────────────────────────────────────────────────
window.switchTab = function(view) {
  currentView = view; tableData = view === 'before' ? rawData : cleanData;
  document.getElementById('tabBefore').className = `table-tab ${view==='before'?'active':''}`;
  document.getElementById('tabAfter').className = `table-tab ${view==='after'?'active':''}`;
  currentPage = 1; renderTable();
};

function renderTable() {
  const total = tableData.length;
  const pages = Math.max(1, Math.ceil(total / PER_PAGE));
  const pageRows = tableData.slice((currentPage-1)*PER_PAGE, currentPage*PER_PAGE);
  
  document.getElementById('tableHead').innerHTML = `<tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr>`;
  document.getElementById('tableBody').innerHTML = pageRows.map(r => `<tr>${headers.map(c => {
    const v = r[c], m = isMissing(v);
    let cls = m ? 'cell-null' : '';
    if (r.__outlier?.[c]) cls = 'cell-outlier';
    if (currentView === 'before' && rawProfile[c]?.type === 'email' && !m && !EMAIL_RE.test(String(v))) cls = 'cell-bad';
    return `<td class="${cls}">${m ? 'null' : v}</td>`;
  }).join('')}</tr>`).join('');
  
  document.getElementById('rowsInfo').textContent = `Page ${currentPage} of ${pages}`;
  document.getElementById('pagination').innerHTML = `
    <button class="page-btn" onclick="currentPage=Math.max(1,currentPage-1);renderTable()" ${currentPage===1?'disabled':''}>Prev</button>
    <button class="page-btn" onclick="currentPage=Math.min(${pages},currentPage+1);renderTable()" ${currentPage===pages?'disabled':''}>Next</button>
  `;
}

// ── Load ───────────────────────────────────────────────────
function loadData(rows) {
  rawData = rows; headers = Object.keys(rows[0]); cleanData = []; pipelineRan = false;
  document.getElementById('dashboardArea').classList.remove('hidden');
  document.getElementById('btnRunPipeline').disabled = false;
  document.getElementById('btnExport').disabled = true; document.getElementById('btnReport').disabled = true;
  
  ['step-profile','step-missing','step-dupes','step-outliers','step-export'].forEach(id => setStep(id, 'pending', 'Pending'));
  
  rawProfile = profileDataset(rawData);
  const dupes = detectDuplicates(rawData);
  rawIssues = summariseIssues(rawData, rawProfile, dupes);
  updateKPIs(calcScore(rawData, rawIssues), rawIssues, rawData.length);
  
  buildRawCharts(rawProfile);
  buildProfilerCards(rawProfile);
  switchTab('before');
  showToast(`Dataset parsed: ${headers.length} cols, ${rawData.length} rows.`);
}

function parseCsvText(text) {
  const res = Papa.parse(text.trim(), { header: true, skipEmptyLines: true });
  return res.data?.length ? res.data : [];
}

// ── Generate Sample ────────────────────────────────────────
function generateSample() {
  const fnames = ['Alice','Bob','Carol','David','Eve','Frank'];
  const depts = ['Engineering','Marketing','Sales','HR'];
  const rows = [];
  for (let i = 1; i <= 100; i++) {
    const age = (i===10)? 150 : (i===20)? '' : Math.round(22+Math.random()*40);
    const email = (i===5)? 'bad-email' : `user${i}@example.com`;
    rows.push({
      id: `USR-${i}`,
      name: fnames[i%fnames.length],
      age,
      department: (i===15)? '' : depts[i%depts.length],
      email,
      salary: (i===25)? -500 : (i===30)? 'N/A' : Math.round(50000+Math.random()*50000)
    });
  }
  return rows;
}

// ── Export ─────────────────────────────────────────────────
function exportData(data, filename) {
  const csv = [headers.join(','), ...data.map(r => headers.map(h => r[h]??'').join(','))].join('\n');
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv])); a.download = filename; a.click();
}

// ── Init ───────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('btnSample').onclick = () => loadData(generateSample());
  document.getElementById('btnRunPipeline').onclick = runPipeline;
  document.getElementById('btnExport').onclick = () => exportData(cleanData, 'processed_data.csv');
  
  const fi = document.getElementById('fileInputMain');
  fi.onchange = e => {
    const fr = new FileReader(); fr.onload = ev => loadData(parseCsvText(ev.target.result)); fr.readAsText(e.target.files[0]);
  };
  document.getElementById('btnBrowse').onclick = () => fi.click();
  const dz = document.getElementById('dropZoneMain');
  dz.ondragover = e => { e.preventDefault(); dz.style.borderColor = '#ededed'; };
  dz.ondragleave = () => dz.style.borderColor = '#333';
  dz.ondrop = e => {
    e.preventDefault(); dz.style.borderColor = '#333';
    const fr = new FileReader(); fr.onload = ev => loadData(parseCsvText(ev.target.result)); fr.readAsText(e.dataTransfer.files[0]);
  };
  loadData(generateSample()); // initial payload
});
