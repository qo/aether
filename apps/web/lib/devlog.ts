"use client";

/*
 * Aether frontend dev logger.
 *
 * One module, one job: make every interesting client-side event visible in the
 * browser console with a consistent tag so you can filter by category in the
 * devtools. Categories used today:
 *
 *   [rv:boot]   - one-shot startup line and global handler installation
 *   [rv:api]    - HTTP requests issued by lib/api.ts (method, url, ms, status)
 *   [rv:ws]     - WebSocket lifecycle + message-rate counters
 *   [rv:state]  - React component state transitions worth recording
 *   [rv:error]  - thrown errors caught by global handlers or boundaries
 *
 * What each level means:
 *   debug -> noisy per-frame stuff, hidden unless you switch the level filter
 *   info  -> one-shot lifecycle events (request started, ws connected)
 *   warn  -> recoverable problem (request retried, ws closed, will reconnect)
 *   error -> something we couldn't recover from (request failed, parse error)
 *
 * Filter recipes for Chrome devtools:
 *   /rv:api/        -> show only HTTP traffic
 *   /rv:ws/         -> show only WebSocket traffic
 *   /rv:(api|ws)/   -> show network-y stuff only
 *   -/rv:ws debug/  -> hide noisy per-frame ws debug lines
 *
 * The logger is safe to import in server components: it no-ops on the server
 * because window/console behave differently there. The actual subscription of
 * window.error / unhandledrejection happens inside <DevBootstrap/>, which is
 * a client component mounted from app/layout.tsx.
 */

type Level = "debug" | "info" | "warn" | "error";
type Category = "boot" | "api" | "ws" | "state" | "error";

const STYLE: Record<Category, string> = {
  boot: "color:#A78BFA;font-weight:600",
  api: "color:#3B82F6;font-weight:600",
  ws: "color:#14B8A6;font-weight:600",
  state: "color:#F59E0B;font-weight:600",
  error: "color:#EF4444;font-weight:600"
};

const isBrowser = typeof window !== "undefined";

function emit(level: Level, category: Category, message: string, data?: unknown) {
  if (!isBrowser) return;
  const tag = `%c[rv:${category}]`;
  const fn = level === "debug" ? console.debug
    : level === "info" ? console.info
    : level === "warn" ? console.warn
    : console.error;
  if (data === undefined) {
    fn(tag, STYLE[category], message);
  } else {
    fn(tag, STYLE[category], message, data);
  }
}

export const devlog = {
  debug: (cat: Category, msg: string, data?: unknown) => emit("debug", cat, msg, data),
  info: (cat: Category, msg: string, data?: unknown) => emit("info", cat, msg, data),
  warn: (cat: Category, msg: string, data?: unknown) => emit("warn", cat, msg, data),
  error: (cat: Category, msg: string, data?: unknown) => emit("error", cat, msg, data)
};

/*
 * Mark a span of work and return a stop() that prints how long it took.
 * Used by the api/ws helpers so every request has a duration in the console.
 */
export function startTimer(category: Category, label: string, data?: unknown) {
  const t0 = isBrowser && typeof performance !== "undefined" ? performance.now() : 0;
  devlog.debug(category, `> ${label}`, data);
  return (resultLevel: Level = "info", extra?: Record<string, unknown>) => {
    const ms = isBrowser && typeof performance !== "undefined" ? performance.now() - t0 : 0;
    emit(resultLevel, category, `< ${label} (${ms.toFixed(1)} ms)`, extra);
    return ms;
  };
}

/*
 * Counter that prints an aggregate every `windowMs` rather than every event.
 * The WebSocket helper uses this to log a "ws received N msgs in 5s, X msg/s"
 * summary rather than spamming a line per frame.
 */
