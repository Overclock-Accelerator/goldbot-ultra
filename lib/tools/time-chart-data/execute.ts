// Time Chart Data Tool Execution
// Fetches and formats historical price data optimized for charting

import fs from 'fs';
import path from 'path';
import { fetchMonthlyPrices, currentMonth } from '../shared/goldapi-history';

// Metal name mapping (API symbols to JSON keys)
const METAL_NAMES = {
  'XAU': 'Gold',
  'XAG': 'Silver',
  'XPT': 'Platinum',
  'XPD': 'Palladium'
} as const;

interface PreciousMetalsData {
  [metalName: string]: Array<{
    date: string;  // MM/YYYY format in JSON
    price: number;
  }>;
}

export interface ChartDataPoint {
  date: string;        // YYYY-MM format
  timestamp: number;   // Unix timestamp for sorting
  prices: {
    [metal: string]: number;  // Metal symbol -> price
  };
}

export interface TimeChartDataResult {
  success: boolean;
  data?: {
    metals: string[];
    currency: string;
    startDate: string;
    endDate: string;
    dataPoints: ChartDataPoint[];
    summary: {
      [metal: string]: {
        min: number;
        max: number;
        avg: number;
        change: number;
        changePercent: number;
      };
    };
    // How each plotted price was resolved. A non-zero `dataset` count means the
    // API couldn't serve those months and the checked-in file filled the gap.
    sources?: { api: number; dataset: number };
  };
  error?: string;
}

// Helper to parse relative periods
function parseRelativePeriod(relativePeriod: string): { startDate: string; endDate: string } {
  const now = new Date();
  const endDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  const lowerPeriod = relativePeriod.toLowerCase();
  let monthsBack = 12; // default to 1 year

  if (lowerPeriod.includes('month')) {
    const match = lowerPeriod.match(/(\d+)\s*month/);
    monthsBack = match ? parseInt(match[1]) : 12;
  } else if (lowerPeriod.includes('year')) {
    const match = lowerPeriod.match(/(\d+)\s*year/);
    const years = match ? parseInt(match[1]) : 1;
    monthsBack = years * 12;
  } else if (lowerPeriod.includes('quarter')) {
    const match = lowerPeriod.match(/(\d+)\s*quarter/);
    const quarters = match ? parseInt(match[1]) : 1;
    monthsBack = quarters * 3;
  } else if (lowerPeriod.includes('week')) {
    const match = lowerPeriod.match(/(\d+)\s*week/);
    monthsBack = match ? Math.ceil(parseInt(match[1]) / 4) : 3;
  }

  const startDateObj = new Date(now);
  startDateObj.setMonth(startDateObj.getMonth() - monthsBack);
  const startDate = `${startDateObj.getFullYear()}-${String(startDateObj.getMonth() + 1).padStart(2, '0')}`;

  return { startDate, endDate };
}

// Helper to generate date range
function generateDateRange(startDate: string, endDate: string, maxPoints: number = 12): string[] {
  const start = new Date(startDate + '-01');
  const end = new Date(endDate + '-01');

  const months: string[] = [];
  const current = new Date(start);

  while (current <= end) {
    const yearMonth = `${current.getFullYear()}-${String(current.getMonth() + 1).padStart(2, '0')}`;
    months.push(yearMonth);
    current.setMonth(current.getMonth() + 1);
  }

  // If we have too many data points, sample them
  if (months.length > maxPoints) {
    const step = Math.ceil(months.length / maxPoints);
    const sampled = months.filter((_, index) => index % step === 0);

    // Sampling steps from the start, so the final month lands in the result
    // only by coincidence. Without this a "since 2000" chart stops short of
    // the present, which reads as missing recent data.
    const lastMonth = months[months.length - 1];
    if (sampled[sampled.length - 1] !== lastMonth) {
      sampled.push(lastMonth);
    }

    return sampled;
  }

  return months;
}

