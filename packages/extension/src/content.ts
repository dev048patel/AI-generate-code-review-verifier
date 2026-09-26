import { atlasUrl, parseGithubUrl, renderMessage, renderPanel, type GithubLocation, type PrImpact } from "./lib.js";

declare const chrome: any; // eslint-disable-line @typescript-eslint/no-explicit-any

let lastUrl = "";

async function serverUrl(): Promise<string | undefined> {
  const { server } = (await chrome.storage.sync.get(["server"])) as { server?: string };
  return server;
}

function mountPoint(): Element | null {
  // PR header area; GitHub's markup changes, so try a few anchors.
  return document.querySelector("#partial-discussion-header") ?? document.querySelector(".gh-header-show") ?? document.querySelector("main");
}

async function showPr(loc: GithubLocation & { pr: number }): Promise<void> {
  document.querySelectorAll('[data-acrv="panel"]').forEach((e) => e.remove());
  const anchor = mountPoint();
  if (!anchor) return;
  const server = await serverUrl();
  if (!server) {
    anchor.after(renderMessage(document, "Repo Atlas: set your server URL to see what this PR changes.", chrome.runtime.getURL("options.html")));
    return;
  }
  const loading = renderMessage(document, "Repo Atlas: mapping this PR…");
  anchor.after(loading);
  const res = (await chrome.runtime.sendMessage({ type: "acrv:pr-impact", loc })) as { ok: true; impact: PrImpact } | { ok: false; error: string };
  loading.remove();
  if (location.href !== lastUrl) return; // navigated away meanwhile
  anchor.after(res.ok ? renderPanel(document, res.impact, atlasUrl(server, loc)) : renderMessage(document, `Repo Atlas couldn't map this PR: ${res.error}`));
}

async function showRepoButton(loc: GithubLocation): Promise<void> {
  if (document.querySelector('[data-acrv="button"]')) return;
  const server = await serverUrl();
  const actions = document.querySelector("#repository-details-container ul, .pagehead-actions");
  if (!server || !actions) return;
  const li = document.createElement("li");
  li.dataset.acrv = "button";
  const a = document.createElement("a");
  a.className = "btn btn-sm acrv-button";
  a.textContent = "🗺️ Open in Repo Atlas";
  a.href = atlasUrl(server, loc);
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  li.append(a);
  actions.prepend(li);
}

function onNavigate(): void {
  if (location.href === lastUrl) return;
  lastUrl = location.href;
  const loc = parseGithubUrl(location.href);
  if (!loc) return;
  if (loc.pr) void showPr(loc as GithubLocation & { pr: number });
  else void showRepoButton(loc);
}

// GitHub navigates without full page loads.
document.addEventListener("turbo:load", onNavigate);
new MutationObserver(onNavigate).observe(document.body, { childList: true, subtree: false });
onNavigate();
