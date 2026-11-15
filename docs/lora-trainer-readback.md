# Read-back: how the app actually calls the trainer

Status: **read-only report**, requested by LROS Command. No behaviour changed.

Sources read on branch `feat/blockers-a-i`:

- `src/direk/trainer.ts` (local mode)
- `src/direk/lora.ts` (text half of a set)
- `src/direk/loraPlan.ts` (brief -> plan)
- PR #18 `src/direk/colabTrainer.ts` + `scripts/colab_lora_train.ipynb` (Colab mode, not merged)

## 1. Which trainer is actually called

**`kohya-ss/sd-scripts`** — and only `sd-scripts`. The app never calls the
`kohya_ss` GUI.

| Layer | What it calls |
| --- | --- |
| Local (`trainer.ts`) | `train_network.py`, or `sdxl_train_network.py` when present |
| Colab (#18 notebook) | `/content/sd-scripts/sdxl_train_network.py` |

`trainerScript()` checks `train_network.py` first, then `sdxl_train_network.py`.
**Ordering mismatch:** for an SDXL base model (the app default is
`stabilityai/stable-diffusion-xl-base-1.0`) the SDXL script is the correct one,
but a checkout that contains both resolves to `train_network.py`. The Colab
notebook hard-codes `sdxl_train_network.py`, so the two modes can train with
different scripts for the same config.

## 2. Required paths and how they are supplied

| What | Local env | `direk.config.json` key | Colab source |
| --- | --- | --- | --- |
| Trainer checkout | `KOHYA_DIR` | `kohya_dir` | `git clone …/sd-scripts.git /content/sd-scripts` |
| Python | `KOHYA_PYTHON` (default `python3`, `python` on Windows) | `kohya_python` | `sys.executable` |
| Base model | `KOHYA_BASE_MODEL` (required) | `kohya_base_model` | `job.json` -> `local_base` |
| Output dir | `KOHYA_OUTPUT_DIR` (default `<cwd>/lora_runs`) | `kohya_output_dir` | `<job>/output` |
| Accelerate | `KOHYA_ACCELERATE=1` | `kohya_accelerate` | not used (runs `sys.executable` directly) |
| Timeout | `KOHYA_TIMEOUT_MS` (default 6 h) | — | none (relies on Colab's own limits) |

`trainerStatus()` is honestly unavailable unless `KOHYA_DIR` exists, contains a
trainer script, **and** `KOHYA_BASE_MODEL` is set.

Invocation:

```
# default
<python> <script> --config_file <root>/kohya_config.toml
# KOHYA_ACCELERATE=1
accelerate launch --num_cpu_threads_per_process 2 <script> --config_file <root>/kohya_config.toml
```

`cwd` is `KOHYA_DIR`. A run writes `dataset/`, `kohya_config.toml`, then the
artifact is the newest `*.safetensors` in the output dir (`findArtifact`).

## 3. The config schema, and the one real mismatch

`trainer.ts` writes a **kohya_ss-style** TOML with bracketed sections:

```
[network_arguments]   network_module / network_dim / network_alpha
[optimizer_arguments] learning_rate / optimizer_type / lr_scheduler
[training_arguments]  pretrained_model_name_or_path / max_train_epochs /
                      save_every_n_epochs / mixed_precision / seed
```

`parseKohyaConfig()` in #18 reads that same file and takes the **first** value
for each bare key, ignoring section headers. That is fine for every key except
`enable_bucket`, which appears twice (`[general]` and `[[datasets]]`); the first
wins and both are `true`, so no harm today — but it is a latent trap.

The notebook re-emits a **flat-key** config (no `[network_arguments]` etc.) from
`job.json`. `sd-scripts` accepts both flat and sectioned keys, so this works —
but it means the notebook's config is not byte-identical to the local one, which
contradicts the "one source of truth" comment in `colabTrainer.ts`.

Keys dropped by the notebook's re-emit (present in the app's config, absent from
the notebook's): `[general]` `enable_bucket`/`bucket_no_upscale` are kept, but
`lr_scheduler_num_cycles`, `log_with`, and `output_name` placement differ.
`lr_scheduler_num_cycles = 3` is silently lost in the Colab path.

## 4. What does not match the notebook

1. **Script choice** — app prefers `train_network.py`; notebook hard-codes
   `sdxl_train_network.py`. For an SDXL base model the notebook is the correct
   one, the local default can be wrong.
2. **Config shape** — sectioned (app) vs flat (notebook). Works, but not
   identical, so "same config both ways" is not literally true.
3. **`lr_scheduler_num_cycles`** — lost in the Colab re-emit.
4. **`max_train_epochs`** — both default to 10, no mismatch, but note the
   notebook's `epoch` counter increments on any log line containing "epoch",
   which over-counts with `save_every_n_epochs = 2` logging.
5. **Accelerate** — the local path can use `accelerate launch`; the notebook
   never does.

## 5. Not done, by instruction

- No change to `local` mode.
- No access to Colab, Drive, Kaggle, or Server-2.
- No token requested or read.
- No merge performed.
- `jobs/job.json` / `status.json` are **not** treated as protocol; `colabTrainer`
  is unmerged and unagreed.
