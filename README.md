# Data Cleaning & Reporting Automation

![Dashboard Preview](https://placehold.co/1200x600/0c0e18/f59e0b.png?text=Data+Cleaning+%26+Reporting+Automation)

A premium, interactive web application that automates data cleaning workflows and generates detailed quality reports — entirely in the browser with no backend required.

## ✨ Key Features

- **⚙️ Automated 6-Stage Cleaning Pipeline**
  - **Ingest** — Load CSV data instantly via drag & drop or file browse
  - **Profile** — Auto-detect column types, missing values, and data quality
  - **Missing Values** — Fill with mean / median / mode / zero, or drop rows
  - **Duplicates** — Detect and remove exact duplicate rows
  - **Normalize** — Trim whitespace, fix text casing, standardize formats
  - **Outliers** — Flag statistical outliers using the IQR method

- **📊 3 Interactive Charts**
  - Missing Values per Column (Bar)
  - Data Type Distribution (Donut)
  - Issues Fixed by Pipeline Stage (Bar)

- **🔬 Column Profiler** — Per-column breakdown: type, missing count, unique values, min/max, mean, outlier count, and a quality score bar.

- **🔀 Before / After Table** — Side-by-side comparison of raw and cleaned data with highlighted null cells, fixed values, and outliers.

- **📄 Automated Report** — Auto-generated data quality report with a letter grade (A–F), summary statistics, and individual findings per cleaning stage.

- **📤 Export** — Export the cleaned dataset or the full quality report as downloadable files.

## 🛠️ Technology Stack

- **HTML5 & CSS3** — Custom design with CSS variables, Grid, Flexbox, and toggle switches.
- **JavaScript (Vanilla)** — Full pipeline logic, IQR outlier detection, imputation strategies.
- **Chart.js** — For all interactive charts.
- **PapaParse** — For in-browser CSV parsing.

## 🚀 Getting Started

No build tools or servers required!

1. Clone the repository:
   ```bash
   git clone https://github.com/SylerS7/Data-Cleaning-Automation.git
   ```
2. Navigate to the project directory:
   ```bash
   cd Data-Cleaning-Automation
   ```
3. Open `index.html` in any modern browser.

## 📝 Usage

1. **Load Data** — Drop a CSV onto the upload zone, browse for a file, or click **"load sample dataset"** to use the built-in 120-row employee dataset.
2. **Configure Rules** — Use the sidebar toggles to enable or disable each cleaning rule, and pick a missing value strategy.
3. **Run Pipeline** — Click **"Run Pipeline"** in the top bar. Watch the pipeline stages animate as each step completes.
4. **Explore** — Review the KPI cards, column profiler, and charts. Toggle between **Raw Data** and **Cleaned Data** in the table.
5. **Export** — Click **"Export Clean Data"** for the processed CSV or **"Export Report"** for the quality summary.

## 📄 License

This project is open-source and available under the MIT License.
