/* ============================================================
   APP.JS  — Data Cleaning & Reporting Automation
   ============================================================ */

// ── Palette ────────────────────────────────────────────────
const COLORS = {
  amber:  '#f59e0b', amber2: '#fcd34d',
  cyan:   '#22d3ee', cyan2:  '#67e8f9',
  green:  '#22c55e', red:    '#f43f5e',
  orange: '#fb923c', purple: '#a78bfa',
};

// ── State ──────────────────────────────────────────────────
let rawData     = [];   // parsed rows as-is
let cleanData   = [];   // rows after cleaning
let headers     = [];   // column names
let profile     = {};   // per-column stats
let pipelineLog = [];   // steps log
let currentView = 'before';
let currentPage = 1;
const PER_PAGE  = 12;
let chartMap    = {};
let tableData   = [];

// ── Utils ──────────────────────────────────────────────────
const fmtN  = v => Number(v).toLocaleString();
const fmtPct= (a,b) => b ? ((a/b)*100).toFixed(1)+'%' : '0%';

function showToast(msg, type='info') {
  const t = document.getElementById('toast');
  t.textContent = msg; t.className = `toast ${type} show`;
  setTimeout(() => { t.className = 'toast'; }, 3200);
}
function destroyChart(id) {
  if (chartMap[id]) { chartMap[id].destroy(); delete chartMap[id]; }
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Sample Data Generator ──────────────────────────────────
function generateSample() {
  const names   = ['Alice Johnson','Bob Smith','Carol White','David Brown','Eve Davis',
    'Frank Miller','Grace Lee','Henry Wilson','Iris Taylor','Jack Anderson',
    'Kate Thomas','Liam Martin','Mia Garcia','Noah Martinez','Olivia Robinson',
    'Paul Jackson','Quinn Harris','Ryan Lewis','Sara Walker','Tom Hall'];
  const depts   = ['Engineering','Marketing','Sales','HR','Finance','Operations','Support','','engineering','  Marketing  '];
  const cities  = ['New York','Los Angeles','Chicago','Houston','Phoenix','Philadelphia','San Antonio','','Chicago','Los Angeles'];
  const statuses= ['Active','Inactive','Pending','active','INACTIVE','Active','Pending','Active','','Active'];

  const rows = [];
  for (let i = 0; i < 120; i++) {
    const isDupe = i > 80 && Math.random() < 0.12;
    const baseRow = isDupe ? rows[Math.floor(Math.random()*80)] : null;

    const salary = baseRow ? baseRow.salary : Math.round(30000 + Math.random()*120000);
    const age    = baseRow ? baseRow.age    : Math.round(22 + Math.random()*45);

    rows.push({
      id:         isDupe ? baseRow.id : `EMP${String(i+1).padStart(4,'0')}`,
      name:       isDupe ? baseRow.name  : names[i % names.length] + (i >= names.length ? ` ${Math.floor(i/names.length)+1}` : ''),
      age:        Math.random() < 0.06 ? '' : (Math.random() < 0.04 ? 999 : age),
      department: Math.random() < 0.07 ? '' : depts[i % depts.length],
      city:       Math.random() < 0.05 ? '' : cities[i % cities.length],
      salary:     Math.random() < 0.05 ? '' : (Math.random() < 0.03 ? -500 : salary),
      status:     Math.random() < 0.04 ? '' : statuses[i % statuses.length],
      joined:     Math.random() < 0.04 ? '' : `${2015 + Math.floor(Math.random()*9)}-${String(Math.floor(Math.random()*12)+1).padStart(2,'0')}-${String(Math.floor(Math.random()*28)+1).padStart(2,'0')}`,
      score:      Math.random() < 0.08 ? '' : Math.round(Math.random()*100),
    });
  }
  return rows;
}

// ── Column Type Detection ──────────────────────────────────
function detectType(values) {
  const nonEmpty = values.filter(v => v !== '' && v !== null && v !== undefined);
  if (!nonEmpty.length) return 'string';
  const numericCount = nonEmpty.filter(v => !isNaN(parseFloat(v)) && isFinite(v)).length;
  if (numericCount / nonEmpty.length > 0.75) return 'numeric';
  return 'string';
}

// ── Profile Dataset ────────────────────────────────────────
function profileDataset(data) {
  const p = {};
  headers.forEach(col => {
    const vals   = data.map(r => r[col]);
    const nonEmpty = vals.filter(v => v !== '' && v !== null && v !== undefined && String(v).trim() !== '');
    const missing  = vals.length - nonEmpty.length;
    const type     = detectType(vals);
    const unique   = new Set(nonEmpty.map(v => String(v).trim().toLowerCase())).size;

    let min, max, mean, median, outliers = [];
    if (type === 'numeric') {
      const nums = nonEmpty.map(v => parseFloat(v)).filter(n => !isNaN(n));
      if (nums.length) {
        min  = Math.min(...nums);
        max  = Math.max(...nums);
        mean = nums.reduce((s,n)=>s+n,0)/nums.length;
        const sorted = [...nums].sort((a,b)=>a-b);
        median = sorted.length % 2 === 0
          ? (sorted[sorted.length/2-1] + sorted[sorted.length/2]) / 2
          : sorted[Math.floor(sorted.length/2)];
        // IQR outlier detection
        const q1 = sorted[Math.floor(sorted.length*0.25)];
        const q3 = sorted[Math.floor(sorted.length*0.75)];
        const iqr = q3 - q1;
        outliers = nums.filter(n => n < q1 - 1.5*iqr || n > q3 + 1.5*iqr);
      }
    }

    p[col] = { type, missing, unique, min, max, mean, median, outliers, total: vals.length };
  });
  return p;
}

// ── Quality Score ──────────────────────────────────────────
function calcQualityScore(data, prof) {
  if (!data.length) return 0;
  const totalCells = data.length * headers.length;
  let issues = 0;
  headers.forEach(col => {
    issues += prof[col].missing;
    if (prof[col].type === 'numeric') issues += prof[col].outliers.length * 0.5;
  });
  // Duplicate penalty
  const dupeCount = detectDupes(data).length;
  issues += dupeCount;
  const score = Math.max(0, Math.min(100, 100 - (issues / totalCells) * 100));
  return Math.round(score);
}

// ── Duplicate Detection ────────────────────────────────────
function detectDupes(data) {
  const seen = new Set(); const dupeIdxs = [];
  data.forEach((row, i) => {
    const key = headers.map(h => String(row[h]||'').trim().toLowerCase()).join('|');
    if (seen.has(key)) dupeIdxs.push(i);
    else seen.add(key);
  });
  return dupeIdxs;
}

// ── Main Cleaning Pipeline ─────────────────────────────────
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

  // Deep clone
  let data = rawData.map(r => ({...r}));

  // ── Step 1: Profile ──────────────────────────
  setStep('step-profile', 'active', 'Profiling…');
  await sleep(400);
  profile = profileDataset(data);
  const totalMissing = headers.reduce((s,c)=>s+profile[c].missing,0);
  setStep('step-profile', 'complete', `${fmtN(totalMissing)} issues found`);
  activateConnector('conn-2');
  pipelineLog.push({ step:'Profile', detail:`${totalMissing} missing cells, ${detectDupes(data).length} dupes` });

  // ── Step 2: Missing Values ───────────────────
  setStep('step-missing', 'active', 'Processing…');
  await sleep(500);
  let missingFixed = 0;
  if (opts.missing) {
    headers.forEach(col => {
      if (!profile[col].missing) return;
      if (opts.strategy === 'drop') {
        data = data.filter(r => r[col] !== '' && r[col] !== null && r[col] !== undefined && String(r[col]).trim() !== '');
      } else {
        const fill = opts.strategy === 'mean'   ? profile[col].mean?.toFixed(2)
                   : opts.strategy === 'median' ? profile[col].median?.toFixed(2)
                   : opts.strategy === 'zero'   ? '0'
                   : opts.strategy === 'mode'   ? getMode(rawData.map(r=>r[col]))
                   : null;
        data.forEach(r => {
          if (r[col] === '' || r[col] === null || r[col] === undefined || String(r[col]).trim() === '') {
            r[col] = fill ?? 'N/A'; r.__fixed = true; missingFixed++;
          }
        });
      }
    });
  }
  setStep('step-missing', 'complete', `${missingFixed} cells fixed`);
  activateConnector('conn-3');
  pipelineLog.push({ step:'Missing Values', detail:`Fixed ${missingFixed} cells (strategy: ${opts.strategy})` });

  // ── Step 3: Duplicates ───────────────────────
  setStep('step-dupes', 'active', 'Scanning…');
  await sleep(400);
  let dupesRemoved = 0;
  if (opts.dupes) {
    const before = data.length;
    const seen = new Set();
    data = data.filter(row => {
      const key = headers.map(h=>String(row[h]||'').trim().toLowerCase()).join('|');
      if (seen.has(key)) return false;
      seen.add(key); return true;
    });
    dupesRemoved = before - data.length;
  }
  setStep('step-dupes', 'complete', `${dupesRemoved} removed`);
  activateConnector('conn-4');
  pipelineLog.push({ step:'Duplicates', detail:`Removed ${dupesRemoved} duplicate rows` });

  // ── Step 4: Normalize ────────────────────────
  setStep('step-normalize', 'active', 'Normalizing…');
  await sleep(400);
  let normFixed = 0;
  data.forEach(row => {
    headers.forEach(col => {
      if (typeof row[col] !== 'string') return;
      let v = row[col];
      if (opts.whitespace && v !== v.trim()) { v = v.trim(); normFixed++; }
      if (opts.caseNorm && v && profile[col].type === 'string') {
        const proper = v.charAt(0).toUpperCase() + v.slice(1).toLowerCase();
        if (proper !== v) { v = proper; normFixed++; }
      }
      row[col] = v;
    });
  });
  setStep('step-normalize', 'complete', `${normFixed} cells normalized`);
  activateConnector('conn-5');
  pipelineLog.push({ step:'Normalize', detail:`${normFixed} text values normalized` });

  // ── Step 5: Outliers ─────────────────────────
  setStep('step-outliers', 'active', 'Detecting…');
  await sleep(400);
  let outliersFlagged = 0;
  if (opts.outliers) {
    const freshProfile = profileDataset(data);
    data.forEach(row => {
      headers.forEach(col => {
        if (freshProfile[col].type !== 'numeric') return;
        const n = parseFloat(row[col]);
        if (isNaN(n)) return;
        const { min:_m, max:_x, mean, outliers: ol } = freshProfile[col];
        const sorted = rawData.map(r=>parseFloat(r[col])).filter(v=>!isNaN(v)).sort((a,b)=>a-b);
        const q1 = sorted[Math.floor(sorted.length*0.25)];
        const q3 = sorted[Math.floor(sorted.length*0.75)];
        const iqr = q3-q1;
        if (n < q1-1.5*iqr || n > q3+1.5*iqr) { row.__outlier = row.__outlier || {}; row.__outlier[col] = true; outliersFlagged++; }
      });
    });
  }
  setStep('step-outliers', 'complete', `${outliersFlagged} flagged`);
  activateConnector('conn-6');
  pipelineLog.push({ step:'Outliers', detail:`Flagged ${outliersFlagged} outlier values` });

  // ── Step 6: Done ─────────────────────────────
  setStep('step-export', 'complete', `${fmtN(data.length)} clean rows`);
  pipelineLog.push({ step:'Clean Export', detail:`${data.length} rows ready` });

  cleanData = data;
  const cleanProfile = profileDataset(cleanData);
  const score = calcQualityScore(cleanData, cleanProfile);

  updateKPIs(score, totalMissing, dupesRemoved, cleanProfile);
  buildCharts(totalMissing, cleanProfile, { missingFixed, dupesRemoved, normFixed, outliersFlagged });
  buildProfilerCards(cleanProfile);
  buildReport(score, totalMissing, dupesRemoved, normFixed, outliersFlagged, cleanProfile);

  tableData = currentView === 'before' ? rawData : cleanData;
  currentPage = 1;
  renderTable(tableData);

  document.getElementById('btnRunPipeline').disabled = false;
  document.getElementById('btnExport').disabled = false;
  document.getElementById('btnReport').disabled = false;

  showToast(`Pipeline complete — ${data.length} clean rows ready!`, 'success');
}

