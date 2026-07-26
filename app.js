const API_BASE =
  "https://dividend-band-api.jh7777777.workers.dev";

const DAY = 24 * 60 * 60;
const YEAR = 365.25 * DAY;

const $ = (selector) =>
  document.querySelector(selector);

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
  dividendStreak: $("#dividend-streak"),

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
let activeSearchIndex = -1;

const exactStockCache = new Map();

/* =========================================================
   API
========================================================= */

function apiUrl(path, parameters = {}) {
  const base = API_BASE.replace(/\/+$/, "");
  const url = new URL(`${base}${path}`);

  Object.entries(parameters).forEach(([key, value]) => {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  });

  return url.toString();
}

async function requestJson(path, parameters = {}) {
  const response = await fetch(
    apiUrl(path, parameters),
    {
      method: "GET",
      headers: {
        Accept: "application/json",
      },
    }
  );

  let data;

  try {
    data = await response.json();
  } catch {
    throw new Error(
      "서버 응답을 읽지 못했습니다. Cloudflare Worker 주소를 확인하세요."
    );
  }

  if (!response.ok) {
    throw new Error(
      data?.error ||
      `서버 요청에 실패했습니다. (${response.status})`
    );
  }

  return data;
}

/* =========================================================
   화면 상태
========================================================= */

function showLoading(show) {
  if (el.loading) {
    el.loading.classList.toggle("hidden", !show);
  }

  if (el.button) {
    el.button.disabled = show;
  }
}

function clearError() {
  if (!el.error) return;

  el.error.textContent = "";
  el.error.classList.add("hidden");
}

function showError(error) {
  if (!el.error) return;

  const message =
    error instanceof Error
      ? error.message
      : String(error);

  el.error.textContent = message;
  el.error.classList.remove("hidden");
}

function closeResults() {
  if (el.results) {
    el.results.replaceChildren();
  }

  activeSearchIndex = -1;
}

/* =========================================================
   표시 형식
========================================================= */

function formatDate(timestamp) {
  if (!Number.isFinite(timestamp)) {
    return "-";
  }

  return new Intl.DateTimeFormat(
    "ko-KR",
    {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      timeZone: "UTC",
    }
  ).format(new Date(timestamp * 1000));
}

function formatShortDate(timestamp) {
  if (!Number.isFinite(timestamp)) {
    return "";
  }

  return new Intl.DateTimeFormat(
    "ko-KR",
    {
      year: "2-digit",
      month: "2-digit",
      timeZone: "UTC",
    }
  ).format(new Date(timestamp * 1000));
}

function moneyDigits(currency) {
  return currency === "KRW" ? 0 : 2;
}

function formatMoney(value, currency = "USD") {
  if (!Number.isFinite(value)) {
    return "-";
  }

  const digits = moneyDigits(currency);

  return new Intl.NumberFormat(
    "ko-KR",
    {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }
  ).format(value);
}

function formatPercent(value, digits = 2) {
  if (!Number.isFinite(value)) {
    return "-";
  }

  return `${value.toFixed(digits)}%`;
}

/* =========================================================
   통계 계산
========================================================= */

function median(values) {
  if (!values.length) {
    return NaN;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 0) {
    return (
      sorted[middle - 1] +
      sorted[middle]
    ) / 2;
  }

  return sorted[middle];
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
    (
      sortedValues[upper] -
      sortedValues[lower]
    ) * fraction
  );
}

function percentileRank(values, currentValue) {
  if (
    !values.length ||
    !Number.isFinite(currentValue)
  ) {
    return NaN;
  }

  const belowOrEqual =
    values.filter(
      (value) => value <= currentValue
    ).length;

  return (
    belowOrEqual /
    values.length
  ) * 100;
}

/* =========================================================
   배당 및 액면분할 데이터
========================================================= */

function normalizeEvents(result) {
  const rawDividends =
    result.events?.dividends || {};

  const rawSplits =
    result.events?.splits || {};

  const dividends =
    Object.values(rawDividends)
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

  const splits =
    Object.values(rawSplits)
      .map((item) => ({
        date: Number(item.date),
        numerator: Number(item.numerator),
        denominator: Number(item.denominator),
        splitRatio: item.splitRatio || "",
      }))
      .filter(
        (item) => Number.isFinite(item.date)
      )
      .sort((a, b) => a.date - b.date);

  return {
    dividends,
    splits,
  };
}

