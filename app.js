/* ============================================================
   APP.JS  — CleanFlow v3 (Full Logic Rewrite)
   Pipeline flow: Upload → Profile RAW → Show issues → Clean → Profile CLEAN
   ============================================================ */

const COLORS = { blue:'#0070f3', green:'#10b981', red:'#ef4444', amber:'#f5a623', white:'#ededed', dim:'#333333' };

const NULL_STRINGS = new Set(['','null','none','n/a','na','unknown','-','undefined','nan','nil','missing','#n/a','?']);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/;

// Extended business rules: keyword → {min, max}
const BUSINESS_RULES = {
  age:                { min: 0,  max: 130 },
  attendance_pct:     { min: 0,  max: 100 },
  attendance:         { min: 0,  max: 100 },
  math_score:         { min: 0,  max: 100 },
  science_score:      { min: 0,  max: 100 },
  english_score:      { min: 0,  max: 100 },
  score:              { min: 0,  max: 100 },
  satisfaction_score: { min: 1,  max: 10  },
  satisfaction:       { min: 1,  max: 10  },
  salary:             { min: 0             },
  fees_paid:          { min: 0             },
  fees:               { min: 0             },
  delay_minutes:      { min: 0,  max: 3000 },
  passengers:         { min: 0,  max: 1000 },
  checked_bags:       { min: 0,  max: 500  },
  baggage_weight_kg:  { min: 0,  max: 20000 },
  fuel_used_liters:   { min: 0             },
  crew_count:         { min: 1,  max: 50   },
  ticket_price:       { min: 0             }
};