function getMode(vals) {
  const freq = {};
  vals.filter(v=>v!==''&&v!=null).forEach(v=>{ freq[v]=(freq[v]||0)+1; });
  return Object.entries(freq).sort((a,b)=>b[1]-a[1])[0]?.[0] ?? '';
}

// ── Pipeline Step UI ───────────────────────────────────────
function setStep(id, state, detail) {
  const el   = document.getElementById(id);
  const icon = el.querySelector('.step-icon');
  const det  = document.getElementById(`${id}-detail`);
  icon.className = 'step-icon step-icon--' + (state==='active'?'active':state==='complete'?'complete':'done');
  if (det) det.textContent = detail;
}
function activateConnector(id) {
  const el = document.getElementById(id);
  if (el) el.classList.add('done');
}

// ── Update KPIs ────────────────────────────────────────────
function updateKPIs(score, totalMissing, dupes, prof) {
  // Score ring
  const circumference = 2 * Math.PI * 34; // r=34 → 213.6
  const fill = document.getElementById('scoreRingFill');
  const offset = circumference * (1 - score/100);
  fill.style.strokeDashoffset = offset;
  fill.style.stroke = score >= 80 ? COLORS.green : score >= 50 ? COLORS.amber : COLORS.red;
  document.getElementById('scoreNum').textContent = score;
  const grade = score >= 90 ? 'Excellent' : score >= 75 ? 'Good' : score >= 50 ? 'Fair' : 'Poor';
  document.getElementById('scoreGrade').textContent = grade + ' Quality';

  document.getElementById('kpiMissing').textContent = fmtN(totalMissing);
  document.getElementById('kpiMissingPct').textContent = `across ${headers.length} columns`;

  document.getElementById('kpiDupes').textContent = fmtN(dupes);
  document.getElementById('kpiDupesPct').textContent = dupes === 0 ? 'No duplicates found' : 'duplicate rows removed';

  document.getElementById('kpiRows').textContent = fmtN(rawData.length);
  document.getElementById('kpiCols').textContent = `${headers.length} columns detected`;

  document.getElementById('kpiCleanRows').textContent = fmtN(cleanData.length);
  const fixed = rawData.length - cleanData.length + totalMissing;
  document.getElementById('kpiFixed').textContent = `${fmtN(fixed)} issues resolved`;
}