/*
 * Yahoo Finance Chart API의 과거 종가와 배당금은
 * 이미 주식분할이 반영된 값입니다.
 *
 * SCHD의 2024년 3대 1 분할 등을 다시 보정하면
 * 배당금이 이중으로 나누어지므로 원본 값을 그대로 사용합니다.
 */
function adjustDividendForSplits(
  dividend,
  _targetTimestamp,
  _splits
) {
  const amount = Number(dividend?.amount);

  if (
    !Number.isFinite(amount) ||
    amount < 0
  ) {
    return 0;
  }

  return amount;
}

function groupDividendsByDate(
  dividends,
  targetTimestamp,
  splits
) {
  const grouped = new Map();

  dividends.forEach((dividend) => {
    const dateKey =
      new Date(dividend.date * 1000)
        .toISOString()
        .slice(0, 10);

    const adjustedAmount =
      adjustDividendForSplits(
        dividend,
        targetTimestamp,
        splits
      );

    const existing = grouped.get(dateKey);

    if (existing) {
      existing.amount += adjustedAmount;
      existing.date = Math.max(
        existing.date,
        dividend.date
      );
    } else {
      grouped.set(dateKey, {
        date: dividend.date,
        amount: adjustedAmount,
      });
    }
  });

  return [...grouped.values()]
    .sort((a, b) => a.date - b.date);
}

/* =========================================================
   배당 지급 빈도 자동 판단
========================================================= */

function estimatePaymentsPerYear(
  timestamp,
  dividends
) {
  const recentStart =
    timestamp - Math.floor(3.2 * YEAR);

  const recent =
    dividends
      .filter(
        (dividend) =>
          dividend.date <= timestamp &&
          dividend.date >= recentStart
      )
      .sort((a, b) => a.date - b.date);

  if (recent.length < 2) {
    return 1;
  }

  const uniqueDates = [];

  recent.forEach((dividend) => {
    const previous =
      uniqueDates[uniqueDates.length - 1];

    if (
      previous === undefined ||
      Math.abs(dividend.date - previous) > DAY
    ) {
      uniqueDates.push(dividend.date);
    }
  });

  if (uniqueDates.length < 2) {
    return 1;
  }

  const intervals = [];

  for (
    let index = 1;
    index < uniqueDates.length;
    index += 1
  ) {
    const intervalDays =
      (
        uniqueDates[index] -
        uniqueDates[index - 1]
      ) / DAY;

    if (
      intervalDays >= 10 &&
      intervalDays <= 450
    ) {
      intervals.push(intervalDays);
    }
  }

  const typicalInterval =
    median(intervals.slice(-12));

  if (!Number.isFinite(typicalInterval)) {
    return 1;
  }

  if (typicalInterval <= 45) {
    return 12;
  }

  if (typicalInterval <= 135) {
    return 4;
  }

  if (typicalInterval <= 240) {
    return 2;
  }

  return 1;
}

function ttmDividendAt(
  timestamp,
  dividends,
  splits
) {
  const searchStart =
    timestamp - 400 * DAY;

  const candidates =
    dividends.filter(
      (dividend) =>
        dividend.date > searchStart &&
        dividend.date <= timestamp
    );

  if (!candidates.length) {
    return 0;
  }

  const paymentCount =
    estimatePaymentsPerYear(
      timestamp,
      dividends
    );

  const grouped =
    groupDividendsByDate(
      candidates,
      timestamp,
      splits
    );

  return grouped
    .slice(-paymentCount)
    .reduce(
      (sum, dividend) =>
        sum + dividend.amount,
      0
    );
}

/* =========================================================
   종목 데이터 분석
========================================================= */

