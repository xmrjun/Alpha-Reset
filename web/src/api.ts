import { useEffect, useRef, useState } from 'react';
import { hasLiveSnapshot, subscribeLive } from './live.js';
import { COPY, detectLang, type Copy } from './i18n.js';

// 加载错误在 Hook 内部产生，拿不到 React 上下文，这里按当前语言取一份文案。
const fallbackCopy = (): Copy => COPY[detectLang()];

export function useApi<T>(url: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [version, setVersion] = useState(0);
  const currentData = useRef<T | null>(null);
  const currentUrl = useRef(url);
  useEffect(() => {
    const controller = new AbortController();
    // 同一资源手动刷新、HTTP 兜底与实时推送均保留现有内容。
    // 切换详情资产/周期等 URL 时才清空，避免显示上一个资源的行情。
    if (currentUrl.current !== url) {
      currentUrl.current = url;
      currentData.current = null;
      setData(null);
    }
    if (currentData.current === null) setLoading(true);
    setError(null);
    const resource = url === '/api/stats' ? 'stats' : url === '/api/pool?limit=1000' ? 'pool' : null;
    let pending = false;
    let pushVersion = 0;
    const publish = (body: T) => {
      if (controller.signal.aborted) return;
      currentData.current = body;
      setData(body);
      setError(null);
      setLoading(false);
    };
    const unsubscribe = resource ? subscribeLive((snapshot) => {
      pushVersion++;
      publish(snapshot[resource] as T);
    }, currentData.current === null) : undefined;
    async function load(force = false) {
      if (pending || (!force && resource && hasLiveSnapshot())) return;
      pending = true;
      const startedWithPush = pushVersion;
      try {
        const response = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
        if (!response.ok) throw new Error(fallbackCopy().loadFailed(response.status));
        const body: T = await response.json();
        // 在途 HTTP 可能早于刚到的 WS 快照，不能让它把评分、进度或标签倒退。
        if (startedWithPush === pushVersion) publish(body);
      } catch (cause) {
        if (!controller.signal.aborted && startedWithPush === pushVersion) {
          const copy = fallbackCopy();
          setError(cause instanceof Error && cause.message.startsWith(copy.loadFailedPrefix)
            ? cause.message : copy.connectFailed);
        }
      } finally {
        pending = false;
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void load(version > 0);
    // 实时连接正常时直接消费消息；不可用时每分钟 HTTP 兜底，详情/告警仍沿用 HTTP。
    const timer = window.setInterval(() => { void load(); }, 60_000);
    return () => { controller.abort(); unsubscribe?.(); window.clearInterval(timer); };
  }, [url, version]);
  return { data, error, loading, reload: () => setVersion((value) => value + 1) };
}

export const number = (value: number | null | undefined) => value == null ? '—'
  : new Intl.NumberFormat('en-US', { maximumSignificantDigits: 6 }).format(value);
export const money = (value: number | null | undefined) => value == null ? '—'
  : '$' + new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(value);
/** 数字与金额两种语言同形（en-US 分组），只有日期与相对时间随语言变化。 */
export const dateTime = (value: number | null | undefined, t: Copy) => value == null ? t.unknownTime
  : new Intl.DateTimeFormat(t.dateLocale, { dateStyle: 'medium', timeStyle: 'short', hour12: false }).format(value);
export function relativeTime(value: number | null, t: Copy) {
  if (value === null) return t.notRunYet;
  const minutes = Math.max(0, Math.floor((Date.now() - value) / 60_000));
  if (minutes < 1) return t.justNow;
  if (minutes < 60) return t.minutesAgo(minutes);
  return minutes < 1440 ? t.hoursAgo(Math.floor(minutes / 60)) : t.daysAgo(Math.floor(minutes / 1440));
}
