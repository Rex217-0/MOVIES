# Worker mesh — how to add a GPU

The coordinator (this server) does not render. It keeps a registry of workers and
places each job on one that advertises the engine the job needs. Everything in
this file is implemented; it was verified end-to-end with a real coordinator and
a real worker over HTTP.

## Run a worker

On a machine with a GPU (or just CPU):

```bash
COORDINATOR_URL=https://movies.example.com \
COORDINATOR_TOKEN=<the coordinator's APP_AUTH_TOKEN> \
WORKER_ID=gpu-rig-1 \
WORKER_TOKEN=<secret the coordinator must present> \
WORKER_PUBLIC_URL=http://10.0.0.5:8090 \
WORKER_GPU="Radeon RX 9070" \
WORKER_VRAM_GB=16 \
WORKER_ROLE=gpu \
COMFYUI_URL=http://127.0.0.1:8188 \
node scripts/worker.mjs
```

`COORDINATOR_TOKEN` must equal the coordinator's `APP_AUTH_TOKEN`; without it
the worker cannot register (`401`). `WORKER_TOKEN` is the reverse direction: the
secret the coordinator must present to reach this worker's `/job`.

`WORKER_ROLE` is `gpu`, `cpu`, or `phone`. A `phone` node is a low-tier CPU
contributor only: the scheduler refuses to place a heavy engine (comfyui, sdxl,
lora, wan, video_render) on it, and it cannot relabel itself as a GPU node later.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/direk/workers/register` | A worker joins (or refreshes). |
| POST | `/api/direk/workers/heartbeat` | Keep-alive. Missing heartbeats mark it offline after 90s. |
| DELETE | `/api/direk/workers/:id` | Remove a worker. |
| GET | `/api/direk/workers` | The mesh view. Never exposes a worker token. |
| POST | `/api/direk/workers/dispatch` | Place a job and run it. |

`dispatch` answers `503` when no worker is eligible, `502` when a worker's output
fails verification, and `200` only when the bytes check out.

## Trust

A worker is untrusted. Before a job is called done, the coordinator checks the
bytes it returned: a real mp4/webm (or image) signature, a plausible length, and
a duration within tolerance of what was asked. A worker that returns a stub, a
wrong-sized clip, or a non-video gets a `502` with the reason — never a fake
success. See `src/direk/verify.ts`.

## Durability

Job state is written to SQLite (`jobs` table) on every progress tick, so a phone
that slept can re-attach and a restart does not lose the record:

- `GET /api/direk/jobs` — recent jobs, newest first.
- `GET /api/direk/jobs/:id` — one job's full view.

At startup, any job left `running` is marked `error` with an honest message: a
job cannot have survived the process that was running it.

## Quota

One shared free-tier key is not unlimited. `AI_DAILY_QUOTA` (default `500`,
`0` disables) caps AI work per client per UTC day. A refused call answers `429`
with a clear message before any spend happens, and every AI response carries
`X-AI-Quota-Remaining`.
