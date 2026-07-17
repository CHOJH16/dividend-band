const API_BASE =
  "https://dividend-band-api.jh7777777.workers.dev";

const DAY = 24 * 60 * 60;
const YEAR = 365.25 * DAY;

const $ = (selector) => document.querySelector(selector);

const el = {
  form: $("#search-form"),
  input: $("#search-input"),
  button: $("#search-button"),
  results: $("#search-results"),
  start: $("#start-message"),
  loading: $("#loading"),
  error: $("#error-box"),
  dashboard: $("#dashboard"),

  exchange: $("#exchange-name"),
  name: $("#stock-name"),
  symbol: $("#stock-symbol"),
  updated: $("#updated-date"),

  price: $("#current-price"),
  currency: $("#currency-label"),
  ttmDividend: $("#ttm-dividend"),
  currentYield: $("#current-yield"),
  medianYield: $("#median-yield"),
  yieldPercentile: $("#yield-percentile"),

  valuationCard: $("#valuation-card"),
  valuationLabel: $("#valuation-label"),
  valuationDescription: $("#valuation-description"),

  p10: $("#p10-yield"),
  p25: $("#p25-yield"),
  p50: $("#p50-yield"),
  p75: $("#p75-yield"),
  p90: $("#p90-yield"),

  marker: $("#yield-marker"),
  markerText: $("#yield-marker-text"),

  bandSummary: $("#band-price-summary"),
  dividendCount: $("#dividend-count"),
  dividendBody: $("#dividend-table-body"),
};

let bandChart = null;
let dividendChart = null;
let selectedName = "";

function apiUrl(path, parameters = {}) {
  const url = new URL(
    `${API_BASE.replace(/\/+$/, "")}${path}`
  );

  Object.entries(parameters).forEach(([key, value]) => {
    url.searchParams.set(key, value);
  });

  return url.toString();
}

async function requestJson(path, parameters) {
  const response = await fetch(apiUrl(path, parameters));

  let data;

  try {
    data = await response.json();
  } catch {
    throw new Error(
      "서버 응답을 읽을 수 없습니다. Worker 주소를 확인하세요."
    );
  }

  if (!response.ok) {
    throw new Error(
      data.error || `서버 요청 오류: ${response.status}`
    );
  }

  return data;
}

function showLoading(show) {
  el.loading.classList.toggle("hidden", !show);
  el.button.disabled = show;
}

function clearError() {
  el.error.textContent = "";
  el.error.classList.add("hidden");
}

function showError(error) {
  const message =
    error instanceof Error ? error.message : String(error);

  el.error.textContent = message;
  el.error.classList.remove("hidden");
}

function closeResults() {
  el.results.replaceChildren();
}

