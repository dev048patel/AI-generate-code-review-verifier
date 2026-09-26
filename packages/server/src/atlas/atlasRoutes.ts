import express, { type Express, type NextFunction, type Request, type Response } from "express";
import type { OtlpTraces } from "@acrv/atlas";
import type { AuthedRequest } from "../auth/githubOAuth.js";
import { AtlasError, REPO_RE, type AtlasService } from "./atlasService.js";

export interface AtlasRouteOptions {
  service: AtlasService;
  /** Guards reads (dashboard session, or the extension's bearer token). */
  signedIn: (req: Request, res: Response, next: NextFunction) => void;
  /** Rate limit for starting analyses (clones + CPU). */
  limitExpensive: (req: Request, res: Response, next: NextFunction) => void;
  /** Required on POST /v1/traces when set. */
  traceToken?: string;
  /** Lets the browser extension call the read endpoints without a dashboard session. */
  apiToken?: string;
}

function repoOf(req: Request): string {
  const repo = `${req.params.owner}/${req.params.repo}`;
  if (!REPO_RE.test(repo)) throw new AtlasError(400, "repo must look like owner/name");
  return repo;
}

function handle(fn: (req: AuthedRequest, res: Response) => Promise<unknown> | unknown) {
  return async (req: AuthedRequest, res: Response) => {
    try {
      const body = await fn(req, res);
      if (body !== undefined && !res.headersSent) res.json(body);
    } catch (err) {
      const status = err instanceof AtlasError ? err.status : 502;
      if (!res.headersSent) res.status(status).json({ error: err instanceof Error ? err.message.split("\n")[0] : String(err) });
    }
  };
}

/** REST + SSE endpoints for Repo Atlas, and the OTLP/HTTP trace receiver. */
export function mountAtlas(app: Express, options: AtlasRouteOptions): void {
  const { service } = options;
  // Read endpoints accept either a signed-in session or the extension's API token.
  const readAuth = (req: Request, res: Response, next: NextFunction) => {
    if (options.apiToken && req.header("authorization") === `Bearer ${options.apiToken}`) return next();
    return options.signedIn(req, res, next);
  };

  app.post(
    "/api/atlas/analyze",
    options.signedIn,
    options.limitExpensive,
    handle((req) => {
      const { repo, maxCommits } = req.body as { repo?: string; maxCommits?: number };
      if (!repo || !REPO_RE.test(repo.trim())) throw new AtlasError(400, "repo must look like owner/name");
      return { job: service.analyze(repo.trim(), typeof maxCommits === "number" ? maxCommits : undefined) };
    }),
  );

  app.get(
    "/api/atlas/:owner/:repo",
    readAuth,
    handle((req) => service.status(repoOf(req))),
  );

  app.get(
    "/api/atlas/:owner/:repo/graph",
    readAuth,
    handle((req) => service.graph(repoOf(req), typeof req.query.ref === "string" ? req.query.ref : "HEAD")),
  );

  app.get(
    "/api/atlas/:owner/:repo/flows",
    readAuth,
    handle((req) => service.flows(repoOf(req), typeof req.query.ref === "string" ? req.query.ref : "HEAD")),
  );

  app.get(
    "/api/atlas/:owner/:repo/architecture",
    readAuth,
    handle((req) => service.architecture(repoOf(req), typeof req.query.ref === "string" ? req.query.ref : "HEAD")),
  );

  app.get(
    "/api/atlas/:owner/:repo/compare",
    readAuth,
    handle((req) => {
      const { from, to } = req.query as { from?: string; to?: string };
      if (!from || !to) throw new AtlasError(400, "from and to are required");
      return service.compare(repoOf(req), from, to);
    }),
  );

  app.get(
    "/api/atlas/:owner/:repo/pulls/:number",
    readAuth,
    options.limitExpensive,
    handle((req) => service.prImpact(repoOf(req), Number(req.params.number), req.query.graphs === "1")),
  );

  app.get(
    "/api/atlas/:owner/:repo/runtime",
    readAuth,
    handle((req) => service.runtime(repoOf(req))),
  );

  // Server-sent events: the dashboard's live map redraws as traces arrive.
  app.get("/api/atlas/:owner/:repo/runtime/stream", readAuth, (req, res) => {
    let repo: string;
    try {
      repo = repoOf(req);
    } catch (err) {
      res.status(400).json({ error: String(err) });
      return;
    }
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    let last = 0;
    let pending: ReturnType<typeof setTimeout> | undefined;
    const send = () => {
      last = Date.now();
      pending = undefined;
      res.write(`data: ${JSON.stringify(service.runtime(repo))}\n\n`);
    };
    const unsubscribe = service.subscribe(repo, () => {
      // At most one update per second, however fast spans arrive.
      if (pending) return;
      pending = setTimeout(send, Math.max(0, 1000 - (Date.now() - last)));
    });
    const keepAlive = setInterval(() => res.write(": ping\n\n"), 25_000);
    send();
    req.on("close", () => {
      unsubscribe();
      clearInterval(keepAlive);
      if (pending) clearTimeout(pending);
    });
  });

  // OTLP/HTTP JSON receiver: point an OpenTelemetry exporter at
  //   OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=https://<host>/v1/traces?repo=owner/name
  //   OTEL_EXPORTER_OTLP_PROTOCOL=http/json
  app.post("/v1/traces", express.json({ limit: "10mb", type: ["application/json", "application/x-protobuf+json"] }), (req, res) => {
    if (options.traceToken && req.header("authorization") !== `Bearer ${options.traceToken}`) {
      res.status(401).json({ error: "invalid trace token" });
      return;
    }
    const repo = String(req.query.repo ?? req.header("x-acrv-repo") ?? "");
    if (!REPO_RE.test(repo)) {
      res.status(400).json({ error: "pass ?repo=owner/name (or the x-acrv-repo header)" });
      return;
    }
    if (req.is("application/x-protobuf")) {
      res.status(415).json({ error: "send OTLP as JSON: OTEL_EXPORTER_OTLP_PROTOCOL=http/json" });
      return;
    }
    try {
      service.ingestTraces(repo, req.body as OtlpTraces);
      res.json({ partialSuccess: {} });
    } catch (err) {
      res.status(400).json({ error: String(err).split("\n")[0] });
    }
  });
}
