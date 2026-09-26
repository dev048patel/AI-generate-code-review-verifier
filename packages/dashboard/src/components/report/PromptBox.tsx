import { useState } from "react";

/** A ready-to-paste prompt for an AI coding agent, with one-click copy. */
export function PromptBox({ prompt, label = "Prompt to fix it", open: startOpen = false }: { prompt: string; label?: string; open?: boolean }) {
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState(startOpen);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(prompt);
    } catch {
      // Clipboard API blocked (http, iframe): fall back to a selection copy.
      const t = document.createElement("textarea");
      t.value = prompt;
      document.body.append(t);
      t.select();
      document.execCommand?.("copy");
      t.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };
  return (
    <div className="prompt-box">
      <div className="prompt-head">
        <button className="link-button" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? "▾" : "▸"} {label}
        </button>
        <button className="secondary prompt-copy" onClick={() => void copy()} aria-label={`Copy: ${label}`}>
          {copied ? "✓ Copied" : "Copy prompt"}
        </button>
      </div>
      {open && <pre className="prompt-text">{prompt}</pre>}
    </div>
  );
}
