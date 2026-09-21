import { useEffect, useRef, useState } from 'react';
import {
  AGENT_MODELS, AgentError, DEFAULT_MODEL, MAX_ROUNDS, MODEL_CONTEXT, loadAgentTools, runAgent,
  type AgentStatus, type AgentTool, type ChatMessage,
} from './agent.js';
import { CHAT_STORAGE, decodeHistory, encodeHistory } from './chat-storage.js';
import { useCopy } from './i18n.js';

const KEY_STORAGE = 'alpha-orbio-key';
const MODEL_STORAGE = 'alpha-agent-model';
const OPEN_STORAGE = 'alpha-agent-open';

/** key 只落在浏览器里：这几个读写全部包 try，隐私模式下存储不可用也不能拖垮面板。 */
function readStored(name: string): string {
  try { return localStorage.getItem(name) ?? ''; } catch { return ''; }
}
function writeStored(name: string, value: string): void {
  try { if (value) localStorage.setItem(name, value); else localStorage.removeItem(name); } catch { /* 不依赖持久化 */ }
}

/** 没存过 key 的人展开也只能看到一个输入框，所以默认收起；存过就默认展开。 */
function initialOpen(): boolean {
  const saved = readStored(OPEN_STORAGE);
  return saved === '1' ? true : saved === '0' ? false : readStored(KEY_STORAGE) !== '';
}

/** 界面上永远只显示掩码，避免用户截图分享页面时把 key 一起带出去。 */
function maskKey(key: string): string {
  return key.length <= 12 ? '•'.repeat(Math.max(key.length, 4)) : `${key.slice(0, 6)}…${key.slice(-4)}`;
}

function prettyJson(text: string): string {
  try { return JSON.stringify(JSON.parse(text) as unknown, null, 2); } catch { return text; }
}

/**
 * 模型经常拿 markdown 表格作答（nemotron 实测就会），但这里不能为此引入 markdown 依赖。
 *
 * 折中：整个气泡用等宽字体加 pre-wrap，再把连续的 `|` 开头行单独拎成一块用 white-space:pre
 * 渲染并允许横向滚动 —— 表格一旦被折行就彻底看不出列，而正文若也用 pre 又会撑破窄屏面板。
 */
function renderContent(text: string) {
  const blocks: { table: boolean; lines: string[] }[] = [];
  for (const line of text.split('\n')) {
    const table = /^\s*\|/.test(line);
    const last = blocks[blocks.length - 1];
    if (last && last.table === table) last.lines.push(line);
    else blocks.push({ table, lines: [line] });
  }
  return blocks.map((block, index) => {
    const body = block.lines.join('\n');
    if (block.table) return <div className="agent-table" key={index}>{body}</div>;
    // 表格前后常有空行，原样渲染会多出两个空段落。
    return body.trim() ? <p className="agent-text" key={index}>{body.trim()}</p> : null;
  });
}

