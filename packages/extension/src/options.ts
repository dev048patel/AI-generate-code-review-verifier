import { normalizeServer } from "./lib.js";

declare const chrome: any; // eslint-disable-line @typescript-eslint/no-explicit-any

const server = document.getElementById("server") as HTMLInputElement;
const token = document.getElementById("token") as HTMLInputElement;
const status = document.getElementById("status")!;

void chrome.storage.sync.get(["server", "token"]).then((v: { server?: string; token?: string }) => {
  server.value = v.server ?? "";
  token.value = v.token ?? "";
});

document.getElementById("save")!.addEventListener("click", async () => {
  const origin = normalizeServer(server.value);
  if (!origin) {
    status.textContent = "Enter an https:// URL (http:// is only allowed for localhost).";
    return;
  }
  // Ask for access to just this server; the extension holds no other host access besides github.com.
  const granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
  if (!granted) {
    status.textContent = "Permission to reach the server was not granted.";
    return;
  }
  await chrome.storage.sync.set({ server: origin, token: token.value.trim() });
  status.textContent = "Saved.";
});