// ── Charts ─────────────────────────────────────────────────
function buildCharts(totalMissing, prof, fixes) {
  // Missing Values per Column
  destroyChart('missingChart');
  const missingCols = headers.map(h=>({ col:h, missing:prof[h].missing })).filter(x=>x.missing>0);
  const ctx1 = document.getElementById('missingChart').getContext('2d');
  chartMap['missingChart'] = new Chart(ctx1, {
    type: 'bar',
    data: {
      labels: missingCols.map(x=>x.col),
      datasets: [{
        label: 'Missing',
        data: missingCols.map(x=>x.missing),
        backgroundColor: COLORS.amber + '99',
        borderColor: COLORS.amber,
        borderWidth: 1.5,
        borderRadius: 5,
        borderSkipped: false,
      }]
    },
    options: {
      responsive:true, animation:{duration:600},
      plugins:{ legend:{display:false}, tooltip:{ backgroundColor:'rgba(12,14,24,0.97)', borderColor:'rgba(255,255,255,0.1)', borderWidth:1, padding:10 }},
      scales:{ x:{ grid:{display:false}, ticks:{font:{size:10}} }, y:{ grid:{color:'rgba(255,255,255,0.05)'}, ticks:{font:{size:10}} }}
    }
  });

  // Type Distribution Donut
  destroyChart('typeChart');
  const typeCounts = { numeric:0, string:0 };
  headers.forEach(h => { typeCounts[prof[h].type] = (typeCounts[prof[h].type]||0)+1; });
  document.getElementById('typeTotal').textContent = headers.length;
  const ctx2 = document.getElementById('typeChart').getContext('2d');
  chartMap['typeChart'] = new Chart(ctx2, {
    type:'doughnut',
    data:{
      labels:['Numeric','Text'],
      datasets:[{ data:[typeCounts.numeric||0, typeCounts.string||0],
        backgroundColor:[COLORS.amber+'bb', COLORS.cyan+'bb'],
        borderColor:[COLORS.amber, COLORS.cyan],
        borderWidth:2, borderRadius:4, hoverBorderWidth:0 }]
    },
    options:{
      cutout:'65%', responsive:true, animation:{duration:700},
      plugins:{ legend:{position:'bottom', labels:{usePointStyle:true,pointStyle:'circle',padding:14,font:{size:11}}},
        tooltip:{ backgroundColor:'rgba(12,14,24,0.97)', borderColor:'rgba(255,255,255,0.1)', borderWidth:1, padding:10 }}
    }
  });

  // Issues Fixed by Stage
  destroyChart('fixChart');
  const fixLabels = ['Missing Values','Duplicates','Normalization','Outliers'];
  const fixVals   = [fixes.missingFixed, fixes.dupesRemoved, fixes.normFixed, fixes.outliersFlagged];
  const ctx3 = document.getElementById('fixChart').getContext('2d');
  const g = ctx3.createLinearGradient(0,0,0,240);
  g.addColorStop(0, COLORS.cyan+'bb'); g.addColorStop(1, COLORS.amber+'66');
  chartMap['fixChart'] = new Chart(ctx3, {
    type:'bar',
    data:{
      labels:fixLabels,
      datasets:[{ label:'Issues Fixed', data:fixVals,
        backgroundColor:[COLORS.amber+'99',COLORS.red+'99',COLORS.cyan+'99',COLORS.orange+'99'],
        borderColor:[COLORS.amber,COLORS.red,COLORS.cyan,COLORS.orange],
        borderWidth:1.5, borderRadius:5, borderSkipped:false }]
    },
    options:{
      responsive:true, animation:{duration:600},
      plugins:{ legend:{display:false}, tooltip:{ backgroundColor:'rgba(12,14,24,0.97)', borderColor:'rgba(255,255,255,0.1)', borderWidth:1, padding:10 }},
      scales:{ x:{ grid:{display:false}, ticks:{font:{size:10}} }, y:{ grid:{color:'rgba(255,255,255,0.05)'}, ticks:{font:{size:10}} }}
    }
  });
}

