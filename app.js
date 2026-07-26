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
  yieldPercentile:
    $("#yield-percentile"),
  dividendStreak:
    $("#dividend-streak"),

  valuationCard:
    $("#valuation-card"),
  valuationLabel:
    $("#valuation-label"),
  valuationDescription:
    $("#valuation-description"),

  p10: $("#p10-yield"),
  p25: $("#p25-yield"),
  p50: $("#p50-yield"),
  p75: $("#p75-yield"),
  p90: $("#p90-yield"),

  marker: $("#yield-marker"),
  markerText:
    $("#yield-marker-text"),

  bandSummary:
    $("#band-price-summary"),
  dividendCount:
    $("#dividend-count"),
  dividendBody:
    $("#dividend-table-body"),
};

let bandChart = null;
let dividendChart = null;
let selectedName = "";
let activeSearchIndex = -1;

const exactStockCache =
  new Map();

/* =========================================================
   API
========================================================= */

function apiUrl(
  path,
  parameters = {}
) {
  const base =
    API_BASE.replace(/\/+$/, "");

  const url =
    new URL(`${base}${path}`);

  Object.entries(parameters)
    .forEach(([key, value]) => {
      if (
        value !== undefined &&
        value !== null
      ) {
        url.searchParams.set(
          key,
          String(value)
        );
      }
    });

  return url.toString();
}

async function requestJson(
  path,
  parameters = {}
) {
  const response =
    await fetch(
      apiUrl(
        path,
        parameters
      ),
      {
        method: "GET",
        headers: {
          Accept:
            "application/json",
        },
      }
    );

  let data;

  try {
    data =
      await response.json();
  } catch {
    throw new Error(
      "서버 응답을 읽지 못했습니다."
    );
  }

  if (!response.ok) {
    throw new Error(
      data?.error ||
      `서버 요청 실패 (${response.status})`
    );
  }

  return data;
}

/* =========================================================
   화면 상태
========================================================= */

function showLoading(show) {
  if (el.loading) {
    el.loading.classList.toggle(
      "hidden",
      !show
    );
  }

  if (el.button) {
    el.button.disabled = show;
  }
}

function clearError() {
  if (!el.error) return;

  el.error.textContent = "";
  el.error.classList.add(
    "hidden"
  );
}

function showError(error) {
  if (!el.error) return;

  el.error.textContent =
    error instanceof Error
      ? error.message
      : String(error);

  el.error.classList.remove(
    "hidden"
  );
}

function closeResults() {
  el.results?.replaceChildren();
  activeSearchIndex = -1;
}

/* =========================================================
   표시 형식
========================================================= */

function formatDate(timestamp) {
  if (
    !Number.isFinite(timestamp)
  ) {
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
  ).format(
    new Date(timestamp * 1000)
  );
}

function formatShortDate(timestamp) {
  if (
    !Number.isFinite(timestamp)
  ) {
    return "";
  }

  return new Intl.DateTimeFormat(
    "ko-KR",
    {
      year: "2-digit",
      month: "2-digit",
      timeZone: "UTC",
    }
  ).format(
    new Date(timestamp * 1000)
  );
}

function moneyDigits(currency) {
  return currency === "KRW"
    ? 0
    : 2;
}

function formatMoney(
  value,
  currency = "USD"
) {
  if (
    !Number.isFinite(value)
  ) {
    return "-";
  }

  const digits =
    moneyDigits(currency);

  return new Intl.NumberFormat(
    "ko-KR",
    {
      minimumFractionDigits:
        digits,
      maximumFractionDigits:
        digits,
    }
  ).format(value);
}

function formatPercent(
  value,
  digits = 2
) {
  return Number.isFinite(value)
    ? `${value.toFixed(digits)}%`
    : "-";
}

/* =========================================================
   통계
========================================================= */

function median(values) {
  if (!values.length) {
    return NaN;
  }

  const sorted =
    [...values].sort(
      (a, b) => a - b
    );

  const middle =
    Math.floor(
      sorted.length / 2
    );

  return sorted.length % 2
    ? sorted[middle]
    : (
        sorted[middle - 1] +
        sorted[middle]
      ) / 2;
}

