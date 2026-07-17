/*
 * 반드시 본인의 Cloudflare Worker 주소로 변경하세요.
 * 주소 마지막에는 / 를 붙이지 않습니다.
 */
const API_BASE =
  "https://dividend-band-api.jh7777777.workers.dev";

const DAY_SECONDS = 24 * 60 * 60;
const YEAR_SECONDS = 365.25 * DAY_SECONDS;

const elements = {
  searchForm: document.querySelector("#search-form"),
  searchInput: document.querySelector("#search-input"),
  searchButton: document.querySelector("#search-button"),
  searchResults: document.querySelector("#search-results"),

  notice: document.querySelector("#notice"),
  loading: document.querySelector("#loading"),
  errorBox: document.querySelector("#error-box"),
  dashboard: document.querySelector("#dashboard"),

  exchangeName: document.querySelector("#exchange-name"),
  stockName: document.querySelector("#stock-name"),
  stockSymbol: document.querySelector("#stock-symbol"),
  updatedDate: document.querySelector("#updated-date"),

  currentPrice: document.querySelector("#current-price"),
  currencyLabel: document.querySelector("#currency-label"),
  ttmDividend: document.querySelector("#ttm-dividend"),
  currentYield: document.querySelector("#current-yield"),
  medianYield: document.querySelector("#median-yield"),
  yieldPercentile: document.querySelector("#yield-percentile"),
  valuationLabel: document.querySelector("#valuation-label"),
  valuationDescription:
    document.querySelector("#valuation-description"),
  valuationCard: document.querySelector(".valuation-card"),

  p10Yield: document.querySelector("#p10-yield"),
  p25Yield: document.querySelector("#p25-yield"),
  p50Yield: document.querySelector("#p50-yield"),
  p75Yield: document.querySelector("#p75-yield"),
  p90Yield: document.querySelector("#p90-yield"),

  yieldMarker: document.querySelector("#yield-marker"),
  yieldMarkerText: document.querySelector("#yield-marker-text"),

  bandValues: document.querySelector("#band-values"),
  dividendCount: document.querySelector("#dividend-count"),
  dividendTableBody:
    document.querySelector("#dividend-table-body"),
};

let bandChart = null;
let dividendChart = null;
let selectedSearchName = "";

function buildApiUrl(path, parameters = {}) {
  const base = API_BASE.replace(/\/+$/, "");
  const url = new URL(`${base}${path}`);

  Object.entries(parameters).forEach(([key, value]) => {
    url.searchParams.set(key, value);
  });

  return url.toString();
}

async function requestJson(path, parameters) {
  const response = await fetch(buildApiUrl(path, parameters));

  let data;

  try {
    data = await response.json();
  } catch {
    throw new Error(
      "서버 응답을 읽지 못했습니다. Worker 주소를 확인해 주세요."
    );
  }

  if (!response.ok) {
    throw new Error(
      data.error ||
      `서버 요청에 실패했습니다. (${response.status})`
    );
  }

  return data;
}

function setLoading(isLoading) {
  elements.loading.classList.toggle("hidden", !isLoading);
  elements.searchButton.disabled = isLoading;
}

function clearError() {
  elements.errorBox.textContent = "";
  elements.errorBox.classList.add("hidden");
}

function showError(error) {
  const message = error instanceof Error
    ? error.message
    : String(error);

  elements.errorBox.textContent = message;
  elements.errorBox.classList.remove("hidden");
}

function closeSearchResults() {
  elements.searchResults.replaceChildren();
}

function formatDate(timestamp) {
  return new Intl.DateTimeFormat("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: "UTC",
  }).format(new Date(timestamp * 1000));
}

function formatShortDate(timestamp) {
  return new Intl.DateTimeFormat("ko-KR", {
    year: "2-digit",
    month: "2-digit",
    timeZone: "UTC",
  }).format(new Date(timestamp * 1000));
}

function currencyDigits(currency) {
  return currency === "KRW" ? 0 : 2;
}

