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

/* =========================================================
   API
========================================================= */

function apiUrl(path, parameters = {}) {
  const base = API_BASE.replace(/\/+$/, "");
  const url = new URL(`${base}${path}`);

  Object.entries(parameters).forEach(
    ([key, value]) => {
      if (
        value !== undefined &&
        value !== null
      ) {
        url.searchParams.set(
          key,
          String(value)
        );
      }
    }
  );

  return url.toString();
}

async function requestJson(
  path,
  parameters = {}
) {
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
      data.error ||
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
  if (!el.error) {
    return;
  }

  el.error.textContent = "";
  el.error.classList.add("hidden");
}

function showError(error) {
  if (!el.error) {
    return;
  }

  const message =
    error instanceof Error
      ? error.message
      : String(error);

  el.error.textContent = message;
  el.error.classList.remove("hidden");
}

function closeResults() {
  activeSearchIndex = -1;

  if (el.results) {
    el.results.replaceChildren();
  }
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
  ).format(
    new Date(timestamp * 1000)
  );
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
  ).format(
    new Date(timestamp * 1000)
  );
}

function moneyDigits(currency) {
  return currency === "KRW" ? 0 : 2;
}

function formatMoney(
  value,
  currency = "USD"
) {
  if (!Number.isFinite(value)) {
    return "-";
  }

  const digits =
    moneyDigits(currency);

  return new Intl.NumberFormat(
    "ko-KR",
    {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }
  ).format(value);
}

function formatPercent(
  value,
  digits = 2
) {
  if (!Number.isFinite(value)) {
    return "-";
  }

  return `${value.toFixed(digits)}%`;
}

/* =========================================================
   통계
========================================================= */

function median(values) {
  if (!values.length) {
    return NaN;
  }

  const sorted = [...values].sort(
    (a, b) => a - b
  );

  const middle = Math.floor(
    sorted.length / 2
  );

  if (sorted.length % 2 === 0) {
    return (
      sorted[middle - 1] +
      sorted[middle]
    ) / 2;
  }

  return sorted[middle];
}

function percentile(
  sortedValues,
  probability
) {
  if (!sortedValues.length) {
    return NaN;
  }

  if (sortedValues.length === 1) {
    return sortedValues[0];
  }

  const position =
    (sortedValues.length - 1) *
    probability;

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
    ) *
      fraction
  );
}