// ── Column Profiler Cards ──────────────────────────────────
function buildProfilerCards(prof) {
  const grid = document.getElementById('profilerGrid');
  grid.innerHTML = headers.map(col => {
    const p = prof[col];
    const missingPct = ((p.missing/p.total)*100).toFixed(0);
    const quality = Math.max(0, 100 - (p.missing/p.total)*100 - (p.outliers?.length||0)*2);
    const qColor = quality >= 80 ? COLORS.green : quality >= 50 ? COLORS.amber : COLORS.red;
    const typeBadge = p.type === 'numeric' ? 'type-num' : 'type-str';

    let statsHtml = `
      <div class="profiler-stat">Missing <span>${p.missing} (${missingPct}%)</span></div>
      <div class="profiler-stat">Unique <span>${p.unique}</span></div>`;
    if (p.type === 'numeric' && p.mean !== undefined) {
      statsHtml += `
        <div class="profiler-stat">Mean <span>${(+p.mean).toFixed(1)}</span></div>
        <div class="profiler-stat">Min / Max <span>${p.min} / ${p.max}</span></div>
        <div class="profiler-stat">Outliers <span>${p.outliers?.length || 0}</span></div>`;
    }

    return `<div class="profiler-col">
      <div class="profiler-col-top">
        <span class="profiler-col-name">${col}</span>
        <span class="profiler-type-badge ${typeBadge}">${p.type}</span>
      </div>
      ${statsHtml}
      <div class="profiler-bar-wrap">
        <div class="profiler-bar-fill" style="width:${quality.toFixed(0)}%;background:${qColor}"></div>
      </div>
      <p class="profiler-quality-label" style="color:${qColor}">${quality.toFixed(0)}% quality</p>
    </div>`;
  }).join('');
}