function formatMoney(value, currency = "USD") {
  if (!Number.isFinite(value)) {
    return "-";
  }

  const digits = currencyDigits(currency);

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

  const index = (sortedValues.length - 1) * probability;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const fraction = index - lower;

  if (lower === upper) {
    return sortedValues[lower];
  }

  return (
    sortedValues[lower] +
    (sortedValues[upper] - sortedValues[lower]) * fraction
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

function getSplitRatio(split) {
  const numerator = Number(split.numerator);
  const denominator = Number(split.denominator);

  if (
    Number.isFinite(numerator) &&
    Number.isFinite(denominator) &&
    denominator !== 0
  ) {
    return numerator / denominator;
  }

  const parts = String(split.splitRatio || "").split(":");

  if (parts.length === 2) {
    const left = Number(parts[0]);
    const right = Number(parts[1]);

    if (
      Number.isFinite(left) &&
      Number.isFinite(right) &&
      right !== 0
    ) {
      return left / right;
    }
  }

  return 1;
}

function adjustDividendForSplits(
  dividend,
  targetTimestamp,
  splits
) {
  let adjustedAmount = dividend.amount;

  for (const split of splits) {
    if (
      split.date > dividend.date &&
      split.date <= targetTimestamp
    ) {
      const ratio = getSplitRatio(split);

      if (Number.isFinite(ratio) && ratio > 0) {
        adjustedAmount /= ratio;
      }
    }
  }

  return adjustedAmount;
}

function calculateTtmDividend(
  targetTimestamp,
  dividends,
  splits
) {
  const startTimestamp =
    targetTimestamp - 365 * DAY_SECONDS;

  return dividends
    .filter((dividend) =>
      dividend.date <= targetTimestamp &&
      dividend.date > startTimestamp
    )
    .reduce((sum, dividend) => {
      return (
        sum +
        adjustDividendForSplits(
          dividend,
          targetTimestamp,
          splits
        )
      );
    }, 0);
}

function normalizeEvents(result) {
  const dividendEvents =
    Object.values(result.events?.dividends || {})
      .map((item) => ({
        date: Number(item.date),
        amount: Number(item.amount),
      }))
      .filter((item) =>
        Number.isFinite(item.date) &&
        Number.isFinite(item.amount) &&
        item.amount >= 0
      )
      .sort((a, b) => a.date - b.date);

  const splitEvents =
    Object.values(result.events?.splits || {})
      .map((item) => ({
        date: Number(item.date),
        numerator: Number(item.numerator),
        denominator: Number(item.denominator),
        splitRatio: item.splitRatio,
      }))
      .filter((item) => Number.isFinite(item.date))
      .sort((a, b) => a.date - b.date);

  return {
    dividends: dividendEvents,
    splits: splitEvents,
  };
}

function analyzeStock(result) {
  const timestamps = result.timestamp || [];
  const quote = result.indicators?.quote?.[0] || {};
  const closes = quote.close || [];

  const { dividends, splits } = normalizeEvents(result);

  const latestPossibleTimestamp =
    timestamps[timestamps.length - 1] ||
    Math.floor(Date.now() / 1000);

  const tenYearCutoff =
    latestPossibleTimestamp -
    Math.floor(10 * YEAR_SECONDS);

  const points = [];

  for (let index = 0; index < timestamps.length; index += 1) {
    const timestamp = Number(timestamps[index]);
    const close = Number(closes[index]);

    if (
      !Number.isFinite(timestamp) ||
      !Number.isFinite(close) ||
      close <= 0 ||
      timestamp < tenYearCutoff
    ) {
      continue;
    }

    const ttmDividend = calculateTtmDividend(
      timestamp,
      dividends,
      splits
    );

    const dividendYield = ttmDividend > 0
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
      "최근 10년의 유효한 가격 데이터가 없습니다."
    );
  }

  const validYields = points
    .map((point) => point.dividendYield)
    .filter((value) =>
      Number.isFinite(value) &&
      value > 0 &&
      value < 100
    )
    .sort((a, b) => a - b);

  if (validYields.length < 20) {
    throw new Error(
      "배당수익률 밴드를 계산할 배당 데이터가 부족합니다."
    );
  }

  const levels = {
    p10: percentile(validYields, 0.10),
    p25: percentile(validYields, 0.25),
    p50: percentile(validYields, 0.50),
    p75: percentile(validYields, 0.75),
    p90: percentile(validYields, 0.90),
  };

  const latestPoint = points[points.length - 1];

  const currentPercentile = percentileRank(
    validYields,
    latestPoint.dividendYield
  );

  const tenYearDividends = dividends.filter(
    (dividend) => dividend.date >= tenYearCutoff
  );

  return {
    points,
    dividends: tenYearDividends,
    allDividends: dividends,
    splits,
    levels,
    latestPoint,
    currentPercentile,
    tenYearCutoff,
  };
}

function priceAtYield(ttmDividend, yieldPercent) {
  if (
    !Number.isFinite(ttmDividend) ||
    !Number.isFinite(yieldPercent) ||
    ttmDividend <= 0 ||
    yieldPercent <= 0
  ) {
    return null;
  }

  return ttmDividend / (yieldPercent / 100);
}

function getValuation(percentileValue) {
  if (!Number.isFinite(percentileValue)) {
    return {
      label: "판정 불가",
      description: "배당 데이터가 부족합니다.",
      className: "neutral",
    };
  }

  if (percentileValue <= 10) {
    return {
      label: "매우 고평가 가능",
      description: "10년 중 배당수익률이 매우 낮은 구간",
      className: "expensive",
    };
  }

  if (percentileValue <= 25) {
    return {
      label: "고평가 가능",
      description: "10년 기준 낮은 배당수익률 구간",
      className: "expensive",
    };
  }

  if (percentileValue < 75) {
    return {
      label: "중립 구간",
      description: "10년 배당수익률의 일반적인 범위",
      className: "neutral",
    };
  }

  if (percentileValue < 90) {
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
  color,
  backgroundColor,
  fill
) {
  return {
    label,
    data,
    borderColor: color,
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
  const labels = analysis.points.map(
    (point) => formatShortDate(point.timestamp)
  );

  const p10Prices = analysis.points.map((point) =>
    priceAtYield(point.ttmDividend, analysis.levels.p10)
  );

  const p25Prices = analysis.points.map((point) =>
    priceAtYield(point.ttmDividend, analysis.levels.p25)
  );

  const p50Prices = analysis.points.map((point) =>
    priceAtYield(point.ttmDividend, analysis.levels.p50)
  );

  const p75Prices = analysis.points.map((point) =>
    priceAtYield(point.ttmDividend, analysis.levels.p75)
  );

  const p90Prices = analysis.points.map((point) =>
    priceAtYield(point.ttmDividend, analysis.levels.p90)
  );

  const actualPrices = analysis.points.map(
    (point) => point.close
  );

  if (bandChart) {
    bandChart.destroy();
  }

  const context =
    document.querySelector("#band-chart").getContext("2d");

  bandChart = new Chart(context, {
    type: "line",

    data: {
      labels,

      datasets: [
        makeBandDataset(
          `P10 ${formatPercent(analysis.levels.p10)}`,
          p10Prices,
          "#d93f4f",
          "rgba(217, 63, 79, 0.09)",
          false
        ),

        makeBandDataset(
          `P25 ${formatPercent(analysis.levels.p25)}`,
          p25Prices,
          "#ef872f",
          "rgba(239, 135, 47, 0.10)",
          "-1"
        ),

        makeBandDataset(
          `중앙 ${formatPercent(analysis.levels.p50)}`,
          p50Prices,
          "#d2ad18",
          "rgba(210, 173, 24, 0.09)",
          "-1"
        ),

        makeBandDataset(
          `P75 ${formatPercent(analysis.levels.p75)}`,
          p75Prices,
          "#55a873",
          "rgba(85, 168, 115, 0.10)",
          "-1"
        ),

        makeBandDataset(
          `P90 ${formatPercent(analysis.levels.p90)}`,
          p90Prices,
          "#118c68",
          "rgba(17, 140, 104, 0.10)",
          "-1"
        ),

        {
          label: "실제 주가",
          data: actualPrices,
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
            font: {
              size: 11,
            },
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
          grid: {
            display: false,
          },

          ticks: {
            maxTicksLimit: 8,
            maxRotation: 0,
            color: "#7a8494",
          },
        },

        y: {
          beginAtZero: false,

          grid: {
            color: "rgba(120, 132, 151, 0.12)",
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

  const latest = analysis.latestPoint;

  const currentBandValues = [
    {
      label: "고평가 P10 가격",
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
      label: "저평가 P90 가격",
      value: priceAtYield(
        latest.ttmDividend,
        analysis.levels.p90
      ),
    },
  ];

  elements.bandValues.replaceChildren();

  currentBandValues.forEach((item) => {
    const wrapper = document.createElement("div");
    const label = document.createElement("span");
    const value = document.createElement("strong");

    wrapper.className = "band-value";
    label.textContent = item.label;
    value.textContent =
      `${formatMoney(item.value, currency)} ${currency}`;

    wrapper.append(label, value);
    elements.bandValues.append(wrapper);
  });
}

function makeAnnualDividendData(
  dividends,
  splits,
  latestTimestamp
) {
  const totals = new Map();

  for (const dividend of dividends) {
    const year = new Date(
      dividend.date * 1000
    ).getUTCFullYear();

    const adjustedAmount = adjustDividendForSplits(
      dividend,
      latestTimestamp,
      splits
    );

    totals.set(
      year,
      (totals.get(year) || 0) + adjustedAmount
    );
  }

  const currentYear = new Date(
    latestTimestamp * 1000
  ).getUTCFullYear();

  const years = [];

  for (let year = currentYear - 9; year <= currentYear; year += 1) {
    years.push(year);
  }

  return {
    years,
    totals: years.map((year) => totals.get(year) || 0),
  };
}

function renderDividendChart(analysis, currency) {
  const annual = makeAnnualDividendData(
    analysis.dividends,
    analysis.splits,
    analysis.latestPoint.timestamp
  );

  if (dividendChart) {
    dividendChart.destroy();
  }

  const context =
    document.querySelector("#dividend-chart").getContext("2d");

  dividendChart = new Chart(context, {
    type: "bar",

    data: {
      labels: annual.years.map(String),

      datasets: [
        {
          label: `연간 주당배당금 (${currency})`,
          data: annual.totals,
          borderColor: "#2457d6",
          backgroundColor: "rgba(36, 87, 214, 0.68)",
          borderWidth: 1,
          borderRadius: 5,
        },
      ],
    },

    options: {
      responsive: true,
      maintainAspectRatio: false,

      plugins: {
        legend: {
          display: false,
        },

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
          grid: {
            display: false,
          },
        },

        y: {
          beginAtZero: true,

          grid: {
            color: "rgba(120, 132, 151, 0.12)",
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
  elements.dividendTableBody.replaceChildren();

  const descending = [...analysis.dividends].sort(
    (a, b) => b.date - a.date
  );

  elements.dividendCount.textContent =
    `${descending.length}건`;

  if (!descending.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");

    cell.colSpan = 4;
    cell.textContent = "최근 10년 배당금 내역이 없습니다.";
    cell.style.textAlign = "center";
    cell.style.color = "#687386";

    row.append(cell);
    elements.dividendTableBody.append(row);
    return;
  }

  descending.forEach((dividend) => {
    const adjustedAmount = adjustDividendForSplits(
      dividend,
      analysis.latestPoint.timestamp,
      analysis.splits
    );

    const row = document.createElement("tr");

    const dateCell = document.createElement("td");
    const originalCell = document.createElement("td");
    const adjustedCell = document.createElement("td");
    const currencyCell = document.createElement("td");

    dateCell.textContent = formatDate(dividend.date);

    originalCell.textContent =
      formatMoney(dividend.amount, currency);

    adjustedCell.textContent =
      formatMoney(adjustedAmount, currency);

    currencyCell.textContent = currency;

    row.append(
      dateCell,
      originalCell,
      adjustedCell,
      currencyCell
    );

    elements.dividendTableBody.append(row);
  });
}

function renderYieldPosition(analysis) {
  const rank = Math.max(
    0,
    Math.min(100, analysis.currentPercentile)
  );

  elements.yieldMarker.style.left = `${rank}%`;
  elements.yieldMarkerText.textContent =
    `${rank.toFixed(0)}백분위`;

  elements.p10Yield.textContent =
    formatPercent(analysis.levels.p10);

  elements.p25Yield.textContent =
    formatPercent(analysis.levels.p25);

  elements.p50Yield.textContent =
    formatPercent(analysis.levels.p50);

  elements.p75Yield.textContent =
    formatPercent(analysis.levels.p75);

  elements.p90Yield.textContent =
    formatPercent(analysis.levels.p90);
}

function renderSummary(result, analysis) {
  const meta = result.meta || {};
  const currency = meta.currency || "USD";

  const displayName =
    selectedSearchName ||
    meta.longName ||
    meta.shortName ||
    meta.symbol ||
    "종목";

  elements.exchangeName.textContent =
    meta.exchangeName ||
    meta.fullExchangeName ||
    "Yahoo Finance";

  elements.stockName.textContent = displayName;
  elements.stockSymbol.textContent = meta.symbol || "-";

  elements.updatedDate.textContent =
    formatDate(analysis.latestPoint.timestamp);

  elements.currentPrice.textContent =
    formatMoney(analysis.latestPoint.close, currency);

  elements.currencyLabel.textContent =
