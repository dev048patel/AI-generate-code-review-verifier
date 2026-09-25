# Deploying the AI Code Review Verifier

There are two ways to run this for real. Start with the GitHub Action: it needs no
servers, and GitHub's disposable runner VMs give you the sandbox for free.

| | GitHub Action | Hosted GitHub App |
| --- | --- | --- |
| Setup | Copy two workflow files, add `ANTHROPIC_API_KEY` | Register an App, run Postgres + web + worker |
| Where PR code runs | GitHub's throwaway runner VM, in a job with **no secrets** | `acrv-sandbox` containers (no network, read-only, no caps, gVisor recommended) |
| Results | Check annotations, job summary, PR comment | Check Run with annotations, PR comment, dashboard |
| Cost control | Your Actions minutes + your API key | Per-account monthly LLM budget, rate limits |

## Option 1: GitHub Action

Fork-safe setup (recommended for any repo that accepts outside PRs):

1. Copy `examples/workflows/acrv-execute.yml` and `examples/workflows/acrv-report.yml` into
   `.github/workflows/`, replacing `YOUR_ORG/Ai-generate-code-review-verifier@v1` with
   wherever you publish this repo.
2. Add a repository secret `ANTHROPIC_API_KEY` (optional: without it you get rules +
   execution only, and the summary says so).

How the two workflows split trust:

- **acrv-execute** (`pull_request`): checks out the PR head, installs dependencies with
  lifecycle scripts disabled, runs lifecycle scripts offline, runs generated tests, and
  mutation-tests the changed lines against your own test suite. It gets a read-only token
  and **no secrets**, and it refuses to start if it sees any credentials. It uploads
  `acrv-execution.json`.
- **acrv-report** (`workflow_run`): runs in the base repo's context with secrets and
  write permission, and **never executes PR code**. It reads the diff from git objects,
  calls the LLM, and merges in the artifact. The artifact came from a machine that ran
  PR code, so it is treated as hostile input: schema-validated, size-capped, sanitized
  before rendering, and its PR number is checked against the commit the execute run
  actually built. The worst a malicious PR can do with it is misreport its own test
  results.

For private repos where every author is trusted, `examples/workflows/acrv-trusted.yml` runs
everything in one job.

Inputs: `fail-below` (fail the step under a score), `skip-mutation`, `llm-provider`
(`auto` / `anthropic` / `bedrock` / `none`), `model`, `sandbox` (`local-unsafe` /
`docker`), `comment`. Outputs: `trust-score`, `label`.

## Option 2: Hosted GitHub App

```bash
docker build -t acrv-sandbox:latest infra/sandbox   # the image PR code runs in
cp .env.example .env                                 # fill it in (see below)
docker compose up -d                                 # postgres + web + worker
docker compose up -d --scale worker=3                # more throughput
```

### Register the GitHub App

- **Permissions:** Contents read · Pull requests read & write · Checks read & write · Metadata read
- **Events:** Pull request
- **Webhook URL:** `https://<your host>/webhooks/github`, with a secret (`GITHUB_WEBHOOK_SECRET`)
- **Callback URL** (for dashboard sign-in): `https://<your host>/auth/callback`
- Put the App ID, private key, and the App's OAuth client id/secret in `.env`.

With `ACRV_PRODUCTION=true` the server refuses to start unless it has a webhook secret,
OAuth sign-in, Postgres, GitHub App credentials and the Docker sandbox. It also turns off
the demo endpoints (fixtures, simulate).

### What happens on a push

1. `POST /webhooks/github`: HMAC verified, then enqueued in Postgres with the
   `X-GitHub-Delivery` id, so redeliveries are no-ops. Enqueuing supersedes still-queued
   jobs for older commits of the same PR. Returns 202.
2. A worker claims the job (`FOR UPDATE SKIP LOCKED`) and mints an installation token
   scoped to **that one repo** with only the permissions above. It opens an in-progress
   Check Run.
3. It fetches the PR base and head commits (shallow, deepened until the merge base
   exists). The token is passed per git command and never written to `.git/config`.
4. The review runs: LLM + rules on the true diff. Every command that touches PR code runs
   in a fresh `acrv-sandbox` container: `--network none` (dependency download is the
   only networked step, with scripts disabled), `--read-only`, `--cap-drop ALL`,
   `no-new-privileges`, memory/CPU/pids limits, a non-root user, and only this job's
   directory mounted. No host environment variables are passed in.
5. Before publishing it re-checks whether a newer commit arrived. Then it updates one PR
   comment (keyed by marker, so no spam) and completes the Check Run with annotations.
   The conclusion is `success` / `neutral` / `failure`, where failure happens only below
   `ACRV_CHECK_FAIL_BELOW`, so blocking merges is opt-in.
6. Failures retry with jittered exponential backoff, and are dead-lettered after 3
   attempts (`status = 'failed'` in `review_jobs`, visible at `/api/dlq`). Workers
   heartbeat, and jobs held by a crashed worker are requeued after 10 minutes.

### Access control and spend

- Dashboard sign-in is "Sign in with GitHub" using the App's OAuth credentials. A
  session records the repos the user can reach through the App's installations,
  and the API only returns reviews for those repos (404 otherwise). State-changing API
  calls must come from `ACRV_PUBLIC_URL`'s origin (CSRF).
- LLM spend is tracked per GitHub account per month (`llm_spend`). Over
  `ACRV_MONTHLY_BUDGET_USD`, reviews still run rules + execution but skip the model,
  and say so. On-demand reviews are rate-limited per user.
- `/metrics` (Prometheus text, bearer `ACRV_METRICS_TOKEN`) exposes reviews by outcome
  and label, review seconds, LLM dollars, and webhooks by outcome. Logs are JSON lines.

### Sandbox hardening notes

- The worker needs the Docker socket to start sandbox containers, which makes the
  **worker** root-equivalent on its host. The worker is your code; PR code only ever
  runs inside the sandbox containers. Run workers on dedicated hosts.
- Install [gVisor](https://gvisor.dev) and set `ACRV_DOCKER_RUNTIME=runsc`. The sandbox
  flags stop the obvious attacks; gVisor means a kernel exploit also has to get through a
  user-space kernel.
- `ACRV_SANDBOX_ROOT` must be the same path inside the worker container and on the host,
  because the host daemon resolves bind mounts.

## Scaling notes

- Web and worker are the same image (`ACRV_ROLE=web|worker|all`) and are stateless.
  Scale each independently.
- Postgres holds everything durable: reviews, the queue, webhook deliveries, sessions and
  spend. A managed Postgres (RDS, Cloud SQL, Neon) with backups is enough; there is no
  Redis or SQS to run.
- The on-demand rate limiter is per web process. The per-account LLM budget in Postgres
  is the global backstop.