function analyzeStock(result) {
  if (!result) {
    throw new Error(
      "종목 데이터가 없습니다."
    );
  }

  const timestamps =
    Array.isArray(result.timestamp)
      ? result.timestamp
      : [];

  const quote =
    result.indicators?.quote?.[0] || {};

  const closes =
    Array.isArray(quote.close)
      ? quote.close
      : [];

  const {
    dividends,
    splits,
  } = normalizeEvents(result);

  if (!timestamps.length) {
    throw new Error(
      "주가 데이터를 찾지 못했습니다."
    );
  }

  const lastTimestamp =
    Number(
      timestamps[timestamps.length - 1]
    );

  const tenYearCutoff =
    lastTimestamp -
    Math.floor(10 * YEAR);

  const points = [];

  for (
    let index = 0;
    index < timestamps.length;
    index += 1
  ) {
    const timestamp =
      Number(timestamps[index]);

    const close =
      Number(closes[index]);

    if (
      !Number.isFinite(timestamp) ||
      !Number.isFinite(close) ||
      close <= 0 ||
      timestamp < tenYearCutoff
    ) {
      continue;
    }

    const ttmDividend =
      ttmDividendAt(
        timestamp,
        dividends,
        splits
      );

    const dividendYield =
      ttmDividend > 0
        ? (ttmDividend / close) * 100
        : 0;

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

  const validYields =
    points
      .map(
        (point) => point.dividendYield
      )
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

  const latest =
    points[points.length - 1];

  const currentRank =
    percentileRank(
      validYields,
      latest.dividendYield
    );

  const tenYearDividends =
    dividends.filter(
      (dividend) =>
        dividend.date >= tenYearCutoff &&
        dividend.date <= lastTimestamp
    );

  return {
    points,
    dividends: tenYearDividends,
    allDividends: dividends,
    splits,
    levels,
    latest,
    currentRank,
    tenYearCutoff,
  };
}

/* =========================================================
   배당 연속 증가·유지 기간
========================================================= */

function calculateDividendStreak(analysis) {
  const annualTotals = new Map();

  analysis.allDividends.forEach((dividend) => {
    const year =
      new Date(dividend.date * 1000)
        .getUTCFullYear();

    const amount =
      adjustDividendForSplits(
        dividend,
        analysis.latest.timestamp,
        analysis.splits
      );

    annualTotals.set(
      year,
      (annualTotals.get(year) || 0) +
      amount
    );
  });

  const latestDataYear =
    new Date(
      analysis.latest.timestamp * 1000
    ).getUTCFullYear();

  /*
   * 진행 중인 올해는 연간 배당금이 아직 완성되지 않았으므로
   * 직전 완료 연도부터 비교합니다.
   */
  let currentYear =
    latestDataYear - 1;

  if (!annualTotals.has(currentYear)) {
    const availableYears =
      [...annualTotals.keys()]
        .filter(
          (year) => year < latestDataYear
        )
        .sort((a, b) => b - a);

    if (!availableYears.length) {
      return {
        years: 0,
        limited: false,
      };
    }

    currentYear = availableYears[0];
  }

  let streak = 0;
  let limited = false;

  while (true) {
    const previousYear =
      currentYear - 1;

    if (!annualTotals.has(currentYear)) {
      break;
    }

    if (!annualTotals.has(previousYear)) {
      limited = streak > 0;
      break;
    }

    const currentTotal =
      annualTotals.get(currentYear);

    const previousTotal =
      annualTotals.get(previousYear);

    /*
     * 소수점 계산 오차를 고려해 아주 작은 허용치를 둡니다.
     * 현재 연간 배당금이 전년과 같거나 크면 증가·유지입니다.
     */
    const tolerance =
      Math.max(
        0.000001,
        Math.abs(previousTotal) *
          0.000001
      );

    if (
      currentTotal + tolerance <
      previousTotal
    ) {
      break;
    }

    streak += 1;
    currentYear = previousYear;
  }

  return {
    years: streak,
    limited,
  };
}

function renderDividendStreak(analysis) {
  if (!el.dividendStreak) {
    return;
  }

  const streak =
    calculateDividendStreak(analysis);

  if (streak.years <= 0) {
    el.dividendStreak.textContent =
      "0년";
    return;
  }

  el.dividendStreak.textContent =
    streak.limited
      ? `${streak.years}년 이상`
      : `${streak.years}년`;
}

/* =========================================================
   밴드 가격 및 평가
========================================================= */

function priceAtYield(
  dividend,
  yieldPercent
) {
  if (
    !Number.isFinite(dividend) ||
    !Number.isFinite(yieldPercent) ||
    dividend <= 0 ||
    yieldPercent <= 0
  ) {
    return null;
  }

  return (
    dividend /
    (yieldPercent / 100)
  );
}

function valuationForRank(rank) {
  if (!Number.isFinite(rank)) {
    return {
      label: "판정 불가",
      description:
        "현재 배당수익률을 계산할 수 없습니다.",
      className: "neutral",
    };
  }

  if (rank <= 10) {
    return {
      label: "매우 고평가",
      description:
        "현재 배당수익률이 10년 기준으로 매우 낮은 구간입니다.",
      className: "expensive",
    };
  }

  if (rank <= 25) {
    return {
      label: "고평가",
      description:
        "현재 배당수익률이 10년 기준으로 낮은 구간입니다.",
      className: "expensive",
    };
  }

  if (rank < 75) {
    return {
      label: "중립",
      description:
        "현재 배당수익률이 10년의 일반적인 범위에 있습니다.",
      className: "neutral",
    };
  }

  if (rank < 90) {
    return {
      label: "저평가",
      description:
        "현재 배당수익률이 10년 기준으로 높은 구간입니다.",
      className: "cheap",
    };
  }

  return {
    label: "매우 저평가",
    description:
      "현재 배당수익률이 10년 기준으로 매우 높은 구간입니다.",
    className: "cheap",
  };
}

/* =========================================================
   상단 요약 정보
========================================================= */

function renderSummary(result, analysis) {
  const meta = result.meta || {};
  const currency =
    meta.currency || "USD";

  const name =
    selectedName ||
    meta.longName ||
    meta.shortName ||
    meta.symbol ||
    "종목";

  if (el.exchange) {
    el.exchange.textContent =
      meta.fullExchangeName ||
      meta.exchangeName ||
      meta.exchange ||
      "Yahoo Finance";
  }

  if (el.name) {
    el.name.textContent = name;
  }

  if (el.symbol) {
    el.symbol.textContent =
      meta.symbol || "-";
  }

  if (el.updated) {
    el.updated.textContent =
      formatDate(
        analysis.latest.timestamp
      );
  }

  if (el.price) {
    el.price.textContent =
      formatMoney(
        analysis.latest.close,
        currency
      );
  }

  if (el.currency) {
    el.currency.textContent =
      currency;
  }

  if (el.ttmDividend) {
    el.ttmDividend.textContent =
      `${formatMoney(
        analysis.latest.ttmDividend,
        currency
      )} ${currency}`;
  }

  if (el.currentYield) {
    el.currentYield.textContent =
      formatPercent(
        analysis.latest.dividendYield
      );
  }

  if (el.medianYield) {
    el.medianYield.textContent =
      formatPercent(
        analysis.levels.p50
      );
  }

  if (el.yieldPercentile) {
    el.yieldPercentile.textContent =
      Number.isFinite(
        analysis.currentRank
      )
        ? `${analysis.currentRank.toFixed(1)}%`
        : "-";
  }

  renderDividendStreak(analysis);

  const valuation =
    valuationForRank(
      analysis.currentRank
    );

  if (el.valuationLabel) {
    el.valuationLabel.textContent =
      valuation.label;
  }

  if (el.valuationDescription) {
    el.valuationDescription.textContent =
      valuation.description;
  }

  if (el.valuationCard) {
    el.valuationCard.classList.remove(
      "expensive",
      "neutral",
      "cheap"
    );

    el.valuationCard.classList.add(
      valuation.className
    );
  }
}

/* =========================================================
   차트 데이터 세트
========================================================= */

function createBandDataset(
  label,
  data,
  borderColor,
  backgroundColor,
  fill
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

/* =========================================================
   10년 배당수익률 밴드 차트
========================================================= */

function renderBandChart(
  analysis,
  currency
) {
  const canvas = $("#band-chart");

  if (
    !canvas ||
    typeof Chart === "undefined"
  ) {
    return;
  }

  const labels =
    analysis.points.map(
      (point) =>
        formatShortDate(
          point.timestamp
        )
    );

  const p10 =
    analysis.points.map(
      (point) =>
        priceAtYield(
          point.ttmDividend,
          analysis.levels.p10
        )
    );

  const p25 =
    analysis.points.map(
      (point) =>
        priceAtYield(
          point.ttmDividend,
          analysis.levels.p25
        )
    );

  const p50 =
    analysis.points.map(
      (point) =>
        priceAtYield(
          point.ttmDividend,
          analysis.levels.p50
        )
    );

  const p75 =
    analysis.points.map(
      (point) =>
        priceAtYield(
          point.ttmDividend,
          analysis.levels.p75
        )
    );

  const p90 =
    analysis.points.map(
      (point) =>
        priceAtYield(
          point.ttmDividend,
          analysis.levels.p90
        )
    );

  const actual =
    analysis.points.map(
      (point) => point.close
    );

  if (bandChart) {
    bandChart.destroy();
  }

  bandChart = new Chart(
    canvas.getContext("2d"),
    {
      type: "line",
      data: {
        labels,
        datasets: [
          createBandDataset(
            `P10 ${formatPercent(
              analysis.levels.p10
            )}`,
            p10,
            "#d93f4f",
            "rgba(217, 63, 79, 0.08)",
            false
          ),
          createBandDataset(
            `P25 ${formatPercent(
              analysis.levels.p25
            )}`,
            p25,
            "#ef872f",
            "rgba(239, 135, 47, 0.10)",
            "-1"
          ),
          createBandDataset(
            `중앙 ${formatPercent(
              analysis.levels.p50
            )}`,
            p50,
            "#d2ad18",
            "rgba(210, 173, 24, 0.10)",
            "-1"
          ),
          createBandDataset(
            `P75 ${formatPercent(
              analysis.levels.p75
            )}`,
            p75,
            "#55a873",
            "rgba(85, 168, 115, 0.10)",
            "-1"
          ),
          createBandDataset(
            `P90 ${formatPercent(
              analysis.levels.p90
            )}`,
            p90,
            "#118c68",
            "rgba(17, 140, 104, 0.10)",
            "-1"
          ),
          {
            label: "실제 주가",
            data: actual,
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
                const value =
                  Number(context.raw);

                return (
                  `${context.dataset.label}: ` +
                  `${formatMoney(
                    value,
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
            ticks: {
              maxTicksLimit: 8,
              maxRotation: 0,
              color: "#7a8494",
            },
          },
          y: {
            beginAtZero: false,
            grid: {
              color:
                "rgba(120, 132, 151, 0.12)",
            },
            ticks: {
              color: "#7a8494",
              callback(value) {
                return formatMoney(
                  Number(value),
                  currency
                );
              },
            },
          },
        },
      },
    }
  );

  renderBandPriceSummary(
    analysis,
    currency
  );
}

/* =========================================================
   현재 밴드별 가격
========================================================= */

function renderBandPriceSummary(
  analysis,
  currency
) {
  if (!el.bandSummary) return;

  const latest = analysis.latest;

  const items = [
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

  el.bandSummary.replaceChildren();

  items.forEach((item) => {
    const wrapper =
      document.createElement("div");

    wrapper.className =
      "band-price-item";

    const label =
      document.createElement("span");

    const value =
      document.createElement("strong");

    label.textContent = item.label;

    value.textContent =
      `${formatMoney(
        item.value,
        currency
      )} ${currency}`;

    wrapper.append(label, value);
    el.bandSummary.appendChild(wrapper);
  });
}

/* =========================================================
   연도별 배당금
========================================================= */

function makeAnnualDividendData(analysis) {
  const totals = new Map();

  const latestTimestamp =
    analysis.latest.timestamp;

  analysis.dividends.forEach((dividend) => {
    const year =
      new Date(dividend.date * 1000)
        .getUTCFullYear();

    const adjusted =
      adjustDividendForSplits(
        dividend,
        latestTimestamp,
        analysis.splits
      );

    totals.set(
      year,
      (totals.get(year) || 0) +
      adjusted
    );
  });

  const currentYear =
    new Date(latestTimestamp * 1000)
      .getUTCFullYear();

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
    totals: years.map(
      (year) => totals.get(year) || 0
    ),
  };
}

/* =========================================================
   연도별 배당금 차트
========================================================= */

function renderDividendChart(
  analysis,
  currency
) {
  const canvas =
    $("#dividend-chart");

  if (
    !canvas ||
    typeof Chart === "undefined"
  ) {
    return;
  }

  const annual =
    makeAnnualDividendData(analysis);

  if (dividendChart) {
    dividendChart.destroy();
  }

  dividendChart = new Chart(
    canvas.getContext("2d"),
    {
      type: "bar",
      data: {
        labels: annual.years.map(String),
        datasets: [
          {
            label:
              `연간 주당배당금 (${currency})`,
            data: annual.totals,
            borderColor: "#2457d6",
            backgroundColor:
              "rgba(36, 87, 214, 0.68)",
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
                  `배당금: ` +
                  `${formatMoney(
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
              color:
                "rgba(120, 132, 151, 0.12)",
            },
            ticks: {
              callback(value) {
                return formatMoney(
                  Number(value),
                  currency
                );
              },
            },
          },
        },
      },
    }
  );
}

/* =========================================================
   배당수익률 위치 표시
========================================================= */

function renderYieldPosition(analysis) {
  const rank =
    Number.isFinite(
      analysis.currentRank
    )
      ? Math.max(
          0,
          Math.min(
            100,
            analysis.currentRank
          )
        )
      : 0;

  if (el.marker) {
    el.marker.style.left =
      `${rank}%`;
  }

  if (el.markerText) {
    el.markerText.textContent =
      `${rank.toFixed(0)}백분위`;
  }

  if (el.p10) {
    el.p10.textContent =
      formatPercent(
        analysis.levels.p10
      );
  }

  if (el.p25) {
    el.p25.textContent =
      formatPercent(
        analysis.levels.p25
      );
  }

  if (el.p50) {
    el.p50.textContent =
      formatPercent(
        analysis.levels.p50
      );
  }

  if (el.p75) {
    el.p75.textContent =
      formatPercent(
        analysis.levels.p75
      );
  }

  if (el.p90) {
    el.p90.textContent =
      formatPercent(
        analysis.levels.p90
      );
  }
}

/* =========================================================
   배당 내역 표
========================================================= */

function renderDividendTable(
  analysis,
  currency
) {
  if (
    !el.dividendBody ||
    !el.dividendCount
  ) {
    return;
  }

  el.dividendBody.replaceChildren();

  const descending =
    [...analysis.dividends]
      .sort((a, b) => b.date - a.date);

  el.dividendCount.textContent =
    `${descending.length}건`;

  if (!descending.length) {
    const row =
      document.createElement("tr");

    const cell =
      document.createElement("td");

    cell.colSpan = 4;
    cell.className = "empty-table";
    cell.textContent =
      "최근 10년 배당금 내역이 없습니다.";

    row.appendChild(cell);
    el.dividendBody.appendChild(row);
    return;
  }

  descending.forEach((dividend) => {
    const adjusted =
      adjustDividendForSplits(
        dividend,
        analysis.latest.timestamp,
        analysis.splits
      );

    const row =
      document.createElement("tr");

    const dateCell =
      document.createElement("td");

    const originalCell =
      document.createElement("td");

    const adjustedCell =
      document.createElement("td");

    const currencyCell =
      document.createElement("td");

    dateCell.textContent =
      formatDate(dividend.date);

    originalCell.textContent =
      formatMoney(
        dividend.amount,
        currency
      );

    adjustedCell.textContent =
      formatMoney(
        adjusted,
        currency
      );

    currencyCell.textContent =
      currency;

    row.append(
      dateCell,
      originalCell,
      adjustedCell,
      currencyCell
    );

    el.dividendBody.appendChild(row);
  });
}

/* =========================================================
   정확한 티커 우선 검색
========================================================= */

function normalizeTicker(value) {
  return String(value || "")
    .trim()
    .toUpperCase();
}

function looksLikeTicker(value) {
  const ticker =
    normalizeTicker(value);

  return (
    /^[A-Z0-9][A-Z0-9.^=-]{0,14}$/
      .test(ticker)
  );
}

function isDirectLookupQuote(quote) {
  const source =
    String(quote?.source || "")
      .trim()
      .toUpperCase();

  const exchange =
    String(quote?.exchange || "")
      .trim();

  return (
    source === "DIRECT" ||
    source === "DIRECT_SYMBOL" ||
    exchange.includes(
      "Yahoo Finance 직접 조회"
    )
  );
}

async function getExactTickerQuote(query) {
  if (!looksLikeTicker(query)) {
    return null;
  }

  const requestedSymbol =
    normalizeTicker(query);

  try {
    const data =
      await requestJson(
        "/api/stock",
        {
          symbol: requestedSymbol,
        }
      );

    const result = data?.result;

    if (!result) {
      return null;
    }

    const meta = result.meta || {};

    const resolvedSymbol =
      normalizeTicker(
        meta.symbol ||
        data.resolvedSymbol ||
        data.symbol
      );

    if (
      !resolvedSymbol ||
      resolvedSymbol !== requestedSymbol
    ) {
      return null;
    }

    const name =
      String(
        meta.longName ||
        meta.shortName ||
        resolvedSymbol
      ).trim();

    const exchange =
      String(
        meta.fullExchangeName ||
        meta.exchangeName ||
        meta.exchange ||
        ""
      ).trim();

    exactStockCache.set(
      resolvedSymbol,
      data
    );

    return {
      symbol: resolvedSymbol,
      name,
      longname: name,
      shortname: name,
      exchange,
      exchangeDisplay: exchange,
      type:
        meta.instrumentType ||
        "EQUITY",
      market: "GLOBAL",
      source: "EXACT_SYMBOL",
    };
  } catch {
    return null;
  }
}

function mergeSearchQuotes(
  query,
  exactQuote,
  searchQuotes
) {
  const requestedSymbol =
    normalizeTicker(query);

  const merged = [];
  const usedSymbols = new Set();

  if (exactQuote) {
    const symbol =
      normalizeTicker(
        exactQuote.symbol
      );

    if (symbol) {
      merged.push(exactQuote);
      usedSymbols.add(symbol);
    }
  }

  searchQuotes.forEach((quote) => {
    if (
      !quote ||
      isDirectLookupQuote(quote)
    ) {
      return;
    }

    const symbol =
      normalizeTicker(
        quote.symbol
      );

    if (
      !symbol ||
      usedSymbols.has(symbol)
    ) {
      return;
    }

    merged.push(quote);
    usedSymbols.add(symbol);
  });

  return merged
    .map((quote, originalIndex) => ({
      quote,
      originalIndex,
      exact:
        normalizeTicker(
          quote.symbol
        ) === requestedSymbol,
    }))
    .sort((a, b) => {
      if (a.exact !== b.exact) {
        return a.exact ? -1 : 1;
      }

      return (
        a.originalIndex -
        b.originalIndex
      );
    })
    .map((item) => item.quote);
}

/* =========================================================
   검색 결과 버튼
========================================================= */

function createSearchResultButton(quote) {
  const symbol =
    String(quote.symbol || "")
      .trim();

  if (!symbol) {
    return null;
  }

  const name =
    String(
      quote.name ||
      quote.longname ||
      quote.shortname ||
      symbol
    ).trim();

  const exchange =
    String(
      quote.exchange ||
      quote.exchangeDisplay ||
      quote.exchDisp ||
      ""
    ).trim();

  const button =
    document.createElement("button");

  button.type = "button";
  button.className = "search-result";

  button.setAttribute(
    "role",
    "option"
  );

  button.setAttribute(
    "aria-selected",
    "false"
  );

  const main =
    document.createElement("div");

  main.className =
    "search-result-main";

  const strong =
    document.createElement("strong");

  strong.textContent = name;

  const small =
    document.createElement("small");

  small.textContent =
    [symbol, exchange]
      .filter(Boolean)
      .join(" • ");

  const symbolBox =
    document.createElement("div");

  symbolBox.className =
    "search-result-symbol";

  symbolBox.textContent = symbol;

  main.append(strong, small);
  button.append(main, symbolBox);

  button.addEventListener(
    "click",
    () => {
      selectSymbol(
        symbol,
        name
      );
    }
  );

  return button;
}

/* =========================================================
   검색 결과 키보드 선택
========================================================= */

function getSearchResultButtons() {
  if (!el.results) {
    return [];
  }

  return [
    ...el.results.querySelectorAll(
      ".search-result"
    ),
  ];
}

function updateActiveSearchResult(
  nextIndex
) {
  const buttons =
    getSearchResultButtons();

  if (!buttons.length) {
    activeSearchIndex = -1;
    return;
  }

  activeSearchIndex =
    (
      nextIndex +
      buttons.length
    ) % buttons.length;

  buttons.forEach((button, index) => {
    const active =
      index === activeSearchIndex;

    button.classList.toggle(
      "active",
      active
    );

    button.setAttribute(
      "aria-selected",
      active ? "true" : "false"
    );
  });

  buttons[
    activeSearchIndex
  ].scrollIntoView({
    block: "nearest",
  });
}

/* =========================================================
   종목 검색
========================================================= */

async function handleSearch(event) {
  event.preventDefault();

  const query =
    el.input?.value.trim() || "";

  if (!query) {
    return;
  }

  showLoading(true);
  clearError();
  closeResults();

  try {
    const [
      searchData,
      exactQuote,
    ] = await Promise.all([
      requestJson(
        "/api/search",
        { q: query }
      ),
      getExactTickerQuote(query),
    ]);

    const searchQuotes =
      Array.isArray(
        searchData?.quotes
      )
        ? searchData.quotes
        : [];

    const quotes =
      mergeSearchQuotes(
        query,
        exactQuote,
        searchQuotes
      );

    if (!quotes.length) {
      const message =
        document.createElement("div");

      message.className =
        "search-empty-message";

      message.textContent =
        "검색 결과가 없습니다. 정확한 종목명이나 티커를 입력해 주세요.";

      el.results.appendChild(message);
      return;
    }

    quotes.forEach((quote) => {
      const button =
        createSearchResultButton(
          quote
        );

      if (button) {
        el.results.appendChild(button);
      }
    });

    activeSearchIndex = -1;
  } catch (error) {
    showError(error);
  } finally {
    showLoading(false);
  }
}

/* =========================================================
   종목 선택 및 분석
========================================================= */

async function selectSymbol(symbol, name) {
  const normalizedSymbol =
    normalizeTicker(symbol);

  selectedName =
    name || symbol;

  closeResults();
  clearError();
  showLoading(true);

  try {
    let data =
      exactStockCache.get(
        normalizedSymbol
      );

    if (!data) {
      data =
        await requestJson(
          "/api/stock",
          { symbol }
        );
    }

    const result = data?.result;

    if (!result) {
      throw new Error(
        "Yahoo Finance 종목 데이터를 찾지 못했습니다."
      );
    }

    const analysis =
      analyzeStock(result);

    const currency =
      result.meta?.currency ||
      "USD";

    renderSummary(
      result,
      analysis
    );

    renderBandChart(
      analysis,
      currency
    );

    renderDividendChart(
      analysis,
      currency
    );

    renderYieldPosition(analysis);

    renderDividendTable(
      analysis,
      currency
    );

    if (el.start) {
      el.start.classList.add(
        "hidden"
      );
    }

    if (el.dashboard) {
      el.dashboard.classList.remove(
        "hidden"
      );
    }

    if (el.input) {
      el.input.value =
        selectedName;
    }

    window.scrollTo({
      top: 0,
      behavior: "smooth",
    });
  } catch (error) {
    showError(error);
  } finally {
    showLoading(false);
  }
}

/* =========================================================
   이벤트
========================================================= */

if (el.form) {
  el.form.addEventListener(
    "submit",
    handleSearch
  );
}

document
  .querySelectorAll(".example-button")
  .forEach((button) => {
    button.addEventListener(
      "click",
      () => {
        const query =
          button.dataset.query ||
          button.textContent.trim();

        if (el.input) {
          el.input.value = query;
        }

        if (
          typeof el.form
            ?.requestSubmit === "function"
        ) {
          el.form.requestSubmit();
        } else if (el.form) {
          el.form.dispatchEvent(
            new Event(
              "submit",
              {
                bubbles: true,
                cancelable: true,
              }
            )
          );
        }
      }
    );
  });

document.addEventListener(
  "click",
  (event) => {
    const insideForm =
      el.form?.contains(
        event.target
      );

    const insideResults =
      el.results?.contains(
        event.target
      );

    if (
      !insideForm &&
      !insideResults
    ) {
      closeResults();
    }
  }
);

document.addEventListener(
  "keydown",
  (event) => {
    const buttons =
      getSearchResultButtons();

    if (event.key === "Escape") {
      closeResults();
      el.input?.focus();
      return;
    }

    if (!buttons.length) {
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();

      updateActiveSearchResult(
        activeSearchIndex + 1
      );

      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();

      updateActiveSearchResult(
        activeSearchIndex <= 0
          ? buttons.length - 1
          : activeSearchIndex - 1
      );

      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();

      const targetIndex =
        activeSearchIndex >= 0
          ? activeSearchIndex
          : 0;

      buttons[targetIndex]?.click();
    }
  }
);
