import { useEffect, useRef, useState } from 'react';
import { CandlestickSeries, ColorType, CrosshairMode, HistogramSeries, LineSeries, LineStyle,
  createChart, createSeriesMarkers, type UTCTimestamp } from 'lightweight-charts';
import { BREAKOUTS, PERIOD_MS, TAG_DETAILS, type Period } from '../../src/market.js';
import type { DetailResponse } from '../../src/web/contracts.js';
import { dateTime, number } from './api.js';
import { useCopy } from './i18n.js';

export function PriceChart({ data, period, theme }: { data: DetailResponse; period: Period; theme: string }) {
  const { t, lang } = useCopy();
  const container = useRef<HTMLDivElement>(null);
  const [tooltip, setTooltip] = useState(t.chartHint);
  const [marks, setMarks] = useState<{ x: number; label: string; height: number }[]>([]);
  useEffect(() => {
    if (!container.current || !data.candles.length) return;
    const host = container.current;
    const css = getComputedStyle(document.documentElement);
    const color = (name: string) => css.getPropertyValue(name).trim();
    const chart = createChart(host, {
      autoSize: true, layout: { background: { type: ColorType.Solid, color: color('--surface') }, textColor: color('--text'), fontSize: 11 },
      grid: { vertLines: { color: color('--border') + '55' }, horzLines: { color: color('--border') + '55' } },
      rightPriceScale: { borderColor: color('--border') }, leftPriceScale: { visible: false },
      timeScale: { timeVisible: true, secondsVisible: false, borderColor: color('--border') },
      crosshair: { mode: CrosshairMode.Normal },
      localization: { locale: 'zh-CN' },
    });
    const min = Math.min(...data.candles.map((bar) => bar.close).filter((price) => price > 0));
    const precision = Number.isFinite(min) ? Math.max(0, Math.min(12, 4 - Math.floor(Math.log10(min)))) : 6;
    const price = chart.addSeries(CandlestickSeries, { upColor: color('--surface'), downColor: color('--candle-down'),
      borderUpColor: color('--candle-up'), wickUpColor: color('--candle-up'),
      borderDownColor: color('--candle-down'), wickDownColor: color('--candle-down'),
      priceFormat: { type: 'price', precision, minMove: 10 ** -precision } }, 0);
    const volume = chart.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, priceLineVisible: false }, 1);
    const volumeMa = chart.addSeries(LineSeries, { color: color('--period-60m'), lineWidth: 2, priceLineVisible: false,
      priceFormat: { type: 'volume' } }, 1);
    const strength = chart.addSeries(LineSeries, { color: color('--period-30m'), lineWidth: 2,
      priceLineVisible: false, priceFormat: { type: 'price', precision: 1, minMove: 0.1 } }, 2);
    const time = (ms: number) => ms / 1000 as UTCTimestamp;
    price.setData(data.candles.map((bar) => ({ time: time(bar.openTime), open: bar.open, high: bar.high, low: bar.low, close: bar.close })));
    volume.setData(data.candles.map((bar) => ({ time: time(bar.openTime), value: bar.volume,
      color: color(bar.close >= bar.open ? '--candle-up' : '--candle-down') })));
    volumeMa.setData(data.indicators.volumeMa.map((point) => ({ time: time(point.openTime), value: point.value })));
    strength.setData(data.indicators.rsi.map((point) => ({ time: time(point.openTime), value: point.value })));
    for (const value of new Set([data.indicators.parameters.rsiBelow, data.indicators.parameters.maxRsi])) {
      strength.createPriceLine({ price: value, title: `RSI ${value}`, color: color('--text-muted'),
        lineStyle: LineStyle.Dashed, lineWidth: 1, axisLabelVisible: true, axisLabelColor: color('--surface-alt'), axisLabelTextColor: color('--text') });
    }
    chart.panes()[0]?.setStretchFactor(0.58);
    chart.panes()[1]?.setStretchFactor(0.2);
    chart.panes()[2]?.setStretchFactor(0.22);
    const times = new Set(data.candles.map((bar) => bar.openTime));
    const momentLabels = new Map<number, number[]>();
    for (const moment of data.moments) {
      if (BREAKOUTS.find((rule) => rule.moment === moment.moment)?.period !== period || !times.has(moment.barTime)) continue;
      momentLabels.set(moment.barTime, [...(momentLabels.get(moment.barTime) ?? []), moment.moment]);
    }
    createSeriesMarkers(price, [...momentLabels].sort((a, b) => a[0] - b[0]).map(([barTime, moments]) => ({
      time: time(barTime), position: 'aboveBar', shape: 'arrowDown', color: color('--text'), text: t.chartMoment(moments.join(' / ')),
    })));
    const updateMarks = () => setMarks(data.alerts.filter((alert) => alert.tags.some((tag) => TAG_DETAILS[tag].period === period))
      .map((alert) => {
        const barTime = Math.floor(alert.firedAt / PERIOD_MS[period]) * PERIOD_MS[period] - PERIOD_MS[period];
        const x = times.has(barTime) ? chart.timeScale().timeToCoordinate(time(barTime)) : null;
        return { x: x ?? -1, label: `${dateTime(alert.firedAt, t)} · ${alert.tags.map((tag) => lang === 'en' ? TAG_DETAILS[tag].labelEn : TAG_DETAILS[tag].label).join(lang === 'en' ? ', ' : '，')}`,
          height: chart.panes()[0]?.getHeight() ?? 320 };
      }).filter((mark) => mark.x >= 0 && mark.x < host.clientWidth - 60));
    chart.timeScale().subscribeVisibleLogicalRangeChange(updateMarks);
    const observer = new ResizeObserver(updateMarks); observer.observe(host);
    chart.subscribeCrosshairMove((event) => {
      const bar = event.seriesData.get(price);
      const vol = event.seriesData.get(volume);
      const ma = event.seriesData.get(volumeMa);
      const rs = event.seriesData.get(strength);
      if (bar && 'open' in bar) setTooltip(`${typeof event.time === 'number' ? dateTime(event.time * 1000, t) : ''}  `
        + t.chartOhlc(number(bar.open), number(bar.high), number(bar.low), number(bar.close))
        + t.chartVolMa(number(vol && 'value' in vol ? vol.value : null), number(ma && 'value' in ma ? ma.value : null))
        + `RSI ${number(rs && 'value' in rs ? rs.value : null)}`);
    });
    chart.timeScale().fitContent(); updateMarks();
    return () => { observer.disconnect(); chart.timeScale().unsubscribeVisibleLogicalRangeChange(updateMarks); chart.remove(); };
  }, [data, period, theme, t, lang]);

  return <div className="chart-section"><div className="chart-legend">
    <span><i className="legend-hollow" />{t.legendUp}</span><span><i className="legend-solid" />{t.legendDown}</span>
    <span><i className="legend-square" />{t.legendVolume}</span><span><i className="legend-line period-60m" />{t.legendVolMa(data.indicators.parameters.volMaPeriod)}</span>
    <span><i className="legend-line period-30m" />RSI{data.indicators.parameters.rsiPeriod}</span>
    <span>{t.legendMoment}</span><span>{t.legendAlert}</span>
  </div><div className="chart-tooltip" aria-label={t.chartTooltipLabel}>{tooltip}</div>
    <div className="chart-shell"><div ref={container} className="chart-canvas" role="img" aria-label={t.chartCanvasLabel(period)} />
      <div className="chart-alert-overlay" aria-hidden="true">{marks.map((mark, index) => <div className="chart-alert-line" key={index}
        title={mark.label} style={{ left: mark.x, height: mark.height }}><span>{t.chartAlertMark}</span></div>)}</div>
    </div><p className="chart-credit">{t.chartCredit}<a href="https://www.tradingview.com/lightweight-charts/" target="_blank" rel="noreferrer">TradingView Lightweight Charts</a></p>
  </div>;
}