function percentile(
  sortedValues,
  probability
) {
  if (!sortedValues.length) {
    return NaN;
  }

  if (
    sortedValues.length === 1
  ) {
    return sortedValues[0];
  }

  const position =
    (
      sortedValues.length - 1
    ) * probability;

  const lower =
    Math.floor(position);

  const upper =
    Math.ceil(position);

  const fraction =
    position - lower;

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

function percentileRank(
  values,
  current
) {
  if (
    !values.length ||
    !Number.isFinite(current)
  ) {
    return NaN;
  }

  return (
    values.filter(
      (value) =>
        value <= current
    ).length /
    values.length
  ) * 100;
}

/* =========================================================
   배당 데이터
========================================================= */

function normalizeDividendObject(
  dividendObject
) {
  return Object.values(
    dividendObject || {}
  )
    .map((item) => ({
      date: Number(item.date),
      amount:
        Number(item.amount),
    }))
    .filter(
      (item) =>
        Number.isFinite(
          item.date
        ) &&
        Number.isFinite(
          item.amount
        ) &&
        item.amount >= 0
    )
    .sort(
      (a, b) =>
        a.date - b.date
    );
}

function normalizeEvents(result) {
  const dividends =
    normalizeDividendObject(
      result.events
        ?.dividends
    );

  const splits =
    Object.values(
      result.events?.splits ||
      {}
    )
      .map((item) => ({
        date:
          Number(item.date),
        numerator:
          Number(
            item.numerator
          ),
        denominator:
          Number(
            item.denominator
          ),
        splitRatio:
          item.splitRatio ||
          "",
      }))
      .filter(
        (item) =>
          Number.isFinite(
            item.date
          )
      )
      .sort(
        (a, b) =>
          a.date - b.date
      );

  return {
    dividends,
    splits,
  };
}

/*
 * Yahoo Finance는 과거 종가와 배당금을
 * 이미 주식분할 보정해서 반환합니다.
 */
function adjustDividendForSplits(
  dividend,
  _targetTimestamp,
  _splits
) {
  const amount =
    Number(dividend?.amount);

  return (
    Number.isFinite(amount) &&
    amount >= 0
  )
    ? amount
    : 0;
}

function groupDividendsByDate(
  dividends,
  targetTimestamp,
  splits
) {
  const grouped =
    new Map();

  dividends.forEach(
    (dividend) => {
      const key =
        new Date(
          dividend.date * 1000
        )
          .toISOString()
          .slice(0, 10);

      const amount =
        adjustDividendForSplits(
          dividend,
          targetTimestamp,
          splits
        );

      const existing =
        grouped.get(key);

      if (existing) {
        existing.amount +=
          amount;
      } else {
        grouped.set(key, {
          date: dividend.date,
          amount,
        });
      }
    }
  );

  return [
    ...grouped.values(),
  ].sort(
    (a, b) =>
      a.date - b.date
  );
}

function estimatePaymentsPerYear(
  timestamp,
  dividends
) {
  const recent =
    dividends
      .filter(
        (item) =>
          item.date <=
            timestamp &&
          item.date >=
            timestamp -
            3.2 * YEAR
      )
      .sort(
        (a, b) =>
          a.date - b.date
      );

  if (recent.length < 2) {
    return 1;
  }

  const unique = [];

  recent.forEach((item) => {
    const previous =
      unique[
        unique.length - 1
      ];

    if (
      previous === undefined ||
      Math.abs(
        item.date - previous
      ) > DAY
    ) {
      unique.push(item.date);
    }
  });

  const intervals = [];

  for (
    let index = 1;
    index < unique.length;
    index += 1
  ) {
    const days =
      (
        unique[index] -
        unique[index - 1]
      ) / DAY;

    if (
      days >= 10 &&
      days <= 450
    ) {
      intervals.push(days);
    }
  }

  const typical =
    median(
      intervals.slice(-12)
    );

  if (
    !Number.isFinite(typical)
  ) {
    return 1;
  }

  if (typical <= 45) {
    return 12;
  }

  if (typical <= 135) {
    return 4;
  }

  if (typical <= 240) {
    return 2;
  }

  return 1;
}

function ttmDividendAt(
  timestamp,
  dividends,
  splits
) {
  const candidates =
    dividends.filter(
      (item) =>
        item.date >
          timestamp -
          400 * DAY &&
        item.date <= timestamp
    );

  if (!candidates.length) {
    return 0;
  }

  const count =
    estimatePaymentsPerYear(
      timestamp,
      dividends
    );

  return groupDividendsByDate(
    candidates,
    timestamp,
    splits
  )
    .slice(-count)
    .reduce(
      (sum, item) =>
        sum + item.amount,
      0
    );
}

/* =========================================================
   종목 분석
========================================================= */

function analyzeStock(result) {
  const timestamps =
    Array.isArray(
      result?.timestamp
    )
      ? result.timestamp
      : [];

  const closes =
    result?.indicators
      ?.quote?.[0]?.close ||
    [];

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
      timestamps[
        timestamps.length - 1
      ]
    );

  const cutoff =
    lastTimestamp -
    10 * YEAR;

  const points = [];

  timestamps.forEach(
    (rawTimestamp, index) => {
      const timestamp =
        Number(rawTimestamp);

      const close =
        Number(closes[index]);

      if (
        !Number.isFinite(
          timestamp
        ) ||
        !Number.isFinite(close) ||
        close <= 0 ||
        timestamp < cutoff
      ) {
        return;
      }

      const ttmDividend =
        ttmDividendAt(
          timestamp,
          dividends,
          splits
        );

      points.push({
        timestamp,
        close,
        ttmDividend,
        dividendYield:
          ttmDividend > 0
            ? (
                ttmDividend /
                close
              ) * 100
            : 0,
      });
    }
  );

  if (!points.length) {
    throw new Error(
      "최근 10년의 유효한 주가 데이터가 없습니다."
    );
  }

  const validYields =
    points
      .map(
        (point) =>
          point.dividendYield
      )
      .filter(
        (value) =>
          Number.isFinite(value) &&
          value > 0 &&
          value < 100
      )
      .sort(
        (a, b) => a - b
      );

  if (
    validYields.length < 20
  ) {
    throw new Error(
      "최근 10년 배당 데이터가 부족합니다."
    );
  }

  const levels = {
    p10:
      percentile(
        validYields,
        0.1
      ),
    p25:
      percentile(
        validYields,
        0.25
      ),
    p50:
      percentile(
        validYields,
        0.5
      ),
    p75:
      percentile(
        validYields,
        0.75
      ),
    p90:
      percentile(
        validYields,
        0.9
      ),
  };

  const latest =
    points[
      points.length - 1
    ];

  return {
    points,
    dividends:
      dividends.filter(
        (item) =>
          item.date >= cutoff &&
          item.date <=
            lastTimestamp
      ),
    allDividends: dividends,
    splits,
    levels,
    latest,
    currentRank:
      percentileRank(
        validYields,
        latest.dividendYield
      ),
  };
}

