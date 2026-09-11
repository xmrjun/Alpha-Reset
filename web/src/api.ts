import { useEffect, useState } from 'react';

export function useApi<T>(url: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setData(null); setLoading(true); setError(null);
    let pending = false;
    async function load() {
      if (pending) return;
      pending = true;
      try {
        const response = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
        if (!response.ok) throw new Error(`数据加载失败（HTTP ${response.status}）`);
        const body: T = await response.json();
        if (!controller.signal.aborted) { setData(body); setError(null); }
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error && /^数据加载失败/.test(cause.message)
          ? cause.message : '无法连接本地数据服务');
      } finally { pending = false; if (!controller.signal.aborted) setLoading(false); }
    }
    void load();
    const timer = window.setInterval(() => { void load(); }, 60_000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [url, version]);
  return { data, error, loading, reload: () => setVersion((value) => value + 1) };
}

export const number = (value: number | null | undefined) => value == null ? '—'
  : new Intl.NumberFormat('en-US', { maximumSignificantDigits: 6 }).format(value);
export const money = (value: number | null | undefined) => value == null ? '—'
  : '$' + new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(value);
export const dateTime = (value: number | null | undefined) => value == null ? '未知'
  : new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short', hour12: false }).format(value);
export function relativeTime(value: number | null) {
  if (value === null) return '尚未运行';
  const minutes = Math.max(0, Math.floor((Date.now() - value) / 60_000));
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  return minutes < 1440 ? `${Math.floor(minutes / 60)} 小时前` : `${Math.floor(minutes / 1440)} 天前`;
}
