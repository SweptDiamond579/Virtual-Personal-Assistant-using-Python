"use client";

import {
  Component,
  lazy,
  Suspense,
  useCallback,
  useRef,
  useState,
  useSyncExternalStore,
  type ErrorInfo,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { createBridge, type CoreBridge } from "./bridge";
import { CoreNodeLabels, CoreNodeList } from "./CoreNodes";
import { detectWebGL } from "./detect-webgl";
import { FallbackCore2D } from "./FallbackCore2D";
import { keyToCameraAction } from "./logic/camera";
import { describeCoreState } from "./logic/state-targets";
import type { AICoreProps } from "./types";
import styles from "./AICore.module.css";

const CoreScene = lazy(() => import("./scene/CoreScene"));

const noopSubscribe = () => () => {};

class SceneBoundary extends Component<{ onError: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.warn("[AICore] WebGL scene failed; using the 2D core.", error, info.componentStack);
    this.props.onError();
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

/**
 * The JARVIS AI core. Sizes to its parent. Lazy-loads the WebGL scene on the
 * client and shows the 2D core while loading, when WebGL is unavailable or
 * fails, or when `mode === "2d"`.
 */
export function AICore({
  state,
  levelRef,
  quality,
  mode,
  reducedMotion,
  active,
  onNodeSelect,
  showStats = false,
  className,
}: AICoreProps) {
  const isClient = useSyncExternalStore(noopSubscribe, () => true, () => false);
  const webgl = useSyncExternalStore(noopSubscribe, detectWebGL, () => false);
  const [failed, setFailed] = useState(false);
  const use3D = isClient && webgl && mode === "3d" && !failed;

  // ready: first 3D frame rendered; fallbackGone: the 2D core has faded out.
  const [ready, setReady] = useState(false);
  const [fallbackGone, setFallbackGone] = useState(false);
  const [prevUse3D, setPrevUse3D] = useState(use3D);
  if (prevUse3D !== use3D) {
    setPrevUse3D(use3D);
    setReady(false);
    setFallbackGone(false);
  }

  const bridge = useRef<CoreBridge>(createBridge());
  const attachContainer = useCallback((el: HTMLDivElement | null) => {
    bridge.current.container = el;
    bridge.current.onReady = el ? () => setReady(true) : null;
  }, []);
  const attachStats = useCallback((el: HTMLDivElement | null) => {
    bridge.current.statsEl = el;
  }, []);
  const onContextLost = useCallback(() => setFailed(true), []);
  const onSceneError = useCallback(() => setFailed(true), []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget || !use3D) return;
    const action = keyToCameraAction(e.key);
    if (!action) return;
    e.preventDefault();
    bridge.current.camera?.apply(action);
  };

  const showFallback = !use3D || !fallbackGone;

  return (
    <div
      ref={attachContainer}
      className={[styles.root, className].filter(Boolean).join(" ")}
      tabIndex={0}
      role="group"
      aria-roledescription="AI core visualisation"
      aria-label={use3D ? "JARVIS AI core. Arrow keys orbit, plus and minus zoom, 0 resets the view." : "JARVIS AI core"}
      onKeyDown={onKeyDown}
      data-ready={use3D && ready ? "true" : undefined}
    >
      <div className={styles.stage} role="img" aria-label={describeCoreState(state)}>
        {use3D ? (
          <div className={styles.scene}>
            <SceneBoundary onError={onSceneError}>
              <Suspense fallback={null}>
                <CoreScene
                  state={state}
                  levelRef={levelRef}
                  quality={quality}
                  reducedMotion={reducedMotion}
                  active={active}
                  onNodeSelect={onNodeSelect}
                  bridge={bridge}
                  onContextLost={onContextLost}
                />
              </Suspense>
            </SceneBoundary>
          </div>
        ) : null}
        {showFallback ? (
          <div
            className={styles.fallback}
            data-hidden={use3D && ready ? "true" : undefined}
            onTransitionEnd={(e) => {
              if (e.target === e.currentTarget && use3D && ready) setFallbackGone(true);
            }}
          >
            <FallbackCore2D state={state} levelRef={levelRef} reducedMotion={reducedMotion || !active} />
          </div>
        ) : null}
      </div>

      {use3D && ready ? <CoreNodeLabels bridge={bridge} /> : null}
      <CoreNodeList bridge={bridge} onNodeSelect={onNodeSelect} />
      {use3D ? (
        <p className={styles.hint} aria-hidden="true">
          ← → ↑ ↓ orbit · + − zoom · 0 reset
        </p>
      ) : null}
      {showStats ? (
        <div className={styles.stats} aria-hidden="true">
          {use3D ? <span ref={attachStats} /> : <span>2D fallback · no WebGL stats</span>}
        </div>
      ) : null}
    </div>
  );
}