/* =========================================================
   정확한 배당 증가·유지 기간
========================================================= */

function calculateDividendStreak(
  dividends,
  latestTimestamp
) {
  if (!dividends.length) {
    return 0;
  }

  const annualTotals =
    new Map();

  dividends.forEach(
    (dividend) => {
      const year =
        new Date(
          dividend.date * 1000
        ).getUTCFullYear();

      annualTotals.set(
        year,
        (
          annualTotals.get(
            year
          ) || 0
        ) + dividend.amount
      );
    }
  );

  const latestYear =
    new Date(
      latestTimestamp * 1000
    ).getUTCFullYear();

  /*
   * 진행 중인 연도는 제외합니다.
   */
  const completedYears =
    [...annualTotals.keys()]
      .filter(
        (year) =>
          year < latestYear
      )
      .sort(
        (a, b) => a - b
      );

  if (
    completedYears.length < 2
  ) {
    return 0;
  }

  let currentYear =
    completedYears[
      completedYears.length - 1
    ];

  let streak = 0;

  while (true) {
    const previousYear =
      currentYear - 1;

    if (
      !annualTotals.has(
        currentYear
      ) ||
      !annualTotals.has(
        previousYear
      )
    ) {
      break;
    }

    const currentTotal =
      annualTotals.get(
        currentYear
      );

    const previousTotal =
      annualTotals.get(
        previousYear
      );

    const tolerance =
      Math.max(
        0.000001,
        Math.abs(
          previousTotal
        ) * 0.000001
      );

    if (
      currentTotal +
        tolerance <
      previousTotal
    ) {
      break;
    }

    streak += 1;
    currentYear =
      previousYear;
  }

  return streak;
}