function formatDate(timestamp) {
  return new Intl.DateTimeFormat("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(timestamp * 1000));
}

function formatShortDate(timestamp) {
  return new Intl.DateTimeFormat("ko-KR", {
    year: "2-digit",
    month: "2-digit",
  }).format(new Date(timestamp * 1000));
}

function priceDigits(currency) {
  return currency === "KRW" ? 0 : 2;
}

function formatMoney(value, currency = "USD") {
  if (!Number.isFinite(value)) {
    return "-";
  }

  const digits = priceDigits(currency);

  return new Intl.NumberFormat("ko-KR", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

function formatPercent(value, digits = 2) {
  if (!Number.isFinite(value)) {
    return "-";
  }

  return `${value.toFixed(digits)}%`;
}

function percentile(sortedValues, probability) {
  if (!sortedValues.length) {
    return NaN;
  }

  if (sortedValues.length === 1) {
    return sortedValues[0];
  }

  const position =
    (sortedValues.length - 1) * probability;

  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const fraction = position - lower;

  if (lower === upper) {
    return sortedValues[lower];
  }

  return (
    sortedValues[lower] +
    (sortedValues[upper] - sortedValues[lower]) *
      fraction
  );
}

function percentileRank(values, currentValue) {
  if (!values.length || !Number.isFinite(currentValue)) {
    return NaN;
  }

  const belowOrEqual = values.filter(
    (value) => value <= currentValue
  ).length;

  return (belowOrEqual / values.length) * 100;
}

function normalizeEvents(result) {
  const dividends = Object.values(
    result.events?.dividends || {}
  )
    .map((item) => ({
      date: Number(item.date),
      amount: Number(item.amount),
    }))
    .filter(
      (item) =>
        Number.isFinite(item.date) &&
        Number.isFinite(item.amount) &&
        item.amount >= 0
    )
    .sort((a, b) => a.date - b.date);

  const splits = Object.values(
    result.events?.splits || {}
  )
    .map((item) => ({
      date: Number(item.date),
      numerator: Number(item.numerator),
      denominator: Number(item.denominator),
      ratio: item.splitRatio || "",
    }))
    .filter((item) => Number.isFinite(item.date))
    .sort((a, b) => a.date - b.date);

  return { dividends, splits };
}

/*
 * Yahoo Finance의 chart API가 반환하는 과거 종가와
 * 배당 이벤트는 액면분할을 반영한 기준으로 제공됩니다.
 * 따라서 배당금에 분할비율을 다시 적용하지 않습니다.
 */
function ttmDividendAt(timestamp, dividends) {
  const start = timestamp - 365 * DAY;

  return dividends
    .filter(
      (dividend) =>
        dividend.date > start &&
        dividend.date <= timestamp
    )
    .reduce(
      (sum, dividend) => sum + dividend.amount,
      0
    );
}

function analyzeStock(result) {
  const timestamps = result.timestamp || [];
  const quote = result.indicators?.quote?.[0] || {};
  const closes = quote.close || [];

  const { dividends, splits } = normalizeEvents(result);

  const lastTimestamp =
    timestamps[timestamps.length - 1] ||
    Math.floor(Date.now() / 1000);

  const tenYearCutoff =
    lastTimestamp - Math.floor(10 * YEAR);

  const points = [];

  for (let i = 0; i < timestamps.length; i += 1) {
    const timestamp = Number(timestamps[i]);
    const close = Number(closes[i]);

    if (
      !Number.isFinite(timestamp) ||
      !Number.isFinite(close) ||
      close <= 0 ||
      timestamp < tenYearCutoff
    ) {
      continue;
    }

    const ttmDividend = ttmDividendAt(
      timestamp,
      dividends
    );

    const dividendYield =
      ttmDividend > 0
        ? (ttmDividend / close) * 100
        : null;

    points.push({
      timestamp,
      close,
      ttmDividend,
      dividendYield,
    });
  }

  if (!points.length) {
    throw new Error(
      "최근 10년의 유효한 주가 데이터가 없습니다."
    );
  }

  const validYields = points
    .map((point) => point.dividendYield)
    .filter(
      (value) =>
        Number.isFinite(value) &&
        value > 0 &&
        value < 100
    )
    .sort((a, b) => a - b);

  if (validYields.length < 20) {
    throw new Error(
      "최근 10년 배당 데이터가 부족해 밴드를 계산할 수 없습니다."
    );
  }

  const levels = {
    p10: percentile(validYields, 0.1),
    p25: percentile(validYields, 0.25),
    p50: percentile(validYields, 0.5),
    p75: percentile(validYields, 0.75),
    p90: percentile(validYields, 0.9),
  };

  const latest = points[points.length - 1];

  const currentRank = percentileRank(
    validYields,
    latest.dividendYield
  );

  return {
    points,
    dividends: dividends.filter(
      (dividend) => dividend.date >= tenYearCutoff
    ),
    splits,
    levels,
    latest,
    currentRank,
    tenYearCutoff,
  };
}

function priceAtYield(dividend, yieldPercent) {
  if (
    !Number.isFinite(dividend) ||
    !Number.isFinite(yieldPercent) ||
    dividend <= 0 ||
    yieldPercent <= 0
  ) {
    return null;
  }

  return dividend / (yieldPercent / 100);
}

function valuationForRank(rank) {
  if (rank <= 10) {
    return {
      label: "매우 고평가 가능",
      description: "10년 중 배당수익률이 매우 낮은 구간",
      className: "expensive",
    };
  }

  if (rank <= 25) {
    return {
      label: "고평가 가능",
      description: "10년 기준 낮은 배당수익률 구간",
      className: "expensive",
    };
  }

  if (rank < 75) {
    return {
      label: "중립 구간",
      description: "10년 배당수익률의 일반적인 범위",
      className: "neutral",
    };
  }

  if (rank < 90) {
    return {
      label: "저평가 가능",
      description: "10년 기준 높은 배당수익률 구간",
      className: "cheap",
    };
  }

  return {
    label: "매우 저평가 가능",
    description: "10년 중 배당수익률이 매우 높은 구간",
    className: "cheap",
  };
}

function makeBandDataset(
  label,
  data,
  borderColor,
  backgroundColor,
  fill = false
) {
  return {
    label,
    data,
    borderColor,
    backgroundColor,
    borderWidth: 1.6,
    pointRadius: 0,
    pointHoverRadius: 3,
    tension: 0.15,
    spanGaps: true,
    fill,
  };
}

function renderBandChart(analysis, currency) {
  const labels = analysis.points.map((point) =>
    formatShortDate(point.timestamp)
  );

  const bandData = (level) =>
    analysis.points.map((point) =>
      priceAtYield(point.ttmDividend, level)
    );

  if (bandChart) {
    bandChart.destroy();
  }

  bandChart = new Chart($("#band-chart"), {
    type: "line",

    data: {
      labels,

      datasets: [
        makeBandDataset(
          `P10 ${formatPercent(analysis.levels.p10)}`,
          bandData(analysis.levels.p10),
          "#d93f4f",
          "rgba(217,63,79,0.10)"
        ),

        makeBandDataset(
          `P25 ${formatPercent(analysis.levels.p25)}`,
          bandData(analysis.levels.p25),
          "#ef872f",
          "rgba(239,135,47,0.10)",
          "-1"
        ),

        makeBandDataset(
          `중앙 ${formatPercent(analysis.levels.p50)}`,
          bandData(analysis.levels.p50),
          "#d0aa18",
          "rgba(208,170,24,0.10)",
          "-1"
        ),

        makeBandDataset(
          `P75 ${formatPercent(analysis.levels.p75)}`,
          bandData(analysis.levels.p75),
          "#56a875",
          "rgba(86,168,117,0.10)",
          "-1"
        ),

        makeBandDataset(
          `P90 ${formatPercent(analysis.levels.p90)}`,
          bandData(analysis.levels.p90),
          "#118c68",
          "rgba(17,140,104,0.10)",
          "-1"
        ),

        {
          label: "실제 주가",
          data: analysis.points.map(
            (point) => point.close
          ),
          borderColor: "#155eef",
          backgroundColor: "#155eef",
          borderWidth: 3,
          pointRadius: 0,
          pointHoverRadius: 4,
          tension: 0.12,
          spanGaps: true,
          fill: false,
        },
      ],
    },

    options: {
      responsive: true,
      maintainAspectRatio: false,
      normalized: true,

      interaction: {
        mode: "index",
        intersect: false,
      },

      plugins: {
        legend: {
          position: "bottom",
          labels: {
            usePointStyle: true,
            boxWidth: 7,
            padding: 15,
            font: { size: 11 },
          },
        },

        tooltip: {
          callbacks: {
            label(context) {
              const value = Number(context.raw);

              return (
                `${context.dataset.label}: ` +
                `${formatMoney(value, currency)} ${currency}`
              );
            },
          },
        },
      },

      scales: {
        x: {
          grid: { display: false },
          ticks: {
            maxTicksLimit: 8,
            maxRotation: 0,
            color: "#7a8494",
          },
        },

        y: {
          beginAtZero: false,
          grid: {
            color: "rgba(120,132,151,0.12)",
          },
          ticks: {
            color: "#7a8494",
            callback(value) {
              return formatMoney(Number(value), currency);
            },
          },
        },
      },
    },
  });

  renderBandSummary(analysis, currency);
}

function renderBandSummary(analysis, currency) {
  const latest = analysis.latest;

  const items = [
    {
      label: "P10 고평가 가격",
      value: priceAtYield(
        latest.ttmDividend,
        analysis.levels.p10
      ),
    },
    {
      label: "P25 가격",
      value: priceAtYield(
        latest.ttmDividend,
        analysis.levels.p25
      ),
    },
    {
      label: "중앙 가격",
      value: priceAtYield(
        latest.ttmDividend,
        analysis.levels.p50
      ),
    },
    {
      label: "P75 가격",
      value: priceAtYield(
        latest.ttmDividend,
        analysis.levels.p75
      ),
    },
    {
      label: "P90 저평가 가격",
      value: priceAtYield(
        latest.ttmDividend,
        analysis.levels.p90
      ),
    },
  ];

  el.bandSummary.replaceChildren();

  items.forEach((item) => {
    const wrapper = document.createElement("div");
    const label = document.createElement("span");
    const value = document.createElement("strong");

    wrapper.className = "band-price-item";
    label.textContent = item.label;
    value.textContent =
      `${formatMoney(item.value, currency)} ${currency}`;

    wrapper.append(label, value);
    el.bandSummary.append(wrapper);
  });
}

function annualDividendData(analysis) {
  const totals = new Map();

  analysis.dividends.forEach((dividend) => {
    const year = new Date(
      dividend.date * 1000
    ).getFullYear();

    totals.set(
      year,
      (totals.get(year) || 0) + dividend.amount
    );
  });

  const currentYear = new Date(
    analysis.latest.timestamp * 1000
  ).getFullYear();

  const years = [];

  for (
    let year = currentYear - 9;
    year <= currentYear;
    year += 1
  ) {
    years.push(year);
  }

  return {
    years,
    totals: years.map((year) => totals.get(year) || 0),
  };
}

function renderDividendChart(analysis, currency) {
  const annual = annualDividendData(analysis);

  if (dividendChart) {
    dividendChart.destroy();
  }

  dividendChart = new Chart($("#dividend-chart"), {
    type: "bar",

    data: {
      labels: annual.years.map(String),
      datasets: [
        {
          label: `연간 주당배당금 (${currency})`,
          data: annual.totals,
          borderColor: "#2457d6",
          backgroundColor: "rgba(36,87,214,0.68)",
          borderWidth: 1,
          borderRadius: 5,
        },
      ],
    },

    options: {
      responsive: true,
      maintainAspectRatio: false,

      plugins: {
        legend: { display: false },

        tooltip: {
          callbacks: {
            label(context) {
              return (
                `배당금: ${formatMoney(
                  Number(context.raw),
                  currency
                )} ${currency}`
              );
            },
          },
        },
      },

      scales: {
        x: {
          grid: { display: false },
        },

        y: {
          beginAtZero: true,
          grid: {
            color: "rgba(120,132,151,0.12)",
          },
          ticks: {
            callback(value) {
              return formatMoney(Number(value), currency);
            },
          },
        },
      },
    },
  });
}

function renderDividendTable(analysis, currency) {
  const dividends = [...analysis.dividends].sort(
    (a, b) => b.date - a.date
  );

  el.dividendBody.replaceChildren();
  el.dividendCount.textContent = `${dividends.length}건`;

  if (!dividends.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");

    cell.colSpan = 4;
    cell.className = "empty-table";
    cell.textContent =
      "최근 10년 배당금 지급 내역이 없습니다.";

    row.append(cell);
    el.dividendBody.append(row);
    return;
  }

  dividends.forEach((dividend) => {
    const row = document.createElement("tr");

    const dateCell = document.createElement("td");
    const amountCell = document.createElement("td");
    const adjustedCell = document.createElement("td");
    const currencyCell = document.createElement("td");

    dateCell.textContent = formatDate(dividend.date);

    amountCell.textContent = formatMoney(
      dividend.amount,
      currency
    );

    /*
     * Yahoo가 이미 액면분할을 반영한 배당금을 제공하므로
     * 분할 보정 배당금은 동일하게 표시됩니다.
     */
    adjustedCell.textContent = formatMoney(
      dividend.amount,
      currency
    );

    currencyCell.textContent = currency;

    row.append(
      dateCell,
      amountCell,
      adjustedCell,
      currencyCell
    );

    el.dividendBody.append(row);
  });
}

function renderYieldPosition(analysis) {
  const rank = Math.max(
    0,
    Math.min(100, analysis.currentRank)
  );

  el.marker.style.left = `${rank}%`;
  el.markerText.textContent = `${rank.toFixed(0)}백분위`;

  el.p10.textContent = formatPercent(analysis.levels.p10);
  el.p25.textContent = formatPercent(analysis.levels.p25);
  el.p50.textContent = formatPercent(analysis.levels.p50);
  el.p75.textContent = formatPercent(analysis.levels.p75);
  el.p90.textContent = formatPercent(analysis.levels.p90);
}

function renderSummary(result, analysis) {
  const meta = result.meta || {};
  const currency = meta.currency || "USD";
  const symbol = meta.symbol || "-";

  let displayName =
    selectedName ||
    meta.longName ||
    meta.shortName ||
    symbol;

  if (
    !selectedName ||
    selectedName.toUpperCase() === symbol.toUpperCase()
  ) {
    displayName =
      meta.longName ||
      meta.shortName ||
      selectedName ||
      symbol;
  }

  el.exchange.textContent =
    meta.fullExchangeName ||
    meta.exchangeName ||
    "Yahoo Finance";

  el.name.textContent = displayName;
  el.symbol.textContent = symbol;
  el.updated.textContent = formatDate(
    analysis.latest.timestamp
  );

  el.price.textContent =
    formatMoney(analysis.latest.close, currency);

  el.currency.textContent = currency;

  el.ttmDividend.textContent =
    `${formatMoney(
      analysis.latest.ttmDividend,
      currency
    )} ${currency}`;

  el.currentYield.textContent =
    formatPercent(analysis.latest.dividendYield);

  el.medianYield.textContent =
    formatPercent(analysis.levels.p50);

  el.yieldPercentile.textContent =
    `${analysis.currentRank.toFixed(0)}백분위`;

  const valuation = valuationForRank(
    analysis.currentRank
  );

  el.valuationCard.classList.remove(
    "expensive",
    "neutral",
    "cheap"
  );

  el.valuationCard.classList.add(
    valuation.className
  );

  el.valuationLabel.textContent = valuation.label;

  el.valuationDescription.textContent =
    valuation.description;

  renderBandChart(analysis, currency);
  renderDividendChart(analysis, currency);
  renderDividendTable(analysis, currency);
  renderYieldPosition(analysis);
}

function renderSearchResults(quotes) {
  el.results.replaceChildren();

  if (!quotes.length) {
    const message = document.createElement("div");

    message.className = "search-message";
    message.textContent =
      "검색 결과가 없습니다. 티커를 직접 입력해 보세요.";

    el.results.append(message);
    return;
  }

  quotes.forEach((quote) => {
    const button = document.createElement("button");
    const nameBox = document.createElement("span");
    const name = document.createElement("strong");
    const exchange = document.createElement("small");
    const symbol = document.createElement("span");

    button.type = "button";
    button.className = "search-result";

    nameBox.className = "search-result-name";
    symbol.className = "search-result-symbol";

    name.textContent = quote.name || quote.symbol;

    exchange.textContent =
      quote.exchange || quote.type || "Yahoo Finance";

    symbol.textContent = quote.symbol;

    nameBox.append(name, exchange);
    button.append(nameBox, symbol);

    button.addEventListener("click", () => {
      selectedName = quote.name || quote.symbol;
      el.input.value = selectedName;
      closeResults();
      loadStock(quote.symbol);
    });

    el.results.append(button);
  });
}

async function searchStocks(query) {
  clearError();
  closeResults();

  el.button.disabled = true;
  el.button.textContent = "검색 중";

  try {
    const data = await requestJson("/api/search", {
      q: query,
      v: Date.now(),
    });

    renderSearchResults(data.quotes || []);
  } catch (error) {
    showError(error);
  } finally {
    el.button.disabled = false;
    el.button.textContent = "검색";
  }
}

async function loadStock(symbol) {
  clearError();
  closeResults();

  el.start.classList.add("hidden");
  el.dashboard.classList.add("hidden");
  showLoading(true);

  try {
    const data = await requestJson("/api/stock", {
      symbol,
    });

    const result = data.result;

    if (!result) {
      throw new Error("종목 데이터가 없습니다.");
    }

    const analysis = analyzeStock(result);

    renderSummary(result, analysis);

    el.dashboard.classList.remove("hidden");

    const url = new URL(window.location.href);
    url.searchParams.set(
      "symbol",
      data.resolvedSymbol || symbol
    );

    window.history.replaceState(
      {},
      "",
      url.toString()
    );
  } catch (error) {
    showError(error);
    el.start.classList.remove("hidden");
  } finally {
    showLoading(false);
  }
}

el.form.addEventListener("submit", (event) => {
  event.preventDefault();

  const query = el.input.value.trim();

  if (!query) {
    return;
  }

  searchStocks(query);
});

document
  .querySelectorAll(".example-button")
  .forEach((button) => {
    button.addEventListener("click", () => {
      const query = button.dataset.query || "";

      el.input.value = query;
      searchStocks(query);
      el.input.focus();
    });
  });

document.addEventListener("click", (event) => {
  if (
    !el.results.contains(event.target) &&
    !el.form.contains(event.target)
  ) {
    closeResults();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeResults();
  }
});

window.addEventListener("DOMContentLoaded", () => {
  const parameters = new URLSearchParams(
    window.location.search
  );

  const symbol = parameters.get("symbol");

  if (symbol) {
    selectedName = symbol;
    el.input.value = symbol;
    loadStock(symbol);
  }
});