// ── Table ──────────────────────────────────────────────────
function switchTab(view) {
  currentView = view;
  tableData = view === 'before' ? rawData : cleanData;
  document.getElementById('tabBefore').className = 'compare-tab' + (view==='before'?' active':'');
  document.getElementById('tabAfter').className  = 'compare-tab' + (view==='after' ?' active':'');
  currentPage = 1; renderTable(tableData);
}

function renderTable(data) {
  const search = document.getElementById('tableSearch').value.toLowerCase();
  let rows = data.filter(r =>
    !search || headers.some(h => String(r[h]||'').toLowerCase().includes(search))
  );

  const total = rows.length;
  const pages = Math.max(1, Math.ceil(total/PER_PAGE));
  if (currentPage > pages) currentPage = pages;

  const start = (currentPage-1)*PER_PAGE;
  const pageRows = rows.slice(start, start+PER_PAGE);

  // Head
  document.getElementById('tableHead').innerHTML = `<tr>${headers.map(h=>`<th>${h}</th>`).join('')}</tr>`;

  // Body
  document.getElementById('tableBody').innerHTML = pageRows.map(row => {
    const cells = headers.map(col => {
      const val = row[col];
      const isEmpty = val===''||val===null||val===undefined||String(val).trim()==='';
      const isFixed = row.__fixed && isEmpty;
      const isOutlier = row.__outlier && row.__outlier[col];
      let cls='', disp=isEmpty?'<em class="cell-null">null</em>':val;
      if (isEmpty && currentView==='before') cls = 'cell-null';
      if (isOutlier) cls = 'cell-outlier';
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
  const range=[]; for(let i=1;i<=pages;i++){ if(i===1||i===pages||Math.abs(i-currentPage)<=1) range.push(i); else if(range[range.length-1]!=='…') range.push('…'); }
  range.forEach(p=>{ if(p==='…') html+=`<button class="page-btn" disabled>…</button>`; else html+=`<button class="page-btn ${p===currentPage?'active':''}" onclick="goPage(${p})">${p}</button>`; });
  html+=`<button class="page-btn" onclick="goPage(${currentPage+1})" ${currentPage===pages?'disabled':''}>›</button>`;
  el.innerHTML=html;
}

function goPage(p) {
  const pages=Math.ceil(tableData.length/PER_PAGE);
  if(p<1||p>pages)return; currentPage=p; renderTable(tableData);
}

// ── Report ─────────────────────────────────────────────────
function buildReport(score, missing, dupes, norm, outliers, prof) {
  const ts = new Date().toLocaleString();
  document.getElementById('rTitle').textContent   = 'Dataset Quality Report';
  document.getElementById('rTimestamp').textContent = `Generated: ${ts}`;
  const grade = score >= 90?'A':score>=75?'B':score>=60?'C':score>=45?'D':'F';
  document.getElementById('rGrade').textContent = grade;
  document.getElementById('rGrade').style.color = score>=75?COLORS.green:score>=50?COLORS.amber:COLORS.red;

  const numCols = headers.filter(h=>prof[h].type==='numeric').length;
  document.getElementById('reportBody').innerHTML = `
    <div class="report-stat"><p class="report-stat-label">Total Rows</p><h3 class="report-stat-value">${fmtN(rawData.length)}</h3><p class="report-stat-sub">original dataset</p></div>
    <div class="report-stat"><p class="report-stat-label">Clean Rows</p><h3 class="report-stat-value" style="color:var(--green)">${fmtN(cleanData.length)}</h3><p class="report-stat-sub">after pipeline</p></div>
    <div class="report-stat"><p class="report-stat-label">Columns</p><h3 class="report-stat-value">${headers.length}</h3><p class="report-stat-sub">${numCols} numeric, ${headers.length-numCols} text</p></div>
    <div class="report-stat"><p class="report-stat-label">Quality Score</p><h3 class="report-stat-value" style="color:${score>=75?COLORS.green:COLORS.amber}">${score}%</h3><p class="report-stat-sub">overall data health</p></div>
  `;

  const findings = [
    missing > 0
      ? { type:'warn', title:`${missing} Missing Values Detected`, body:`Missing cells were found across ${headers.filter(h=>prof[h].missing>0).length} columns and handled using the "${document.getElementById('missingStrategy').value}" strategy.` }
      : { type:'ok',   title:'No Missing Values', body:'All cells are populated. No imputation was required.' },
    dupes > 0
      ? { type:'warn', title:`${dupes} Duplicate Rows Removed`, body:`Exact duplicate rows were identified and removed, reducing the dataset from ${rawData.length} to ${cleanData.length} rows.` }
      : { type:'ok',   title:'No Duplicate Rows', body:'No duplicate rows were found in the dataset.' },
    norm > 0
      ? { type:'info', title:`${norm} Text Values Normalized`, body:`Whitespace was trimmed and text cases were standardized across string columns.` }
      : { type:'ok',   title:'Text Already Clean', body:'No text normalization was necessary.' },
    outliers > 0
      ? { type:'warn', title:`${outliers} Outlier Values Flagged`, body:`Values outside the IQR range were detected using the Interquartile Range (IQR) method. These are highlighted in amber in the table.` }
      : { type:'ok',   title:'No Statistical Outliers', body:'All numeric values fall within the expected range (IQR method).' },
  ];

  const icons = {
    ok:   `<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><polyline points="20 6 9 17 4 12" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    warn: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" stroke="currentColor" stroke-width="2"/><line x1="12" y1="9" x2="12" y2="13" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="12" y1="17" x2="12.01" y2="17" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
    info: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/><line x1="12" y1="8" x2="12" y2="12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="12" y1="16" x2="12.01" y2="16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
    err:  `<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/><line x1="15" y1="9" x2="9" y2="15" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="9" y1="9" x2="15" y2="15" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
  };

  document.getElementById('reportFindings').innerHTML = findings.map(f=>`
    <div class="finding-row">
      <div class="finding-icon finding-icon--${f.type}">${icons[f.type]}</div>
      <div><p class="finding-title">${f.title}</p><p class="finding-body">${f.body}</p></div>
    </div>`).join('');
}

// ── Export ─────────────────────────────────────────────────
function exportClean() {
  const rows = cleanData.map(r => headers.map(h=>r[h]).join(',')).join('\n');
  const csv  = [headers.join(','), rows].join('\n');
  const blob = new Blob([csv],{type:'text/csv'});
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a'); a.href=url; a.download='cleaned_data.csv'; a.click();
  URL.revokeObjectURL(url);
  showToast('Cleaned data exported as CSV!','success');
}

function exportReport() {
  const lines = [
    '# DATA QUALITY REPORT',
    `Generated: ${new Date().toLocaleString()}`,
    '',
    `## Summary`,
    `- Original Rows: ${rawData.length}`,
    `- Clean Rows: ${cleanData.length}`,
    `- Columns: ${headers.length}`,
    `- Quality Score: ${document.getElementById('scoreNum').textContent}%`,
    '',
    '## Pipeline Log',
    ...pipelineLog.map(l => `- [${l.step}] ${l.detail}`),
    '',
    '## Column Profiles',
    ...headers.map(h => {
      const p = profile[h];
      return `- ${h} (${p.type}): ${p.missing} missing, ${p.unique} unique${p.type==='numeric'?`, mean=${p.mean?.toFixed(2)}, outliers=${p.outliers?.length||0}`:''}`;
    }),
  ];
  const blob = new Blob([lines.join('\n')],{type:'text/plain'});
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a'); a.href=url; a.download='data_quality_report.txt'; a.click();
  URL.revokeObjectURL(url);
  showToast('Report exported!','success');
}

// ── Load Data ──────────────────────────────────────────────
function loadData(rows) {
  if (!rows || !rows.length) { showToast('No valid data found','error'); return; }
  rawData  = rows;
  headers  = Object.keys(rows[0]);
  cleanData = [];
  currentPage = 1;

  // Show dashboard area
  document.getElementById('dashboardArea').classList.remove('hidden');
  document.getElementById('btnRunPipeline').disabled = false;

  // Reset pipeline UI
  ['step-profile','step-missing','step-dupes','step-normalize','step-outliers','step-export'].forEach(id=>{
    setStep(id,'pending','Pending');
  });
  ['conn-2','conn-3','conn-4','conn-5','conn-6'].forEach(id=>{
    const el=document.getElementById(id); if(el) el.classList.remove('done');
  });

  document.getElementById('step-ingest-detail').textContent = `${fmtN(rows.length)} rows × ${headers.length} cols`;

  // Initial profile for KPIs
  profile = profileDataset(rawData);
  const totalMissing = headers.reduce((s,c)=>s+profile[c].missing,0);
  const dupes = detectDupes(rawData).length;
  const score = calcQualityScore(rawData, profile);
  updateKPIs(score, totalMissing, dupes, profile);

  // Show raw table
  tableData = rawData; currentView='before'; switchTab('before');
  buildProfilerCards(profile);

  document.getElementById('btnExport').disabled = true;
  document.getElementById('btnReport').disabled = true;

  showToast(`Loaded ${fmtN(rows.length)} rows — click Run Pipeline to clean!`,'info');

  // Scroll into view
  document.getElementById('dashboardArea').scrollIntoView({behavior:'smooth'});
}

// ── Parse CSV ──────────────────────────────────────────────
function parseCsvText(text) {
  const result = Papa.parse(text.trim(), { header:true, skipEmptyLines:true, dynamicTyping:false });
  if (!result.data?.length) throw new Error('No valid rows found');
  return result.data;
}

// ── Setup UI ───────────────────────────────────────────────
function setupUI() {
  // Sidebar toggle
  const sidebar = document.getElementById('sidebar');
  const main    = document.getElementById('main');
  document.getElementById('sidebarToggle').onclick = () => {
    sidebar.classList.toggle('collapsed');
    main.classList.toggle('collapsed');
  };

  // Drop zone
  const dz = document.getElementById('dropZoneMain');
  const fi = document.getElementById('fileInputMain');
  fi.onchange = e => {
    const file = e.target.files[0]; if(!file) return;
    const reader = new FileReader();
    reader.onload = ev => { try { loadData(parseCsvText(ev.target.result)); } catch(er){ showToast(er.message,'error'); } };
    reader.readAsText(file);
  };
  dz.ondragover  = e => { e.preventDefault(); dz.classList.add('dragover'); };
  dz.ondragleave = () => dz.classList.remove('dragover');
  dz.ondrop      = e => {
    e.preventDefault(); dz.classList.remove('dragover');
    const file = e.dataTransfer.files[0]; if(!file) return;
    const reader = new FileReader();
    reader.onload = ev => { try { loadData(parseCsvText(ev.target.result)); } catch(er){ showToast(er.message,'error'); } };
    reader.readAsText(file);
  };

  document.getElementById('btnSample').onclick = () => { loadData(generateSample()); };

  // Buttons
  document.getElementById('btnRunPipeline').onclick = runPipeline;
  document.getElementById('btnExport').onclick      = exportClean;
  document.getElementById('btnReport').onclick      = exportReport;
  document.getElementById('tableSearch').oninput    = () => { currentPage=1; renderTable(tableData); };

  // Nav links active on scroll
  const sections = ['upload','quality','pipeline','compare','report'];
  window.addEventListener('scroll', () => {
    sections.forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      if (el.getBoundingClientRect().top < 160) {
        document.querySelectorAll('.nav-item').forEach(n=>n.classList.remove('active'));
        const nav = document.getElementById('nav-' + (id==='pipeline'?'pipeline':id==='quality'?'quality':id==='compare'?'compare':id==='report'?'report':'upload'));
        if (nav) nav.classList.add('active');
      }
    });
  }, { passive:true });
}

// ── Init ───────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  Chart.defaults.color       = '#7a8499';
  Chart.defaults.borderColor = 'rgba(255,255,255,0.06)';
  Chart.defaults.font.family = "'Inter', sans-serif";
  setupUI();
  // Auto-load sample data on boot
  loadData(generateSample());
});