function percentileRank(
  values,
  currentValue
) {
  if (
    !values.length ||
    !Number.isFinite(currentValue)
  ) {
    return NaN;
  }

  const belowOrEqual =
    values.filter(
      (value) =>
        value <= currentValue
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
  const dividendEvents =
    result.events?.dividends || {};

  const splitEvents =
    result.events?.splits || {};

  const dividends =
    Object.values(dividendEvents)
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
      .sort(
        (a, b) =>
          a.date - b.date
      );

  const splits =
    Object.values(splitEvents)
      .map((item) => ({
        date: Number(item.date),
        numerator: Number(
          item.numerator
        ),
        denominator: Number(
          item.denominator
        ),
        splitRatio:
          item.splitRatio || "",
      }))
      .filter(
        (item) =>
          Number.isFinite(item.date)
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

function getSplitRatio(split) {
  const numerator =
    Number(split.numerator);

  const denominator =
    Number(split.denominator);

  if (
    Number.isFinite(numerator) &&
    Number.isFinite(denominator) &&
    denominator !== 0
  ) {
    return numerator / denominator;
  }

  const text = String(
    split.splitRatio || ""
  );

  const parts =
    text.split(":");

  if (parts.length === 2) {
    const left =
      Number(parts[0]);

    const right =
      Number(parts[1]);

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
  let adjustedAmount =
    Number(dividend.amount);

  if (
    !Number.isFinite(adjustedAmount)
  ) {
    return 0;
  }

  for (const split of splits) {
    if (
      split.date >
        dividend.date &&
      split.date <=
        targetTimestamp
    ) {
      const ratio =
        getSplitRatio(split);

      if (
        Number.isFinite(ratio) &&
        ratio > 0
      ) {
        adjustedAmount /= ratio;
      }
    }
  }

  return adjustedAmount;
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
      const dateKey =
        new Date(
          dividend.date * 1000
        )
          .toISOString()
          .slice(0, 10);

      const adjustedAmount =
        adjustDividendForSplits(
          dividend,
          targetTimestamp,
          splits
        );

      const existing =
        grouped.get(dateKey);

      if (existing) {
        existing.amount +=
          adjustedAmount;

        existing.date =
          Math.max(
            existing.date,
            dividend.date
          );
      } else {
        grouped.set(
          dateKey,
          {
            date: dividend.date,
            amount:
              adjustedAmount,
          }
        );
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

/* =========================================================
   배당 빈도 자동 판단
========================================================= */

function estimatePaymentsPerYear(
  timestamp,
  dividends
) {
  const recentStart =
    timestamp -
    Math.floor(3.2 * YEAR);

  const recent =
    dividends
      .filter(
        (dividend) =>
          dividend.date <=
            timestamp &&
          dividend.date >=
            recentStart
      )
      .sort(
        (a, b) =>
          a.date - b.date
      );

  if (recent.length < 2) {
    return 1;
  }

  const uniqueDates = [];

  for (const dividend of recent) {
    const previous =
      uniqueDates[
        uniqueDates.length - 1
      ];

    if (
      !previous ||
      Math.abs(
        dividend.date -
          previous
      ) > DAY
    ) {
      uniqueDates.push(
        dividend.date
      );
    }
  }

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
      intervals.push(
        intervalDays
      );
    }
  }

  const recentIntervals =
    intervals.slice(-12);

  const typicalInterval =
    median(recentIntervals);

  if (
    !Number.isFinite(
      typicalInterval
    )
  ) {
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

/*
 * 배당락일이 조금씩 이동하면 정확히 365일 기준에서
 * 분기배당 4회 중 한 번이 빠질 수 있습니다.
 *
 * 최대 400일 동안 배당 이벤트를 확인하고,
 * 추정 지급 빈도에 맞춰 최근 배당만 합산합니다.
 */
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
        dividend.date >
          searchStart &&
        dividend.date <=
          timestamp
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
   종목 분석
========================================================= */

function analyzeStock(result) {
  if (!result) {
    throw new Error(
      "종목 데이터가 없습니다."
    );
  }

  const timestamps =
    Array.isArray(
      result.timestamp
    )
      ? result.timestamp
      : [];

  const quote =
    result.indicators
      ?.quote?.[0] || {};

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
      timestamps[
        timestamps.length - 1
      ]
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
      Number(
        timestamps[index]
      );

    const close =
      Number(closes[index]);

    if (
      !Number.isFinite(
        timestamp
      ) ||
      !Number.isFinite(close) ||
      close <= 0 ||
      timestamp <
        tenYearCutoff
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
        ? (
            ttmDividend /
            close
          ) * 100
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

  if (validYields.length < 20) {
    throw new Error(
      "최근 10년 배당 데이터가 부족해 밴드를 계산할 수 없습니다."
    );
  }

  const levels = {
    p10: percentile(
      validYields,
      0.1
    ),
    p25: percentile(
      validYields,
      0.25
    ),
    p50: percentile(
      validYields,
      0.5
    ),
    p75: percentile(
      validYields,
      0.75
    ),
    p90: percentile(
      validYields,
      0.9
    ),
  };

  const latest =
    points[
      points.length - 1
    ];

  const currentRank =
    percentileRank(
      validYields,
      latest.dividendYield
    );

  const tenYearDividends =
    dividends.filter(
      (dividend) =>
        dividend.date >=
          tenYearCutoff &&
        dividend.date <=
          lastTimestamp
    );

  return {
    points,
    dividends:
      tenYearDividends,
    allDividends:
      dividends,
    splits,
    levels,
    latest,
    currentRank,
    tenYearCutoff,
  };
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
      label:
        "매우 고평가 가능",
      description:
        "현재 배당수익률이 10년 기준으로 매우 낮은 구간입니다.",
      className:
        "expensive",
    };
  }

  if (rank <= 25) {
    return {
      label: "고평가 가능",
      description:
        "현재 배당수익률이 10년 기준으로 낮은 구간입니다.",
      className:
        "expensive",
    };
  }

  if (rank < 75) {
    return {
      label: "중립 구간",
      description:
        "현재 배당수익률이 10년의 일반적인 범위에 있습니다.",
      className: "neutral",
    };
  }

  if (rank < 90) {
    return {
      label: "저평가 가능",
      description:
        "현재 배당수익률이 10년 기준으로 높은 구간입니다.",
      className: "cheap",
    };
  }

  return {
    label:
      "매우 저평가 가능",
    description:
      "현재 배당수익률이 10년 기준으로 매우 높은 구간입니다.",
    className: "cheap",
  };
}

/* =========================================================
   상단 요약
========================================================= */

function renderSummary(
  result,
  analysis
) {
  const meta =
    result.meta || {};

  const currency =
    meta.currency || "USD";

  const displayName =
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
    el.name.textContent =
      displayName;
  }

  if (el.symbol) {
    el.symbol.textContent =
      meta.symbol || "-";
  }

  if (el.updated) {
    el.updated.textContent =
      formatDate(
        analysis.latest
          .timestamp
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
      Number.isFinite(
        analysis.currentRank
      )
        ? `${analysis.currentRank.toFixed(
            1
          )}%`
        : "-";
  }

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
   차트 공통
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
   배당수익률 밴드 차트
========================================================= */

function renderBandChart(
  analysis,
  currency
) {
  const canvas =
    $("#band-chart");

  if (!canvas) {
    return;
  }

  const labels =
    analysis.points.map(
      (point) =>
        formatShortDate(
          point.timestamp
        )
    );

  const p10Prices =
    analysis.points.map(
      (point) =>
        priceAtYield(
          point.ttmDividend,
          analysis.levels.p10
        )
    );

  const p25Prices =
    analysis.points.map(
      (point) =>
        priceAtYield(
          point.ttmDividend,
          analysis.levels.p25
        )
    );

  const p50Prices =
    analysis.points.map(
      (point) =>
        priceAtYield(
          point.ttmDividend,
          analysis.levels.p50
        )
    );

  const p75Prices =
    analysis.points.map(
      (point) =>
        priceAtYield(
          point.ttmDividend,
          analysis.levels.p75
        )
    );

  const p90Prices =
    analysis.points.map(
      (point) =>
        priceAtYield(
          point.ttmDividend,
          analysis.levels.p90
        )
    );

  const actualPrices =
    analysis.points.map(
      (point) =>
        point.close
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
            p10Prices,
            "#d93f4f",
            "rgba(217, 63, 79, 0.08)",
            false
          ),

          createBandDataset(
            `P25 ${formatPercent(
              analysis.levels.p25
            )}`,
            p25Prices,
            "#ef872f",
            "rgba(239, 135, 47, 0.10)",
            "-1"
          ),

          createBandDataset(
            `중앙 ${formatPercent(
              analysis.levels.p50
            )}`,
            p50Prices,
            "#d2ad18",
            "rgba(210, 173, 24, 0.10)",
            "-1"
          ),

          createBandDataset(
            `P75 ${formatPercent(
              analysis.levels.p75
            )}`,
            p75Prices,
            "#55a873",
            "rgba(85, 168, 115, 0.10)",
            "-1"
          ),

          createBandDataset(
            `P90 ${formatPercent(
              analysis.levels.p90
            )}`,
            p90Prices,
            "#118c68",
            "rgba(17, 140, 104, 0.10)",
            "-1"
          ),

          {
            label: "실제 주가",
            data: actualPrices,
            borderColor:
              "#155eef",
            backgroundColor:
              "#155eef",
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
        maintainAspectRatio:
          false,
        normalized: true,

        interaction: {
          mode: "index",
          intersect: false,
        },

        plugins: {
          legend: {
            position: "bottom",

            labels: {
              usePointStyle:
                true,
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
                  Number(
                    context.raw
                  );

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
   현재 밴드 가격
========================================================= */

function renderBandPriceSummary(
  analysis,
  currency
) {
  if (!el.bandSummary) {
    return;
  }

  const latest =
    analysis.latest;

  const items = [
    {
      label:
        "고평가 P10 가격",
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
      label:
        "저평가 P90 가격",
      value: priceAtYield(
        latest.ttmDividend,
        analysis.levels.p90
      ),
    },
  ];

  el.bandSummary
    .replaceChildren();

  items.forEach((item) => {
    const wrapper =
      document.createElement(
        "div"
      );

    wrapper.className =
      "band-price-item";

    const label =
      document.createElement(
        "span"
      );

    const value =
      document.createElement(
        "strong"
      );

    label.textContent =
      item.label;

    value.textContent =
      `${formatMoney(
        item.value,
        currency
      )} ${currency}`;

    wrapper.append(
      label,
      value
    );

    el.bandSummary
      .appendChild(wrapper);
  });
}

/* =========================================================
   연도별 배당금 데이터
========================================================= */

function makeAnnualDividendData(
  analysis
) {
  const totals =
    new Map();

  const latestTimestamp =
    analysis.latest.timestamp;

  analysis.dividends.forEach(
    (dividend) => {
      const year =
        new Date(
          dividend.date *
            1000
        ).getUTCFullYear();

      const adjustedAmount =
        adjustDividendForSplits(
          dividend,
          latestTimestamp,
          analysis.splits
        );

      totals.set(
        year,
        (
          totals.get(year) ||
          0
        ) + adjustedAmount
      );
    }
  );

  const currentYear =
    new Date(
      latestTimestamp * 1000
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

    totals: years.map(
      (year) =>
        totals.get(year) || 0
    ),
  };
}

/* =========================================================
   연도별 배당 차트
========================================================= */

function renderDividendChart(
  analysis,
  currency
) {
  const canvas =
    $("#dividend-chart");

  if (!canvas) {
    return;
  }

  const annual =
    makeAnnualDividendData(
      analysis
    );

  if (dividendChart) {
    dividendChart.destroy();
  }

  dividendChart = new Chart(
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

            borderColor:
              "#2457d6",

            backgroundColor:
              "rgba(36, 87, 214, 0.68)",

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

          tooltip: {
            callbacks: {
              label(context) {
                return (
                  "배당금: " +
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
   배당수익률 위치
========================================================= */

function renderYieldPosition(
  analysis
) {
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
      `${rank.toFixed(
        0
      )}백분위`;
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

  el.dividendBody
    .replaceChildren();

  const descending =
    [...analysis.dividends]
      .sort(
        (a, b) =>
          b.date - a.date
      );

  el.dividendCount
    .textContent =
    `${descending.length}건`;

  if (!descending.length) {
    const row =
      document.createElement(
        "tr"
      );

    const cell =
      document.createElement(
        "td"
      );

    cell.colSpan = 4;
    cell.className =
      "empty-table";

    cell.textContent =
      "최근 10년 배당금 내역이 없습니다.";

    row.appendChild(cell);

    el.dividendBody
      .appendChild(row);

    return;
  }

  descending.forEach(
    (dividend) => {
      const adjustedAmount =
        adjustDividendForSplits(
          dividend,
          analysis.latest
            .timestamp,
          analysis.splits
        );

      const row =
        document.createElement(
          "tr"
        );

      const dateCell =
        document.createElement(
          "td"
        );

      const originalCell =
        document.createElement(
          "td"
        );

      const adjustedCell =
        document.createElement(
          "td"
        );

      const currencyCell =
        document.createElement(
          "td"
        );

      dateCell.textContent =
        formatDate(
          dividend.date
        );

      originalCell.textContent =
        formatMoney(
          dividend.amount,
          currency
        );

      adjustedCell.textContent =
        formatMoney(
          adjustedAmount,
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

      el.dividendBody
        .appendChild(row);
    }
  );
}

/* =========================================================
   검색 결과 필터
========================================================= */

/*
 * Cloudflare Worker가 반환하는 검색 결과 중
 * "Yahoo Finance 직접 조회" 가상 항목을 제거합니다.
 */
function isDirectLookupResult(
  quote
) {
  const source =
    String(
      quote.source || ""
    ).toUpperCase();

  const exchange =
    String(
      quote.exchange || ""
    );

  return (
    source ===
      "DIRECT_SYMBOL" ||
    exchange.includes(
      "Yahoo Finance 직접 조회"
    ) ||
    exchange.includes(
      "직접 조회"
    )
  );
}

/* =========================================================
   세로형 검색 결과 버튼
========================================================= */

function createSearchResultButton(
  quote
) {
  const symbol =
    String(
      quote.symbol || ""
    ).trim();

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
    document.createElement(
      "button"
    );

  button.type = "button";

  /*
   * style.css에 이미 정의되어 있는 원래 클래스입니다.
   * 이 클래스를 써야 검색 결과가 세로 목록으로 표시됩니다.
   */
  button.className =
    "search-result";

  button.dataset.symbol =
    symbol;

  button.dataset.name =
    name;

  const nameWrapper =
    document.createElement(
      "div"
    );

  nameWrapper.className =
    "search-result-name";

  const strong =
    document.createElement(
      "strong"
    );

  strong.textContent =
    name;

  const small =
    document.createElement(
      "small"
    );

  small.textContent =
    [symbol, exchange]
      .filter(Boolean)
      .join(" • ");

  const symbolBadge =
    document.createElement(
      "div"
    );

  symbolBadge.className =
    "search-result-symbol";

  symbolBadge.textContent =
    symbol;

  nameWrapper.append(
    strong,
    small
  );

  button.append(
    nameWrapper,
    symbolBadge
  );

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
   검색 결과 키보드 이동
========================================================= */

function getSearchResultButtons() {
  if (!el.results) {
    return [];
  }

  return [
    ...el.results
      .querySelectorAll(
        ".search-result"
      ),
  ];
}

function focusSearchResult(
  index
) {
  const buttons =
    getSearchResultButtons();

  if (!buttons.length) {
    activeSearchIndex = -1;
    return;
  }

  const normalizedIndex =
    (
      index +
      buttons.length
    ) % buttons.length;

  activeSearchIndex =
    normalizedIndex;

  buttons[
    normalizedIndex
  ].focus();
}

/* =========================================================
   종목 검색
========================================================= */

async function handleSearch(
  event
) {
  event.preventDefault();

  const query =
    el.input.value.trim();

  if (!query) {
    return;
  }

  showLoading(true);
  clearError();
  closeResults();

  try {
    const data =
      await requestJson(
        "/api/search",
        {
          q: query,
        }
      );

    const rawQuotes =
      Array.isArray(
        data.quotes
      )
        ? data.quotes
        : [];

    /*
     * 중요:
     * Worker 응답에 포함된 DIRECT_SYMBOL 항목을
     * 여기서 완전히 제외합니다.
     */
    const quotes =
      rawQuotes.filter(
        (quote) =>
          !isDirectLookupResult(
            quote
          )
      );

    if (!quotes.length) {
      const message =
        document.createElement(
          "div"
        );

      message.className =
        "search-message";

      message.textContent =
        "검색 결과가 없습니다. 정확한 종목명이나 티커를 입력해 주세요.";

      el.results.appendChild(
        message
      );

      return;
    }

    quotes.forEach(
      (quote) => {
        const button =
          createSearchResultButton(
            quote
          );

        if (button) {
          el.results
            .appendChild(
              button
            );
        }
      }
    );
  } catch (error) {
    showError(error);
  } finally {
    showLoading(false);
  }
}

/* =========================================================
   선택한 종목 조회
========================================================= */

async function selectSymbol(
  symbol,
  name
) {
  selectedName =
    name || symbol;

  closeResults();
  clearError();
  showLoading(true);

  try {
    const data =
      await requestJson(
        "/api/stock",
        {
          symbol,
        }
      );

    const result =
      data.result;

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

    renderYieldPosition(
      analysis
    );

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
      el.dashboard.classList
        .remove("hidden");
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

if (el.input) {
  el.input.addEventListener(
    "keydown",
    (event) => {
      const buttons =
        getSearchResultButtons();

      if (
        event.key ===
          "ArrowDown" &&
        buttons.length
      ) {
        event.preventDefault();
        focusSearchResult(0);
      }

      if (
        event.key ===
          "ArrowUp" &&
        buttons.length
      ) {
        event.preventDefault();

        focusSearchResult(
          buttons.length - 1
        );
      }

      if (
        event.key ===
        "Escape"
      ) {
        closeResults();
      }
    }
  );
}

if (el.results) {
  el.results.addEventListener(
    "keydown",
    (event) => {
      const buttons =
        getSearchResultButtons();

      if (!buttons.length) {
        return;
      }

      const currentIndex =
        buttons.indexOf(
          document.activeElement
        );

      if (
        event.key ===
        "ArrowDown"
      ) {
        event.preventDefault();

        focusSearchResult(
          currentIndex + 1
        );
      }

      if (
        event.key ===
        "ArrowUp"
      ) {
        event.preventDefault();

        if (
          currentIndex <= 0
        ) {
          activeSearchIndex =
            -1;

          el.input?.focus();
        } else {
          focusSearchResult(
            currentIndex - 1
          );
        }
      }

      if (
        event.key ===
        "Escape"
      ) {
        event.preventDefault();
        closeResults();
        el.input?.focus();
      }
    }
  );
}

document
  .querySelectorAll(
    ".example-button"
  )
  .forEach((button) => {
    button.addEventListener(
      "click",
      () => {
        const query =
          button.dataset.query ||
          button.textContent.trim();

        el.input.value =
          query;

        if (
          typeof el.form
            .requestSubmit ===
          "function"
        ) {
          el.form.requestSubmit();
        } else {
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
    const clickedInsideForm =
      el.form?.contains(
        event.target
      );

    const clickedInsideResults =
      el.results?.contains(
        event.target
      );

    if (
      !clickedInsideForm &&
      !clickedInsideResults
    ) {
      closeResults();
    }
  }
);

document.addEventListener(
  "keydown",
  (event) => {
    if (
      event.key ===
      "Escape"
    ) {
      closeResults();
    }
  }
);