export async function executeTimeChartDataTool(
  metals: string[],
  startDate?: string,
  endDate?: string,
  relativePeriod?: string,
  currency: string = 'USD',
  dataPoints: number = 12
): Promise<TimeChartDataResult> {
  try {
    console.log('🎨 Time Chart Data Tool - Input:', { metals, startDate, endDate, relativePeriod, currency, dataPoints });

    // The checked-in dataset is only a fallback for months the API can't serve;
    // prices come from goldapi below. Missing file is not fatal.
    let jsonData: PreciousMetalsData = {};
    const filePath = path.join(process.cwd(), 'data', 'precious_metals.json');
    if (fs.existsSync(filePath)) {
      jsonData = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    }

    // Determine date range
    let finalStartDate: string;
    let finalEndDate: string;

    if (relativePeriod) {
      const parsed = parseRelativePeriod(relativePeriod);
      finalStartDate = parsed.startDate;
      finalEndDate = parsed.endDate;
    } else if (startDate && endDate) {
      finalStartDate = startDate;
      finalEndDate = endDate;
    } else if (startDate) {
      // Open-ended range runs through the present, not a pinned dataset edge.
      finalStartDate = startDate;
      finalEndDate = currentMonth();
    } else {
      // Default to last 12 months
      const parsed = parseRelativePeriod('last 12 months');
      finalStartDate = parsed.startDate;
      finalEndDate = parsed.endDate;
    }

    console.log('📅 Date range:', { finalStartDate, finalEndDate });

    // Generate date range
    const dateRange = generateDateRange(finalStartDate, finalEndDate, dataPoints);
    console.log('📊 Data points:', dateRange.length);

    // Fetch only the months actually plotted, so a 30-year range costs the same
    // number of requests as a 1-year one.
    const apiPrices = await fetchMonthlyPrices(metals, dateRange, currency);
    const sources = { api: 0, dataset: 0 };

    // Build chart data
    const chartData: ChartDataPoint[] = [];
    const metalStats: { [metal: string]: number[] } = {};

    for (const metal of metals) {
      metalStats[metal] = [];
    }

    for (const yearMonth of dateRange) {
      const dataPoint: ChartDataPoint = {
        date: yearMonth,
        timestamp: new Date(yearMonth + '-01').getTime(),
        prices: {}
      };

      // Prefer the live API; fall back to the checked-in dataset per point.
      for (const metal of metals) {
        try {
          const apiPrice = apiPrices.get(`${metal}:${yearMonth}`);

          if (apiPrice !== undefined) {
            dataPoint.prices[metal] = apiPrice;
            metalStats[metal].push(apiPrice);
            sources.api++;
            continue;
          }

          const metalName = METAL_NAMES[metal as keyof typeof METAL_NAMES];
          if (!metalName || !jsonData[metalName]) {
            console.warn(`No data available for ${metal} on ${yearMonth}`);
            continue;
          }

          // Convert YYYY-MM to MM/YYYY for dataset lookup
          const [year, month] = yearMonth.split('-');
          const jsonDateFormat = `${month}/${year}`;

          // Find matching data point
          const dataEntry = jsonData[metalName].find(entry => entry.date === jsonDateFormat);

          if (dataEntry) {
            dataPoint.prices[metal] = dataEntry.price;
            metalStats[metal].push(dataEntry.price);
            sources.dataset++;
          } else {
            console.warn(`No data found for ${metal} on ${yearMonth}`);
          }
        } catch (error) {
          console.error(`Error processing ${metal} for ${yearMonth}:`, error);
        }
      }

      // Only add data point if it has at least one price
      if (Object.keys(dataPoint.prices).length > 0) {
        chartData.push(dataPoint);
      }
    }

    // Calculate summary statistics
    const summary: { [metal: string]: any } = {};

    for (const metal of metals) {
      const prices = metalStats[metal].filter(p => p !== undefined);

      if (prices.length > 0) {
        const min = Math.min(...prices);
        const max = Math.max(...prices);
        const avg = prices.reduce((sum, p) => sum + p, 0) / prices.length;
        const firstPrice = prices[0];
        const lastPrice = prices[prices.length - 1];
        const change = lastPrice - firstPrice;
        const changePercent = (change / firstPrice) * 100;

        summary[metal] = {
          min: parseFloat(min.toFixed(2)),
          max: parseFloat(max.toFixed(2)),
          avg: parseFloat(avg.toFixed(2)),
          change: parseFloat(change.toFixed(2)),
          changePercent: parseFloat(changePercent.toFixed(2))
        };
      }
    }

    console.log('✅ Chart data ready:', { dataPointsCount: chartData.length, metals, sources });

    return {
      success: true,
      data: {
        metals,
        currency,
        startDate: finalStartDate,
        endDate: finalEndDate,
        dataPoints: chartData,
        summary,
        sources
      }
    };

  } catch (error) {
    console.error('❌ Time chart data tool error:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred'
    };
  }
}
