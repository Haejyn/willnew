/** Live data hooks shared by every screen. */
import { useCallback, useEffect, useRef, useState } from "react";
import type { Api, Run } from "./api";
import { applyUpdate } from "./api";

export function useLiveRun(api: Api, id: string | undefined) {
  const [run, setRun] = useState<Run | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(false);

  const load = useCallback(() => {
    if (!id) return;
    setError(null);
    api
      .run(id)
      .then(setRun)
      .catch((e: Error) => setError(e.message));
  }, [api, id]);

  useEffect(() => {
    setRun(null);
    if (!id) return;
    load();
    let refetching = false;
    return api.subscribe(
      id,
      (u) =>
        setRun((r) => {
          if (!r) return r;
          const next = applyUpdate(r, u);
          if (next) return next;
          if (!refetching) {
            refetching = true;
            api.run(id).then((fresh) => {
              refetching = false;
              setRun(fresh);
            });
          }
          return r;
        }),
      setLive,
    );
  }, [api, id, load]);

  return { run, setRun, error, live, reload: load };
}

/** The run list, refreshed every few seconds (light: no events, no patches). */
export function useRuns(api: Api, ms = 3000) {
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => {
    api
      .runs()
      .then((r) => {
        setRuns(r);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, [api]);
  useEffect(() => {
    reload();
    const t = setInterval(reload, ms);
    return () => clearInterval(t);
  }, [reload, ms]);
  return { runs, error, reload };
}

const WATCH_KEY = "willnew.watch";
/** "끝나면 알림" — a browser notification when a watched run is waiting for a human. */
export function useWatch(runs: Run[] | null) {
  const [watched, setWatched] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(WATCH_KEY) ?? "[]"));
    } catch {
      return new Set();
    }
  });
  const seen = useRef(new Map<string, string>());
  useEffect(() => {
    if (!runs) return;
    for (const r of runs) {
      const prev = seen.current.get(r.id);
      seen.current.set(r.id, r.review.status);
      if (prev && prev !== "pending" && r.review.status === "pending" && watched.has(r.id) && typeof Notification !== "undefined" && Notification.permission === "granted") {
        new Notification("willnew · 내 차례", { body: `${r.title} — 검증을 통과했어요. 검토해 주세요.`, icon: "./apple-touch-icon.png" });
      }
    }
  }, [runs, watched]);
  const toggle = useCallback(async (id: string) => {
    if (typeof Notification !== "undefined" && Notification.permission === "default") await Notification.requestPermission();
    setWatched((w) => {
      const next = new Set(w);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      try {
        localStorage.setItem(WATCH_KEY, JSON.stringify([...next]));
      } catch {
        /* storage blocked */
      }
      return next;
    });
  }, []);
  return { watched, toggle };
}