export function makeRateCounter(category: Category, label: string, windowMs = 5000) {
  let count = 0;
  let firstAt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    if (count === 0) {
      timer = null;
      return;
    }
    const elapsed = isBrowser && typeof performance !== "undefined" ? performance.now() - firstAt : windowMs;
    const rate = count / (elapsed / 1000);
    emit("debug", category, `${label}: ${count} in ${elapsed.toFixed(0)} ms (${rate.toFixed(1)}/s)`);
    count = 0;
    firstAt = 0;
    timer = null;
  };
  return () => {
    if (count === 0) {
      firstAt = isBrowser && typeof performance !== "undefined" ? performance.now() : 0;
    }
    count += 1;
    if (timer === null && isBrowser) {
      timer = setTimeout(flush, windowMs);
    }
  };
}

/*
 * <DevBootstrap/> is mounted once from RootLayout. It:
 *   - prints a boot banner with the resolved API + WS URLs
 *   - hooks window.onerror and window.onunhandledrejection so any thrown error
 *     anywhere in the app surfaces in the console with the [rv:error] tag
 *   - is a no-op on the server (uses "use client" + a useEffect)
 *
 * It must NOT render anything visible — it returns null.
 */
import { useEffect } from "react";

export function DevBootstrap() {
  useEffect(() => {
    if (!isBrowser) return;
    if ((window as unknown as { __rvDevlogInstalled?: boolean }).__rvDevlogInstalled) return;
    (window as unknown as { __rvDevlogInstalled?: boolean }).__rvDevlogInstalled = true;

    const apiBase = process.env.NEXT_PUBLIC_AETHER_API ?? "http://127.0.0.1:8000";
    const wsUrl = process.env.NEXT_PUBLIC_AETHER_WS ?? "ws://127.0.0.1:8000/ws/live";
    devlog.info("boot", "Aether console booting", {
      apiBase,
      wsUrl,
      userAgent: navigator.userAgent,
      ts: new Date().toISOString()
    });

    /*
     * isChunkLoadError - Turbopack/webpack throw a named ChunkLoadError when
     * a page references a chunk hash that no longer exists on disk. This is
     * a routine outcome of `next dev` rebuilding while a stale tab is open,
     * and it is unrecoverable (the module never resolves). The pragmatic fix
     * is to hard-reload the tab so the browser picks up the fresh manifest.
     *
     * We only auto-reload in development to avoid surprising users in prod,
     * and we throttle to once per 10 s so a chunk that legitimately 404s in
     * a loop does not turn into a reload bomb.
     */
    let lastReloadAt = 0;
    const maybeReloadOnChunkError = (err: unknown) => {
      const isDev = process.env.NODE_ENV !== "production";
      if (!isDev) return;
      const name = err && typeof err === "object" ? (err as { name?: string }).name : undefined;
      const msg = err && typeof err === "object" ? String((err as { message?: unknown }).message ?? "") : String(err);
      const isChunk = name === "ChunkLoadError" || /ChunkLoadError|Loading chunk \d+ failed/.test(msg);
      if (!isChunk) return;
      const now = Date.now();
      if (now - lastReloadAt < 10_000) {
        devlog.warn("error", "ChunkLoadError seen again within 10 s; not reloading (would loop)");
        return;
      }
      lastReloadAt = now;
      devlog.warn("error", "ChunkLoadError detected; hard-reloading the page");
      // Use replace to avoid leaving the broken page in history. The cache:
      // "no-store" hint is implicit because we are appending a cache-buster.
      window.location.replace(window.location.pathname + window.location.search + "#rv-reload-" + now);
      window.location.reload();
    };

    const onError = (event: ErrorEvent) => {
      devlog.error("error", "window.onerror", {
        message: event.message,
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno,
        error: event.error
      });
      maybeReloadOnChunkError(event.error ?? event.message);
    };
    const onRejection = (event: PromiseRejectionEvent) => {
      devlog.error("error", "unhandledrejection", { reason: event.reason });
      maybeReloadOnChunkError(event.reason);
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);
  return null;
}
