import { apiUrl, type GithubLocation, type PrImpact } from "./lib.js";

declare const chrome: any; // eslint-disable-line @typescript-eslint/no-explicit-any

/**
 * Fetches run here, not in the content script: the service worker has host
 * permission for the configured server, so no CORS setup is needed and the
 * API token never touches github.com's page.
 */
chrome.runtime.onMessage.addListener(
  (msg: { type: string; loc: GithubLocation & { pr: number } }, _sender: unknown, reply: (r: { ok: true; impact: PrImpact } | { ok: false; error: string }) => void) => {
    if (msg.type !== "acrv:pr-impact") return false;
    void (async () => {
      const { server, token } = (await chrome.storage.sync.get(["server", "token"])) as { server?: string; token?: string };
      if (!server) return reply({ ok: false, error: "not-configured" });
      try {
        const res = await fetch(apiUrl(server, msg.loc), {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          credentials: "include",
        });
        if (!res.ok) return reply({ ok: false, error: `${res.status} ${(await res.text()).slice(0, 200)}` });
        reply({ ok: true, impact: (await res.json()) as PrImpact });
      } catch (err) {
        reply({ ok: false, error: String(err) });
      }
    })();
    return true; // async reply
  },
);