// Global Audit Counters
let audit = { dupes: 0, imputed: 0, normalized: 0, dateNorm: 0, ruleViols: 0, timeViols: 0, dateViols: 0, badEmails: 0 };
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

  if (col.includes('email') || col.includes('mail')) return 'email';

  const isIdName = col === 'id' || /^(student|user|cust|emp|employee|product|order|record)_?id$/.test(col) || col.endsWith('_id');
  const isTimeName = col.includes('time') || col.includes('departure') || col.includes('arrival');

  const nonMissing = values.filter(v => !isMissing(v));
  if (!nonMissing.length) return 'string';

  const uniqueVals = new Set(nonMissing.map(v => String(v).trim().toLowerCase()));
  const uniqueRatio = uniqueVals.size / nonMissing.length;

  if (isTimeName) {
    const timeCount = nonMissing.filter(v => /^\d{1,2}:\d{2}/.test(String(v).trim()) || /\d{1,2}\s?(AM|PM|am|pm)/.test(String(v).trim())).length;
    if (timeCount / nonMissing.length > 0.5) return 'time';
  }

  const dateCount = nonMissing.filter(v => {
    const s = String(v).trim();
    return /^\d{4}-\d{2}-\d{2}/.test(s) || /^\d{2}[\/\-]\d{2}[\/\-]\d{4}/.test(s) || /^[A-Za-z]{3} \d{1,2}, \d{4}/.test(s);
  }).length;
  if (col.includes('date') || dateCount / nonMissing.length > 0.6) return 'date';

  const hasAlphaPattern = nonMissing.some(v => /\d+[-\/][A-Za-z]/.test(String(v)));
  if (hasAlphaPattern) return 'categorical';

  const numericVals = nonMissing.filter(v => {
    // Strip everything except digits, minus, and period
    const cleaned = String(v).replace(/[^\d.-]/g, '').trim();
    return cleaned !== '' && !isNaN(Number(cleaned));
  });
  const numRatio = numericVals.length / nonMissing.length;

  if (isIdName && numRatio > 0.8 && uniqueRatio > 0.85) return 'id';
  if (numRatio > 0.8) return 'numeric';
  if (uniqueRatio < 0.15 && nonMissing.length > 5) return 'categorical';
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

    const invalidNumeric = type === 'numeric'
      ? vals.filter(v => !isMissing(v) && isNaN(Number(String(v).replace(/[^\d.-]/g,'').trim()))).length
      : 0;

    const nonMissing = vals.filter(v => !isMissing(v));
    const unique = new Set(nonMissing.map(v => String(v).trim().toLowerCase())).size;

    let min, max, mean, median, iqrOutlierVals = [], ruleViolationVals = [];

    if (type === 'numeric') {
      const nums = nonMissing
        .map(v => Number(String(v).replace(/[^\d.-]/g,'').trim()))
        .filter(n => !isNaN(n));

      if (nums.length) {
        const sorted = [...nums].sort((a,b) => a-b);
        min = sorted[0]; max = sorted[sorted.length-1];
        mean = nums.reduce((s,n) => s+n, 0) / nums.length;
        median = sorted[Math.floor(sorted.length/2)];

        const q1 = sorted[Math.floor(sorted.length*0.25)];
        const q3 = sorted[Math.floor(sorted.length*0.75)];
        const iqr = q3 - q1;
        if (iqr > 0) iqrOutlierVals = nums.filter(n => n < q1-1.5*iqr || n > q3+1.5*iqr);

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
  document.getElementById('kpiDupes').textContent   = fmtN(audit.dupes);
  document.getElementById('kpiDupesSub').textContent = audit.dupes > 0 ? `${fmtN(cleanRows)} unique records` : 'No duplicates removed';
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

  // Step 2: Semantic Cleaning & Imputation
  setStep('step-missing', 'active', 'Cleaning & Imputing…'); await sleep(400);
  audit = { dupes: 0, imputed: 0, normalized: 0, dateNorm: 0, ruleViols: 0, timeViols: 0, dateViols: 0, badEmails: 0 };
  
  data.forEach(r => { r.__status = 'clean'; r.__issues = []; });

  headers.forEach(c => {
    const t = p1[c].type;
    data.forEach(r => {
      const v = r[c];
      const isMiss = isMissing(v);
      const strVal = String(v ?? '').trim();

      if (isMiss) {
        r[c] = t === 'numeric' && p1[c].mean != null ? Number(p1[c].mean.toFixed(2)) : '';
        if (r.__status === 'clean') r.__status = 'imputed';
        r.__issues.push(`imputed ${c}`);
        audit.imputed++;
        return;
      }

      // ── NUMERIC STRIP ──
      if (t === 'numeric') {
        const cleaned = strVal.replace(/[^\d.-]/g, '');
        if (isNaN(Number(cleaned)) || cleaned === '') {
          r[c] = p1[c].mean != null ? Number(p1[c].mean.toFixed(2)) : '';
          if (r.__status === 'clean') r.__status = 'imputed';
          r.__issues.push(`invalid_num_imputed ${c}`);
          audit.imputed++;
        } else if (cleaned !== strVal) {
          r[c] = Number(cleaned);
          if (r.__status === 'clean') r.__status = 'corrected';
          r.__issues.push(`numeric_strip ${c}`);
          audit.normalized++;
        } else {
          r[c] = Number(cleaned);
        }
      }
      
      // ── CATEGORICAL NORM ──
      else if (t === 'categorical') {
        let norm = strVal;
        if (c.includes('origin') || c.includes('destination') || c.includes('code')) norm = norm.toUpperCase();
        else if (norm.length > 1) {
          // basic title case for categories
          norm = norm.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
        }
        if (norm !== String(v)) {
          r[c] = norm;
          if (r.__status === 'clean') r.__status = 'corrected';
          r.__issues.push(`case_normalized ${c}`);
          audit.normalized++;
        }
      }
      
      // ── DATE PARSING ──
      else if (t === 'date') {
        let dateObj = new Date(strVal);
        if (isNaN(dateObj.getTime())) {
          // try DD/MM/YYYY
          const m = strVal.match(/^(\d{2})[\/\-](\d{2})[\/\-](\d{4})$/);
          if (m) dateObj = new Date(`${m[3]}-${m[2]}-${m[1]}`);
        }
        if (!isNaN(dateObj.getTime())) {
          const iso = dateObj.toISOString().split('T')[0];
          if (iso !== String(v)) {
            r[c] = iso;
            if (r.__status === 'clean') r.__status = 'corrected';
            r.__issues.push(`date_normalized ${c}`);
            audit.dateNorm++;
          }
        } else {
          r.__status = 'rejected';
          r.__issues.push(`invalid_date ${c}`);
          audit.dateViols++;
        }
      }

      // ── TIME PARSING ──
      else if (t === 'time') {
        let timeStr = strVal.toUpperCase();
        let m = timeStr.match(/^(\d{1,2}):(\d{2})$/);
        let hh, mm;
        if (m) { hh = parseInt(m[1]); mm = parseInt(m[2]); }
        else {
          m = timeStr.match(/^(\d{1,2})(?::(\d{2}))?\s?(AM|PM)$/);
          if (m) {
            hh = parseInt(m[1]); mm = parseInt(m[2] || '0');
            if (m[3] === 'PM' && hh < 12) hh += 12;
            if (m[3] === 'AM' && hh === 12) hh = 0;
          }
        }

        if (hh !== undefined && mm !== undefined && hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59) {
          const pad = n => String(n).padStart(2, '0');
          const norm = `${pad(hh)}:${pad(mm)}`;
          if (norm !== String(v)) {
            r[c] = norm;
            if (r.__status === 'clean') r.__status = 'corrected';
            r.__issues.push(`time_normalized ${c}`);
            audit.normalized++;
          }
        } else {
          r.__status = 'rejected';
          r.__issues.push(`invalid_time ${c}`);
          audit.timeViols++;
        }
      }
    });
  });
  setStep('step-missing', 'complete', `${audit.imputed} imputed, ${audit.normalized + audit.dateNorm} normalized`);

  // Step 3: Deduplicate
  setStep('step-dupes', 'active', 'Deduplicating…'); await sleep(300);
  const beforeCount = data.length;
  const seenRows = new Set();
  data = data.filter(r => {
    // only use the actual columns for dedupe hash, ignore meta fields
    const k = headers.map(h => String(r[h]??'').trim().toLowerCase()).join('\x00');
    if (seenRows.has(k)) return false; seenRows.add(k); return true;
  });
  audit.dupes = beforeCount - data.length;
  setStep('step-dupes', 'complete', `${audit.dupes} removed`);

  // Step 4: Validate / flag outliers
  setStep('step-outliers', 'active', 'Validating ranges & rules…'); await sleep(350);
  const p2 = profileDataset(data);
  let flagged = 0;
  data.forEach(r => {
    headers.forEach(c => {
      // Check emails
      if (p2[c].type === 'email' && r[c] !== '' && !EMAIL_RE.test(String(r[c]))) {
        if (r.__status !== 'rejected') r.__status = 'flagged';
        r.__issues.push(`bad_email ${c}`);
        audit.badEmails++;
        flagged++;
      }

      // Check numeric bounds
      if (p2[c].type === 'numeric') {
        const n = Number(String(r[c]??'').replace(/[^\d.-]/g,'').trim());
        if (isNaN(n)) return;
        const isIQR  = p2[c].iqrOutlierVals?.includes(n);
        const isRule = p2[c].ruleViolationVals?.includes(n);
        if (isIQR || isRule) { 
          if (r.__status !== 'rejected') r.__status = 'flagged';
          r.__outlier = r.__outlier || {}; r.__outlier[c] = true; 
          r.__issues.push(`outlier_or_rule ${c}`);
          if (isRule) audit.ruleViols++;
          flagged++; 
        }
      }
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
  buildInsights(rawIssues, cleanIssues, audit.imputed, audit.dupes, flagged);

  document.getElementById('btnRunPipeline').disabled = false;
  document.getElementById('btnExport').disabled = false;
  document.getElementById('btnReport').disabled = false;

  pipelineRan = true;
  switchTab('after');
  showToast(`✓ Pipeline complete. ${audit.imputed} cells fixed · ${audit.dupes} dupes removed · ${flagged} flagged.`, 'success');
}

// ── INSIGHTS ──────────────────────────────────────────────
function buildInsights(rawIss, cleanIss, missingFixed, dupesRemoved, outliersFlagged) {
  const panel = document.getElementById('insightsPanel');
  const grid  = document.getElementById('insightsGrid');
  panel.classList.remove('hidden');

  const cards = [];

  // ── RESOLVED cards ──
  if (audit.dupes > 0) {
    cards.push({ type:'resolved', count: audit.dupes, title: 'Duplicate rows removed',
      desc: `${audit.dupes} exact duplicate records were identified and eliminated. The dataset was reduced from ${rawData.length} → ${cleanData.length} rows.` });
  }

  if (audit.imputed > 0) {
    cards.push({ type:'resolved', count: audit.imputed, title: 'Missing cells imputed',
      desc: `${audit.imputed} blank or invalid cells were filled automatically using the column mean for numeric fields, and left as empty string for text fields.` });
  }

  if (audit.normalized > 0) {
    cards.push({ type:'resolved', count: audit.normalized, title: 'Values normalized',
      desc: `${audit.normalized} values were structurally corrected (e.g. whitespace trimmed, case normalized for categories, numeric currency stripped, or time converted to 24h).` });
  }

  if (audit.dateNorm > 0) {
    cards.push({ type:'resolved', count: audit.dateNorm, title: 'Dates standardized',
      desc: `${audit.dateNorm} dates from various formats (MM/DD/YYYY, DD-MM-YYYY, etc) were converted to ISO 8601 (YYYY-MM-DD).` });
  }

  // ── FLAGGED / MANUAL cards ──
  if (audit.ruleViols > 0) {
    cards.push({ type:'flagged', count: audit.ruleViols, title: 'Range violations flagged',
      desc: `${audit.ruleViols} values broke defined domain limits (e.g. delays < 0, percentages > 100). They are highlighted in the data table but kept intact.` });
  }

  const iqrOutliers = cleanIss.outliers - cleanIss.ruleViols;
  if (iqrOutliers > 0) {
    cards.push({ type:'flagged', count: iqrOutliers, title: 'Statistical outliers flagged',
      desc: `${iqrOutliers} numeric values exceeded statistical bounds (IQR). They may be valid anomalies or data entry errors.` });
  }

  if (audit.timeViols > 0 || audit.dateViols > 0) {
    cards.push({ type:'manual', count: audit.timeViols + audit.dateViols, title: 'Invalid Dates/Times',
      desc: `${audit.timeViols + audit.dateViols} impossible dates (e.g. 31/02/2026) or times (e.g. 25:72) were found. CleanFlow rejected these as unparseable.` });
  }

  if (audit.badEmails > 0) {
    cards.push({ type:'manual', count: audit.badEmails, title: 'Invalid emails',
      desc: `${audit.badEmails} email addresses failed format validation. CleanFlow cannot auto-correct these.` });
  }

  // ── INFO cards ──
  const reviewCount = cleanData.filter(r => r.__status === 'flagged' || r.__status === 'rejected').length;
  if (reviewCount === 0) {
    cards.push({ type:'info', count: '✓', title: 'All rows processed securely',
      desc: `The pipeline successfully transformed the data without any remaining anomalies. ${cleanData.length} rows ready for export.` });
  } else {
    cards.push({ type:'info', count: reviewCount, title: 'Rows require review',
      desc: `${reviewCount} rows contain flagged outliers or unparseable inputs. Review the table below.` });
  }

  grid.innerHTML = cards.map(c => `
    <div class="insight-card ${c.type}">
      <div class="insight-tag ${c.type}">
        <span>${c.type === 'resolved' ? '✓ RESOLVED' : c.type === 'flagged' ? '⚠ FLAGGED' : c.type === 'manual' ? '✗ MANUAL REVIEW' : 'ℹ INFO'}</span>
      </div>
      <div class="insight-count">${c.count}</div>
      <div class="insight-title">${c.title}</div>
      <div class="insight-desc">${c.desc}</div>
    </div>
  `).join('');
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
    `<tr>
      ${currentView === 'after' ? `<th style="width: 100px;">Status</th>` : ''}
      ${headers.map(h => `<th>${h}</th>`).join('')}
    </tr>`;

  document.getElementById('tableBody').innerHTML = pageRows.map(r => {
    let statusBadge = '';
    if (currentView === 'after') {
      const s = r.__status || 'clean';
      const colors = {
        clean: 'var(--acc-green)', imputed: 'var(--acc-blue)',
        corrected: 'var(--acc-blue)', flagged: 'var(--acc-amber)', rejected: 'var(--acc-red)'
      };
      statusBadge = `<td><span style="font-size:10px; font-weight:600; text-transform:uppercase; padding:2px 6px; border-radius:4px; border:1px solid ${colors[s]}; color:${colors[s]}">${s}</span></td>`;
    }

    const cells = headers.map(c => {
      const v = r[c];
      const missing = isMissing(v);
      let cls = '';
      if (missing) cls = 'cell-null';
      else if (currentView === 'after' && r.__issues?.some(i => i.endsWith(` ${c}`))) {
        const issue = r.__issues.find(i => i.endsWith(` ${c}`));
        if (issue.startsWith('imputed') || issue.includes('normalized') || issue.includes('strip')) cls = 'cell-fixed';
        else if (issue.startsWith('outlier') || issue.startsWith('bad_email')) cls = 'cell-outlier';
        else if (issue.startsWith('invalid')) cls = 'cell-bad';
      }
      else if (currentView === 'before' && rawProfile[c]?.type === 'email' && !EMAIL_RE.test(String(v))) cls = 'cell-bad';
      
      return `<td class="${cls}">${missing ? '∅ null' : v}</td>`;
    }).join('');

    return `<tr>${statusBadge}${cells}</tr>`;
  }).join('');

  document.getElementById('rowsInfo').textContent = `Page ${currentPage} of ${pages} · ${total} rows`;
  document.getElementById('pagination').innerHTML = `
    <button class="page-btn" onclick="currentPage=Math.max(1,currentPage-1);renderTable()" ${currentPage===1?'disabled':''}>←</button>
    <button class="page-btn" onclick="currentPage=Math.min(${pages},currentPage+1);renderTable()" ${currentPage===pages?'disabled':''}>→</button>
  `;
}

// ── LOAD ──────────────────────────────────────────────────
function showLoading(show) {
  document.getElementById('loadingScreen').classList.toggle('hidden', !show);
}

function setLoadingProgress(pct, title, sub, step) {
  document.getElementById('loadingBar').style.width   = pct + '%';
  document.getElementById('loadingTitle').textContent = title;
  document.getElementById('loadingSub').textContent   = sub;
  document.getElementById('loadingSteps').textContent = step || '';
}

async function loadData(rows, filename = 'dataset.csv') {
  if (!rows || !rows.length) { showToast('No data found in file.', 'error'); return; }

  // 1. Hide upload, show loading
  document.getElementById('uploadSection').classList.add('hidden');
  document.getElementById('dashboardArea').classList.add('hidden');
  showLoading(true);

  setLoadingProgress(10, 'Reading file…', 'Parsing CSV structure', `→ ${rows.length} rows detected`);
  await sleep(400);

  setLoadingProgress(30, 'Inferring schema…', 'Detecting column types', `→ ${Object.keys(rows[0]).length} attributes`);
  await sleep(450);

  // 2. Run the actual work
  rawData = rows; headers = Object.keys(rows[0]); cleanData = []; pipelineRan = false; removedDupes = 0;

  setLoadingProgress(55, 'Profiling raw data…', 'Computing statistics per column', '→ missing values, ranges, types');
  await sleep(400);

  rawProfile = profileDataset(rawData);

  setLoadingProgress(75, 'Detecting duplicates…', 'Cross-referencing rows', '→ exact row matching');
  await sleep(350);

  rawDupes  = detectDuplicates(rawData);
  rawIssues = summariseIssues(rawData, rawProfile, rawDupes);
  const rawScore = calcScore(rawData, rawIssues);

  setLoadingProgress(90, 'Building dashboard…', 'Rendering charts and profiler cards', '→ almost done');
  await sleep(350);

  setLoadingProgress(100, 'Complete', `Score: ${rawScore} · ${rawIssues.total} issues found`, '');
  await sleep(300);

  // 3. Hide loading, show dashboard
  showLoading(false);
  document.getElementById('dashboardArea').classList.remove('hidden');
  document.getElementById('btnUploadNew').classList.remove('hidden');

  // Topbar filename
  document.getElementById('fileSeparator').classList.remove('hidden');
  const fnEl = document.getElementById('fileName');
  fnEl.textContent = filename; fnEl.classList.remove('hidden');

  // Buttons
  document.getElementById('btnRunPipeline').disabled = false;
  document.getElementById('btnExport').disabled = true;
  document.getElementById('btnReport').disabled = true;
  document.getElementById('insightsPanel').classList.add('hidden');
  resetSteps();

  // Show raw KPIs + charts
  updateRawKPIs(rawScore, rawIssues, rawData.length);
  buildRawCharts(rawProfile);
  buildProfilerCards(rawProfile);
  switchTab('before');

  showToast(`✓ ${filename} loaded · ${rawIssues.total} issues found · score: ${rawScore}`);
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
  if (!data || !data.length) {
    showToast('No data available to export.', 'error');
    return;
  }
  const csv = [headers.join(','), ...data.map(r => headers.map(h => `"${String(r[h]??'').replace(/"/g,'""')}"`).join(','))].join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], {type:'text/csv'}));
  a.download = filename;
  document.body.appendChild(a); // Required for some browsers
  a.click();
  document.body.removeChild(a);
  showToast(`Exported ${filename}`, 'success');
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