/** standalone：作为独立页面渲染时强制展开——用户是专门点进来的，没有再折叠一次的道理。 */
export function AgentPanel({ standalone = false }: { standalone?: boolean } = {}) {
  const { t, lang } = useCopy();
  const [open, setOpen] = useState(initialOpen);
  const [savedKey, setSavedKey] = useState(() => readStored(KEY_STORAGE));
  const [keyDraft, setKeyDraft] = useState('');
  const [model, setModel] = useState(() => readStored(MODEL_STORAGE) || DEFAULT_MODEL);
  const [tools, setTools] = useState<AgentTool[] | null>(null);
  const [toolsError, setToolsError] = useState<AgentError | null>(null);
  const [toolsVersion, setToolsVersion] = useState(0);
  const [messages, setMessages] = useState<ChatMessage[]>(() => decodeHistory(readStored(CHAT_STORAGE)));
  const [input, setInput] = useState('');
  const [status, setStatus] = useState<AgentStatus>({ kind: 'idle' });
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fallbackModel, setFallbackModel] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const abort = useRef<AbortController | null>(null);
  const logEnd = useRef<HTMLDivElement>(null);

  // 展开时才拉工具清单：后端这组接口可能尚未上线，不该让每个只看行情的人都吃一次 404。
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setToolsError(null);
    loadAgentTools(controller.signal)
      .then((list) => { if (!controller.signal.aborted) setTools(list); })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setTools(null);
        setToolsError(cause instanceof AgentError ? cause : new AgentError('network'));
      });
    return () => controller.abort();
  }, [open, toolsVersion]);

  // 新消息或状态变化后滚到底，否则工具调用过程会在可视区外面悄悄跑完。
  useEffect(() => { logEnd.current?.scrollIntoView({ block: 'nearest' }); }, [messages, status]);

  // 导航栏是普通 <a>，切一次页面就是整页重载，对话不落盘会在切走的瞬间丢光。
  useEffect(() => { writeStored(CHAT_STORAGE, encodeHistory(messages)); }, [messages]);

  // 实测一轮「工具调用 + 最终回答」要 30~60 秒，没有走秒的等待态用户会以为页面卡死。
  useEffect(() => {
    if (!running) { setElapsed(0); return; }
    const startedAt = Date.now();
    const timer = window.setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [running]);

  const describe = (cause: unknown): string => {
    if (!(cause instanceof AgentError)) return t.agentErrNetwork;
    switch (cause.kind) {
      case 'missingKey': return t.agentErrMissingKey;
      case 'key': return t.agentErrKey;
      case 'payment': return t.agentErrPayment;
      case 'rate': return t.agentErrRate;
      case 'unavailable': return t.agentErrUnavailable;
      case 'gateway': return t.agentErrGateway;
      case 'empty': return t.agentErrEmpty;
      case 'rounds': return t.agentErrRounds(MAX_ROUNDS);
      case 'network': return t.agentErrNetwork;
      // upstream 的 detail 来自 Orbio 的原话，空的时候退回「没有内容」而不是拼出半句提示。
      default: return cause.detail ? t.agentErrUpstream(cause.detail) : t.agentErrEmpty;
    }
  };

  const toolLabel = (name: string): string => t.agentTools[name] ?? name;

  async function send(override?: string): Promise<void> {
    const text = (override ?? input).trim();
    if (!text || running) return;
    if (!savedKey) { setError(t.agentErrMissingKey); return; }
    const next: ChatMessage[] = [...messages, { role: 'user', content: text }];
    setMessages(next);
    setInput('');
    setError(null);
    setFallbackModel(null);
    setRunning(true);
    const controller = new AbortController();
    abort.current = controller;
    try {
      await runAgent({
        key: savedKey, model, tools: tools ?? [],
        // system 每次现拼：用户中途切语言后，下一句就该用新语言回答。
        // 带上当前时间：不给的话模型不知道「今天」是哪天，
        // 问「9 月 20 号告警的币」时算不出时间戳，只能瞎猜或者放弃。
        messages: [{ role: 'system', content: `${t.agentSystemPrompt}\n当前时间 / Current time: ${new Date().toISOString()}` }, ...next],
        signal: controller.signal,
        onMessages: (all) => setMessages(all.filter((message) => message.role !== 'system')),
        onStatus: setStatus,
        onFallback: setFallbackModel,
      });
    } catch (cause) {
      setError(controller.signal.aborted ? t.agentStopped : describe(cause));
    } finally {
      abort.current = null;
      setRunning(false);
      setStatus({ kind: 'idle' });
    }
  }

  // 工具名挂在 assistant 的 tool_call 上，结果挂在 tool 消息上，渲染时要把两边接回来。
  const callNames = new Map<string, string>();
  const callArgs = new Map<string, string>();
  const callResults = new Map<string, string>();
  for (const message of messages) {
    if (message.role === 'assistant') {
      for (const call of message.tool_calls ?? []) {
        callNames.set(call.id, call.function.name);
        callArgs.set(call.id, call.function.arguments);
      }
    } else if (message.role === 'tool') {
      callResults.set(message.tool_call_id, message.content);
    }
  }

  const statusText = status.kind === 'thinking' ? t.agentThinking
    : status.kind === 'tool' ? t.agentToolRunning(toolLabel(status.name)) : '';
  const unavailable = toolsError?.kind === 'unavailable';

  return <section className="panel agent-panel" aria-label={t.agentTitle}>
    <details open={standalone || open} onToggle={(event) => {
      const next = event.currentTarget.open;
      setOpen(next);
      writeStored(OPEN_STORAGE, next ? '1' : '0');
    }}>
      <summary className="agent-summary" aria-label={t.agentToggle}>
        <span className="agent-caret" aria-hidden="true">▸</span>
        <span className="agent-summary-title">{t.agentTitle}</span>
        <span className="agent-summary-hint">{t.agentHint}</span>
      </summary>

      <div className="agent-settings">
        <label className="agent-key-field">
          <span>{t.agentKeyLabel}</span>
          <input type="password" autoComplete="off" spellCheck={false} value={keyDraft} maxLength={200}
            placeholder={savedKey ? maskKey(savedKey) : t.agentKeyPlaceholder}
            onChange={(event) => setKeyDraft(event.target.value)} />
        </label>
        <button type="button" className="primary" disabled={!keyDraft.trim()} onClick={() => {
          const value = keyDraft.trim();
          writeStored(KEY_STORAGE, value);
          setSavedKey(value);
          // 存完就清空输入框：屏幕上留一串明文 key 没有任何好处。
          setKeyDraft('');
          setError(null);
        }}>{t.agentKeySave}</button>
        <button type="button" disabled={!savedKey && !keyDraft} onClick={() => {
          writeStored(KEY_STORAGE, '');
          setSavedKey('');
          setKeyDraft('');
        }}>{t.agentKeyClear}</button>
        <label className="agent-model-field">
          <span>{t.agentModelLabel}</span>
          <select value={model} onChange={(event) => { setModel(event.target.value); writeStored(MODEL_STORAGE, event.target.value); }}>
            {/* 分组而不是平铺：清单变长后，用户需要一眼看出哪些不花钱。 */}
            <optgroup label={t.agentModelFree}>
              {AGENT_MODELS.filter((name) => name.endsWith(':free')).map((name) => <option key={name} value={name}>
                {name}{MODEL_CONTEXT[name] ? ` · ${MODEL_CONTEXT[name]}` : ''}
              </option>)}
            </optgroup>
            <optgroup label={t.agentModelPaid}>
              {AGENT_MODELS.filter((name) => !name.endsWith(':free')).map((name) => <option key={name} value={name}>
                {name}{MODEL_CONTEXT[name] ? ` · ${MODEL_CONTEXT[name]}` : ''}
              </option>)}
            </optgroup>
          </select>
        </label>
      </div>

      <p className="agent-privacy">
        {savedKey ? <strong className="agent-key-state">{t.agentKeySaved(maskKey(savedKey))} · </strong> : null}
        {t.agentKeyNotice}{' '}
        <a href="https://orbio.so" target="_blank" rel="noreferrer">{t.agentKeyLink}</a>
      </p>

      {unavailable && <div className="notice" role="status"><span className="notice-symbol">!</span>
        <div><strong>{t.agentUnavailableTitle}</strong><p>{t.agentUnavailableDesc}</p></div>
        <button type="button" onClick={() => setToolsVersion((value) => value + 1)}>{t.agentRetryTools}</button></div>}
      {toolsError && !unavailable && <div className="notice" role="status"><span className="notice-symbol">!</span>
        <div><p>{describe(toolsError)}</p></div>
        <button type="button" onClick={() => setToolsVersion((value) => value + 1)}>{t.agentRetryTools}</button></div>}
      {tools !== null && <p className="agent-tools-line">{t.agentToolsReady(tools.length)}
        {tools.length > 0 && ` · ${tools.map((tool) => toolLabel(tool.name)).join(lang === 'en' ? ', ' : '、')}`}</p>}
      {fallbackModel && <div className="notice agent-fallback" role="status"><span className="notice-symbol">i</span>
        <div><p>{t.agentFallback(fallbackModel)}</p></div></div>}

      <div className="agent-log" role="log" aria-live="polite" aria-label={t.agentTitle}>
        {!messages.length && <div className="agent-empty">
          <p>{t.agentEmpty}</p>
          <p className="agent-empty-title">{t.agentEmptyTitle}</p>
          <ul className="agent-examples">
            {t.agentExamples.map((example) => <li key={example}>
              <button type="button" disabled={running || unavailable} onClick={() => {
                // 有 key 就直接问；没有的话 send 会提示先填 key，同时把问题留在输入框里。
                if (savedKey) void send(example); else { setInput(example); setError(t.agentErrMissingKey); }
              }}>{example}</button>
            </li>)}
          </ul>
        </div>}
        {messages.map((message, index) => {
          if (message.role === 'tool') return null;
          if (message.role === 'user') {
            return <div className="agent-turn agent-user" key={index}>
              <span className="agent-role">{t.agentYou}</span>
              <div className="agent-bubble"><p className="agent-text">{message.content}</p></div></div>;
          }
          if (message.role !== 'assistant') return null;
          const calls = message.tool_calls ?? [];
          const text = message.content.trim();
          return <div className="agent-turn agent-assistant" key={index}>
            {/* 只有 tool_calls 没有正文的那一轮不重复打「Agent」标签：
                它在界面上是一条执行状态，不是 agent 的又一次发言。 */}
            {text !== '' && <span className="agent-role">{t.agentAssistant}</span>}
            {text !== '' && <div className="agent-bubble">{renderContent(message.content)}</div>}
            {calls.map((call) => {
              const label = toolLabel(callNames.get(call.id) ?? call.function.name);
              const result = callResults.get(call.id);
              return <details className="agent-tool" key={call.id}>
                <summary>
                  <span className="agent-tool-dot" aria-hidden="true">{result === undefined ? '◌' : '●'}</span>
                  {result === undefined ? t.agentToolRunning(label) : t.agentToolDone(label)}
                </summary>
                <pre>{`${t.agentToolArgs}\n${prettyJson(callArgs.get(call.id) ?? '{}')}\n\n${t.agentToolResult}\n${result === undefined ? '…' : prettyJson(result)}`}</pre>
              </details>;
            })}
          </div>;
        })}
        {running && <p className="agent-status" role="status">
          {statusText || t.agentThinking} · {t.agentElapsed(elapsed)}</p>}
        <div ref={logEnd} />
      </div>

      {error && <div className="notice agent-error" role="alert"><span className="notice-symbol">!</span>
        <div><p>{error}</p></div></div>}

      <form className="agent-composer" onSubmit={(event) => { event.preventDefault(); void send(); }}>
        <label className="sr-only" htmlFor="agent-input">{t.agentTitle}</label>
        <textarea id="agent-input" rows={2} value={input} maxLength={2000} placeholder={t.agentPlaceholder}
          disabled={unavailable}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            // Enter 直接发送、Shift+Enter 换行；输入法组字期间的 Enter 不能当发送。
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void send();
            }
          }} />
        <div className="agent-actions">
          {running
            ? <button type="button" onClick={() => abort.current?.abort()}>{t.agentStop}</button>
            : <button type="submit" className="primary" disabled={!input.trim() || unavailable}>{t.agentSend}</button>}
          <button type="button" disabled={!messages.length || running} onClick={() => {
            setMessages([]); setError(null); setFallbackModel(null);
          }}>{t.agentClearChat}</button>
          <span className="agent-hint-inline">{t.agentSendHint(MAX_ROUNDS)}</span>
        </div>
      </form>
    </details>
  </section>;
}