function renderDividendStreak(
  historyData,
  analysis
) {
  if (!el.dividendStreak) {
    return;
  }

  const dividends =
    normalizeDividendObject(
      historyData?.events
        ?.dividends
    );

  const years =
    calculateDividendStreak(
      dividends,
      analysis.latest.timestamp
    );

  el.dividendStreak
    .textContent =
      `${years}년`;
}

/* =========================================================
   평가 및 요약
========================================================= */

function priceAtYield(
  dividend,
  yieldPercent
) {
  if (
    !Number.isFinite(dividend) ||
    !Number.isFinite(
      yieldPercent
    ) ||
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
  if (
    !Number.isFinite(rank)
  ) {
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

function renderSummary(
  result,
  analysis,
  historyData
) {
  const meta =
    result.meta || {};

  const currency =
    meta.currency || "USD";

  if (el.exchange) {
    el.exchange.textContent =
      meta.fullExchangeName ||
      meta.exchangeName ||
      "Yahoo Finance";
  }

  if (el.name) {
    el.name.textContent =
      selectedName ||
      meta.longName ||
      meta.shortName ||
      meta.symbol;
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
        analysis.latest
          .ttmDividend,
        currency
      )} ${currency}`;
  }

  if (el.currentYield) {
    el.currentYield.textContent =
      formatPercent(
        analysis.latest
          .dividendYield
      );
  }

  if (el.medianYield) {
    el.medianYield.textContent =
      formatPercent(
        analysis.levels.p50
      );
  }

  if (el.yieldPercentile) {
    el.yieldPercentile
      .textContent =
      `${analysis.currentRank.toFixed(1)}%`;
  }

  renderDividendStreak(
    historyData,
    analysis
  );

  const valuation =
    valuationForRank(
      analysis.currentRank
    );

  if (el.valuationLabel) {
    el.valuationLabel
      .textContent =
      valuation.label;
  }

  if (
    el.valuationDescription
  ) {
    el.valuationDescription
      .textContent =
      valuation.description;
  }

  if (el.valuationCard) {
    el.valuationCard
      .classList.remove(
        "expensive",
        "neutral",
        "cheap"
      );

    el.valuationCard
      .classList.add(
        valuation.className
      );
  }
}

/* =========================================================
   밴드 차트
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

function renderBandChart(
  analysis,
  currency
) {
  const canvas =
    $("#band-chart");

  if (
    !canvas ||
    typeof Chart ===
      "undefined"
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

  const makePrices =
    (level) =>
      analysis.points.map(
        (point) =>
          priceAtYield(
            point.ttmDividend,
            level
          )
      );

  if (bandChart) {
    bandChart.destroy();
  }

  bandChart =
    new Chart(
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
              makePrices(
                analysis.levels.p10
              ),
              "#d93f4f",
              "rgba(217,63,79,.08)",
              false
            ),
            createBandDataset(
              `P25 ${formatPercent(
                analysis.levels.p25
              )}`,
              makePrices(
                analysis.levels.p25
              ),
              "#ef872f",
              "rgba(239,135,47,.10)",
              "-1"
            ),
            createBandDataset(
              `중앙 ${formatPercent(
                analysis.levels.p50
              )}`,
              makePrices(
                analysis.levels.p50
              ),
              "#d2ad18",
              "rgba(210,173,24,.10)",
              "-1"
            ),
            createBandDataset(
              `P75 ${formatPercent(
                analysis.levels.p75
              )}`,
              makePrices(
                analysis.levels.p75
              ),
              "#55a873",
              "rgba(85,168,115,.10)",
              "-1"
            ),
            createBandDataset(
              `P90 ${formatPercent(
                analysis.levels.p90
              )}`,
              makePrices(
                analysis.levels.p90
              ),
              "#118c68",
              "rgba(17,140,104,.10)",
              "-1"
            ),
            {
              label:
                "실제 주가",
              data:
                analysis.points.map(
                  (point) =>
                    point.close
                ),
              borderColor:
                "#155eef",
              backgroundColor:
                "#155eef",
              borderWidth: 3,
              pointRadius: 0,
              pointHoverRadius: 4,
              tension: 0.12,
              fill: false,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio:
            false,
          interaction: {
            mode: "index",
            intersect: false,
          },
          plugins: {
            legend: {
              position: "bottom",
            },
            tooltip: {
              callbacks: {
                label(context) {
                  return (
                    `${context.dataset.label}: ` +
                    `${formatMoney(
                      Number(
                        context.raw
                      ),
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
              },
            },
            y: {
              beginAtZero: false,
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

  renderBandPriceSummary(
    analysis,
    currency
  );
}

function renderBandPriceSummary(
  analysis,
  currency
) {
  if (!el.bandSummary) {
    return;
  }

  const items = [
    ["고평가 P10 가격", "p10"],
    ["P25 가격", "p25"],
    ["중앙 가격", "p50"],
    ["P75 가격", "p75"],
    ["저평가 P90 가격", "p90"],
  ];

  el.bandSummary
    .replaceChildren();

  items.forEach(
    ([label, key]) => {
      const wrapper =
        document.createElement(
          "div"
        );

      wrapper.className =
        "band-price-item";

      const labelElement =
        document.createElement(
          "span"
        );

      const valueElement =
        document.createElement(
          "strong"
        );

      labelElement.textContent =
        label;

      valueElement.textContent =
        `${formatMoney(
          priceAtYield(
            analysis.latest
              .ttmDividend,
            analysis.levels[key]
          ),
          currency
        )} ${currency}`;

      wrapper.append(
        labelElement,
        valueElement
      );

      el.bandSummary
        .appendChild(wrapper);
    }
  );
}

/* =========================================================
   배당 차트 및 표
========================================================= */

function makeAnnualDividendData(
  analysis
) {
  const totals = new Map();

  analysis.dividends.forEach(
    (dividend) => {
      const year =
        new Date(
          dividend.date * 1000
        ).getUTCFullYear();

      totals.set(
        year,
        (
          totals.get(year) ||
          0
        ) + dividend.amount
      );
    }
  );

  const currentYear =
    new Date(
      analysis.latest
        .timestamp * 1000
    ).getUTCFullYear();

  const years = [];

  for (
    let year =
      currentYear - 9;
    year <= currentYear;
    year += 1
  ) {
    years.push(year);
  }

  return {
    years,
    totals:
      years.map(
        (year) =>
          totals.get(year) ||
          0
      ),
  };
}

function renderDividendChart(
  analysis,
  currency
) {
  const canvas =
    $("#dividend-chart");

  if (
    !canvas ||
    typeof Chart ===
      "undefined"
  ) {
    return;
  }

  const annual =
    makeAnnualDividendData(
      analysis
    );

  if (dividendChart) {
    dividendChart.destroy();
  }

  dividendChart =
    new Chart(
      canvas.getContext("2d"),
      {
        type: "bar",
        data: {
          labels:
            annual.years.map(
              String
            ),
          datasets: [
            {
              label:
                `연간 주당배당금 (${currency})`,
              data:
                annual.totals,
              backgroundColor:
                "rgba(36,87,214,.68)",
              borderColor:
                "#2457d6",
              borderWidth: 1,
              borderRadius: 5,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio:
            false,
          plugins: {
            legend: {
              display: false,
            },
          },
          scales: {
            y: {
              beginAtZero: true,
            },
          },
        },
      }
    );
}

function renderYieldPosition(
  analysis
) {
  const rank =
    Math.max(
      0,
      Math.min(
        100,
        analysis.currentRank
      )
    );

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

  const dividends =
    [...analysis.dividends]
      .sort(
        (a, b) =>
          b.date - a.date
      );

  el.dividendCount
    .textContent =
      `${dividends.length}건`;

  el.dividendBody
    .replaceChildren();

  dividends.forEach(
    (dividend) => {
      const row =
        document.createElement(
          "tr"
        );

      [
        formatDate(
          dividend.date
        ),
        formatMoney(
          dividend.amount,
          currency
        ),
        formatMoney(
          dividend.amount,
          currency
        ),
        currency,
      ].forEach((text) => {
        const cell =
          document.createElement(
            "td"
          );

        cell.textContent = text;
        row.appendChild(cell);
      });

      el.dividendBody
        .appendChild(row);
    }
  );
}

/* =========================================================
   검색
========================================================= */

function normalizeTicker(value) {
  return String(value || "")
    .trim()
    .toUpperCase();
}

function looksLikeTicker(value) {
  return /^[A-Z0-9][A-Z0-9.^=-]{0,14}$/
    .test(
      normalizeTicker(value)
    );
}

async function getExactTickerQuote(
  query
) {
  if (!looksLikeTicker(query)) {
    return null;
  }

  const requested =
    normalizeTicker(query);

  try {
    const data =
      await requestJson(
        "/api/stock",
        {
          symbol: requested,
        }
      );

    const result =
      data?.result;

    const meta =
      result?.meta || {};

    const resolved =
      normalizeTicker(
        meta.symbol ||
        data.resolvedSymbol
      );

    if (
      !result ||
      resolved !== requested
    ) {
      return null;
    }

    exactStockCache.set(
      resolved,
      data
    );

    const name =
      meta.longName ||
      meta.shortName ||
      resolved;

    return {
      symbol: resolved,
      name,
      exchange:
        meta.fullExchangeName ||
        meta.exchangeName ||
        "",
      source:
        "EXACT_SYMBOL",
    };
  } catch {
    return null;
  }
}

function createSearchResultButton(
  quote
) {
  const symbol =
    String(
      quote.symbol || ""
    ).trim();

  if (!symbol) return null;

  const name =
    quote.name ||
    quote.longname ||
    quote.shortname ||
    symbol;

  const exchange =
    quote.exchange ||
    quote.exchangeDisplay ||
    quote.exchDisp ||
    "";

  const button =
    document.createElement(
      "button"
    );

  button.type = "button";
  button.className =
    "search-result";

  const main =
    document.createElement(
      "div"
    );

  main.className =
    "search-result-main";

  const strong =
    document.createElement(
      "strong"
    );

  strong.textContent = name;

  const small =
    document.createElement(
      "small"
    );

  small.textContent =
    [symbol, exchange]
      .filter(Boolean)
      .join(" • ");

  const symbolBox =
    document.createElement(
      "div"
    );

  symbolBox.className =
    "search-result-symbol";

  symbolBox.textContent =
    symbol;

  main.append(strong, small);
  button.append(
    main,
    symbolBox
  );

  button.addEventListener(
    "click",
    () =>
      selectSymbol(
        symbol,
        name
      )
  );

  return button;
}

function getSearchResultButtons() {
  return [
    ...(
      el.results
        ?.querySelectorAll(
          ".search-result"
        ) || []
    ),
  ];
}

function updateActiveSearchResult(
  nextIndex
) {
  const buttons =
    getSearchResultButtons();

  if (!buttons.length) return;

  activeSearchIndex =
    (
      nextIndex +
      buttons.length
    ) % buttons.length;

  buttons.forEach(
    (button, index) => {
      button.classList.toggle(
        "active",
        index ===
          activeSearchIndex
      );
    }
  );

  buttons[
    activeSearchIndex
  ].scrollIntoView({
    block: "nearest",
  });
}

async function handleSearch(event) {
  event.preventDefault();

  const query =
    el.input?.value.trim();

  if (!query) return;

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
      getExactTickerQuote(
        query
      ),
    ]);

    const result = [];
    const used = new Set();

    if (exactQuote) {
      result.push(exactQuote);
      used.add(
        normalizeTicker(
          exactQuote.symbol
        )
      );
    }

    (
      searchData.quotes || []
    ).forEach((quote) => {
      const source =
        String(
          quote.source || ""
        ).toUpperCase();

      const exchange =
        String(
          quote.exchange || ""
        );

      const symbol =
        normalizeTicker(
          quote.symbol
        );

      if (
        !symbol ||
        used.has(symbol) ||
        source ===
          "DIRECT_SYMBOL" ||
        source === "DIRECT" ||
        exchange.includes(
          "Yahoo Finance 직접 조회"
        )
      ) {
        return;
      }

      used.add(symbol);
      result.push(quote);
    });

    if (!result.length) {
      const message =
        document.createElement(
          "div"
        );

      message.className =
        "search-empty-message";

      message.textContent =
        "검색 결과가 없습니다.";

      el.results.appendChild(
        message
      );

      return;
    }

    result.forEach((quote) => {
      const button =
        createSearchResultButton(
          quote
        );

      if (button) {
        el.results.appendChild(
          button
        );
      }
    });
  } catch (error) {
    showError(error);
  } finally {
    showLoading(false);
  }
}

/* =========================================================
   종목 선택
========================================================= */

async function selectSymbol(
  symbol,
  name
) {
  const normalized =
    normalizeTicker(symbol);

  selectedName =
    name || symbol;

  closeResults();
  clearError();
  showLoading(true);

  try {
    const stockPromise =
      exactStockCache.has(
        normalized
      )
        ? Promise.resolve(
            exactStockCache.get(
              normalized
            )
          )
        : requestJson(
            "/api/stock",
            { symbol }
          );

    const historyPromise =
      requestJson(
        "/api/dividend-history",
        { symbol }
      );

    const [
      stockData,
      historyData,
    ] = await Promise.all([
      stockPromise,
      historyPromise,
    ]);

    const result =
      stockData?.result;

    if (!result) {
      throw new Error(
        "종목 데이터를 찾지 못했습니다."
      );
    }

    const analysis =
      analyzeStock(result);

    const currency =
      result.meta?.currency ||
      "USD";

    renderSummary(
      result,
      analysis,
      historyData
    );

    renderBandChart(
      analysis,
      currency
    );

    renderDividendChart(
      analysis,
      currency
    );

    renderYieldPosition(
      analysis
    );

    renderDividendTable(
      analysis,
      currency
    );

    el.start?.classList.add(
      "hidden"
    );

    el.dashboard
      ?.classList.remove(
        "hidden"
      );

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

el.form?.addEventListener(
  "submit",
  handleSearch
);

document
  .querySelectorAll(
    ".example-button"
  )
  .forEach((button) => {
    button.addEventListener(
      "click",
      () => {
        el.input.value =
          button.dataset.query ||
          button.textContent
            .trim();

        el.form.requestSubmit();
      }
    );
  });

document.addEventListener(
  "click",
  (event) => {
    if (
      !el.form?.contains(
        event.target
      ) &&
      !el.results?.contains(
        event.target
      )
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

    if (
      event.key === "Escape"
    ) {
      closeResults();
      return;
    }

    if (!buttons.length) return;

    if (
      event.key ===
      "ArrowDown"
    ) {
      event.preventDefault();

      updateActiveSearchResult(
        activeSearchIndex + 1
      );
    }

    if (
      event.key ===
      "ArrowUp"
    ) {
      event.preventDefault();

      updateActiveSearchResult(
        activeSearchIndex <= 0
          ? buttons.length - 1
          : activeSearchIndex - 1
      );
    }

    if (
      event.key === "Enter"
    ) {
      event.preventDefault();

      buttons[
        activeSearchIndex >= 0
          ? activeSearchIndex
          : 0
      ]?.click();
    }
  }
);
