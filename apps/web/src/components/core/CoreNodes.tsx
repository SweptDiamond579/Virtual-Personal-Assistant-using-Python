"use client";

import { useId } from "react";
import type { CoreBridge } from "./bridge";
import { CORE_NODES } from "./logic/nodes";
import type { CoreNodeId } from "./types";
import styles from "./AICore.module.css";

/** Screen-space labels for the satellites; positioned every frame by the scene (no re-renders). */
export function CoreNodeLabels({ bridge }: { bridge: React.RefObject<CoreBridge> }) {
  return (
    <div className={styles.labels} aria-hidden="true">
      {CORE_NODES.map((n, i) => (
        <span
          key={n.id}
          className={styles.label}
          ref={(el) => {
            bridge.current.labels[i] = el;
          }}
        >
          <span className={styles.labelIndex}>{String(i + 1).padStart(2, "0")}</span>
          <span className={styles.labelText}>{n.label}</span>
        </span>
      ))}
    </div>
  );
}

/**
 * Accessible alternative to clicking the 3D satellites: a list of buttons that
 * is visually hidden until it receives keyboard focus. Focusing a button
 * highlights its satellite in the scene.
 */
export function CoreNodeList({
  bridge,
  onNodeSelect,
}: {
  bridge: React.RefObject<CoreBridge>;
  onNodeSelect?: (node: CoreNodeId) => void;
}) {
  const uid = useId();
  return (
    <nav className={styles.nodeNav} aria-label="Core systems">
      <ul>
        {CORE_NODES.map((n) => (
          <li key={n.id}>
            <button
              type="button"
              className={styles.nodeButton}
              onClick={() => onNodeSelect?.(n.id)}
              onFocus={() => {
                bridge.current.focusNode = n.id;
              }}
              onBlur={() => {
                if (bridge.current.focusNode === n.id) bridge.current.focusNode = null;
              }}
              aria-describedby={`${uid}-${n.id}`}
            >
              {n.label}
            </button>
            <span id={`${uid}-${n.id}`} className={styles.srOnly}>
              {n.description}
            </span>
          </li>
        ))}
      </ul>
    </nav>
  );
}
