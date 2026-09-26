import { useEffect, useRef, useState } from "react";
import type { FlowDiff, FlowStep, FlowStepChange, FlowStepKind, RequestFlow } from "../../atlasTypes";

/**
 * One request, told as numbered steps: who sends it, what checks it passes,
 * which of your functions run, what they touch (database, other services,
 * passwords), and what comes back. Missing safeguards sit where they should be.
 */

export const STEP_ICON: Record<FlowStepKind, string> = {
  client: "💻",
  middleware: "🚦",
  missing: "⚠️",
  handler: "⚙️",
  input: "📥",
  validate: "✅",
  call: "↳",
  database: "🗄️",
  external: "🌍",
  security: "🔑",
  response: "📤",
  error: "⛔",
};

/** The big parts a request passes through, in order: the one-line version of the flow. */
const LANE: Partial<Record<FlowStepKind, string>> = {
  client: "Client",
  middleware: "Checks",
  missing: "Checks",
  handler: "Your code",
  call: "Your code",
  input: "Your code",
  validate: "Your code",
  database: "Database",
  external: "Other services",
  security: "Passwords & tokens",
  response: "Response",
  error: "Response",
};

export function FlowStrip({ steps }: { steps: FlowStep[] }) {
  // Each part once, in the order the request first reaches it; the response always ends the trip.
  const lanes: Array<{ lane: string; warn: boolean }> = [];
  for (const s of steps) {
    const lane = LANE[s.kind];
    if (!lane) continue;
    const existing = lanes.find((l) => l.lane === lane);
    if (existing) existing.warn ||= s.kind === "missing";
    else lanes.push({ lane, warn: s.kind === "missing" });
  }
  const response = lanes.findIndex((l) => l.lane === "Response");
  if (response >= 0) lanes.push(...lanes.splice(response, 1));
  return (
    <div className="flow-strip" aria-label="Parts this request passes through">
      {lanes.map((l, i) => (
        <span key={l.lane} className="flow-strip-item">
          {i > 0 && <span className="flow-strip-arrow">→</span>}
          <span className={`flow-lane${l.warn ? " warn" : ""}`}>
            {l.warn ? "⚠ " : ""}
            {l.lane}
          </span>
        </span>
      ))}
    </div>
  );
}

function StepRow({ step, n, state, change }: { step: FlowStep; n?: number; state?: "active" | "done"; change?: FlowStepChange["change"] }) {
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (state === "active") ref.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  }, [state]);
  const cls = [
    "flow-step",
    `kind-${step.kind}`,
    step.severity ? `sev-${step.severity}` : "",
    state ?? "",
    change && change !== "same" ? `chg-${change}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <li ref={ref} className={cls} style={{ marginLeft: step.depth * 28 }} data-testid="flow-step">
      <div className="flow-dot" aria-hidden>
        {change === "added" ? "+" : change === "removed" ? "−" : n}
      </div>
      <div className="flow-body">
        <div className="flow-title">
          <span className="flow-icon" aria-hidden>
            {STEP_ICON[step.kind]}
          </span>
          {step.title}
          {step.code && step.kind !== "handler" && step.kind !== "call" && <code className="flow-code">{step.code}</code>}
        </div>
        <div className="flow-explain">{step.explain}</div>
        {step.file && (
          <div className="flow-where">
            {step.file}
            {step.line ? `:${step.line}` : ""}
          </div>
        )}
      </div>
    </li>
  );
}

const PLAY_MS = 1100;

/** A request's flow with a ▶ Play control that walks the request through it one step at a time. */
export function FlowPlayer({ flow }: { flow: RequestFlow }) {
  const [at, setAt] = useState(-1); // -1: not started; steps.length: finished
  const [playing, setPlaying] = useState(false);
  const steps = flow.steps;

  useEffect(() => {
    setAt(-1);
    setPlaying(false);
  }, [flow.routeId]);

  useEffect(() => {
    if (!playing) return;
    if (at >= steps.length - 1) {
      setPlaying(false);
      return;
    }
    const t = setTimeout(() => setAt((i) => i + 1), at < 0 ? 0 : PLAY_MS);
    return () => clearTimeout(t);
  }, [playing, at, steps.length]);

  const current = at >= 0 && at < steps.length ? steps[at] : undefined;
  const warnings = steps.filter((s) => s.kind === "missing");

  return (
    <div className="flow-player">
      <div className="flow-head">
        <div>
          <div className="flow-route">
            <span className={`method method-${flow.method.toLowerCase()}`}>{flow.method}</span> {flow.path}
          </div>
          <div className="muted mono">
            {flow.file}:{flow.line} · {steps.length} steps
            {warnings.length > 0 && <span className="flow-warn-count"> · ⚠ {warnings.length} to fix</span>}
          </div>
        </div>
        <div className="flow-controls">
          <button
            onClick={() => {
              if (at >= steps.length - 1) setAt(-1);
              setPlaying((p) => !p);
            }}
          >
            {playing ? "⏸ Pause" : at >= steps.length - 1 ? "↺ Replay" : "▶ Play request"}
          </button>
          <button className="secondary" aria-label="Previous step" disabled={at <= 0} onClick={() => (setPlaying(false), setAt((i) => Math.max(0, i - 1)))}>
            ◀
          </button>
          <button
            className="secondary"
            aria-label="Next step"
            disabled={at >= steps.length - 1}
            onClick={() => (setPlaying(false), setAt((i) => Math.min(steps.length - 1, i + 1)))}
          >
            ▶
          </button>
        </div>
      </div>
      <FlowStrip steps={steps} />
      <div className="flow-caption" aria-live="polite">
        {current ? (
          <>
            <strong>
              Step {at + 1} of {steps.length}:
            </strong>{" "}
            {current.title}. <span className="muted">{current.explain}</span>
          </>
        ) : (
          <span className="muted">Press ▶ to follow the request through the code, one step at a time. Indented steps happen inside the function above them.</span>
        )}
      </div>
      <ol className="flow">
        {steps.map((s, i) => (
          <StepRow key={s.key} step={s} n={i + 1} state={i === at ? "active" : i < at ? "done" : undefined} />
        ))}
      </ol>
    </div>
  );
}

/** A request before and after a change: added steps in green, removed ones struck out. */
export function FlowDiffView({ diff }: { diff: FlowDiff }) {
  let n = 0;
  return (
    <ol className="flow flow-diff">
      {diff.steps.map((s) => (
        <StepRow key={`${s.change}:${s.key}`} step={s} n={s.change === "removed" ? undefined : ++n} change={s.change} />
      ))}
    </ol>
  );
}

export function FlowChanges({ flows }: { flows: FlowDiff[] }) {
  const [open, setOpen] = useState<string | null>(flows[0]?.routeId ?? null);
  useEffect(() => setOpen(flows[0]?.routeId ?? null), [flows]);
  if (flows.length === 0) return <p className="muted">No request moves through the code differently after this change.</p>;
  return (
    <div className="flow-changes">
      {flows.map((d) => (
        <div key={d.routeId} className={`flow-change status-${d.status}`}>
          <button className="flow-change-head" aria-expanded={open === d.routeId} onClick={() => setOpen(open === d.routeId ? null : d.routeId)}>
            <span className="flow-change-badge">{{ added: "new", removed: "gone", changed: "changed", same: "same" }[d.status]}</span>
            <span className="mono">{d.label}</span>
            <span className="flow-change-summary">{d.summary}</span>
          </button>
          {open === d.routeId && <FlowDiffView diff={d} />}
        </div>
      ))}
    </div>
  );
}
