# LoRA training on Colab (remote mode)

`TRAIN_BACKEND` picks where a LoRA run trains. `local` (the default) runs
kohya_ss / sd-scripts on Server-2, unchanged. `colab` hands the run to a Colab
notebook so a big run uses a cloud GPU.

```
TRAIN_BACKEND=local   kohya_ss on Server-2            (unchanged)
TRAIN_BACKEND=colab   a Colab notebook, through Drive
```

## How it works

The two sides never talk to each other. They trade files in one Google Drive
folder, so a run survives a Colab disconnect and a Server-2 restart.

```
Server-2                                   Colab notebook
   |                                            |
   |  job.json + dataset/  ------------------->  |   (the app writes)
   |                                            |   train
   |  <------------------- status.json          |   (QUEUED/RUNNING/DONE/FAILED/CANCELLED)
   |  cancel.flag  -------------------------->  |   (the app writes, the notebook obeys)
   |  <------------------- output/*.safetensors |
   |  <------------------- manifest.json        |   (name, bytes, sha256)
   |
   verify sha256 -> publish to ComfyUI
```

The layout inside the Drive root:

```
LORA_TRAINING/jobs/<job_id>/
  job.json         the app writes the training parameters and the paths
  dataset/         the app writes the images and their .txt captions
  status.json      the notebook writes state, epoch, progress, error
  cancel.flag      the app writes this to ask for a clean stop
  output/          the notebook writes the .safetensors here
  manifest.json    the notebook writes name, bytes and sha256
```

## Set it up

1. On Server-2, point the app at a Drive folder, in `.env`:

   ```
   TRAIN_BACKEND=colab
   COLAB_DRIVE_ROOT=G:\My Drive\LORA_TRAINING
   ```

   `COLAB_DRIVE_ROOT` is a Drive for Desktop path, so no API token is needed.
   For a folder id instead, set `COLAB_DRIVE_FOLDER_ID` and the Google Drive
   OAuth client (`GDRIVE_CLIENT_ID`, `GDRIVE_CLIENT_SECRET`).

2. Open `scripts/colab_lora_train.ipynb` in Colab. Set the runtime to **GPU**.

3. In the notebook, set `DRIVE_ROOT` to the same folder. Leave `JOB_ID` empty to
   pick the newest `QUEUED` job, or paste one id.

4. Start a run in the LoRA Studio. The app writes `job.json` and the dataset to
   Drive and waits. Run the notebook; it trains and reports back.

## What the app will not do

- If Drive is not configured, `/api/direk/train/status` reports the backend as
  unavailable with the reason. It does not start a fake run.
- When the notebook writes `FAILED`, the job is `failed` with the notebook's
  error. No placeholder weights are created.
- The downloaded `.safetensors` is checked against `manifest.json`. A sha256
  mismatch, a missing manifest or a missing file fails the job and publishes
  nothing. Only a verified file reaches ComfyUI.

## Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `TRAIN_BACKEND` | `local` | `local` for kohya_ss, `colab` for the notebook |
| `COLAB_DRIVE_ROOT` | — | a Drive for Desktop folder (preferred) |
| `COLAB_DRIVE_FOLDER_ID` | — | a Drive folder id, used with the Drive API v3 |
| `COLAB_POLL_MS` | `12000` | how often the app reads `status.json` |
| `KOHYA_BASE_MODEL` | — | the base model recorded in `job.json` |

## Secrets (Colab)

The notebook fetches its tools from the internet: `sd-scripts` from GitHub and
the base model from HuggingFace. Tokens are read from **Colab Secrets** (left
sidebar -> key icon, then enable "Notebook access"), never written in the
notebook:

| Secret | Used for |
| --- | --- |
| `HF_TOKEN` | a gated / private HuggingFace base model |
| `GITHUB_TOKEN` | a private sd-scripts fork, or higher clone rate limits |
| `SD_SCRIPTS_REPO` | optional: override the sd-scripts repo URL |

A missing secret is not fatal. With no `HF_TOKEN` the notebook downloads a
public base model; with no `GITHUB_TOKEN` it clones the public repo anonymously.
The cell prints which token it found and which it did not, so a failure to fetch
is never mistaken for a training failure.

## Resuming after a disconnect

Re-run the notebook with the same `JOB_ID`. If `output/` already holds a
`.safetensors` and there is no `cancel.flag`, the notebook skips training and
goes straight to writing `manifest.json`, so a finished run is not redone.

## Code

| File | Role |
| --- | --- |
| `src/direk/trainDrive.ts` | the Drive folder protocol: `FsDriveStore`, `GoogleDriveStore`, `sha256` |
| `src/direk/colabTrainer.ts` | `ColabTrainBackend`: write the job, poll status, verify, stage |
| `src/direk/trainBackend.ts` | `createTrainBackend()` picks the backend from `TRAIN_BACKEND` |
| `src/direk/trainer.ts` | `TrainBackend` (the interface) and `LocalTrainBackend` |
| `scripts/colab_lora_train.ipynb` | the Colab half |
