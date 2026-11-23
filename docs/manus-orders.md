# Mga utos para kay Manus

Kopyahin ang buong block sa ibaba papunta kay Manus. Huwag mong palitan ang mga
halaga: ang bawat linya ay galing sa code sa repo na ito, hindi sa haka-haka.

---

## ORDER 01 — Kaggle (brain)

```
You are the hands inside Kaggle. I am the director outside it. Do not redesign
anything; execute this and report facts.

REPO: https://github.com/Rex217-0/MOVIES
NOTEBOOK: scripts/direk_kaggle_gear253b.ipynb

The notebook is already correct and verified against the app. Your job is to run
it and report, not to rewrite it. Pull the latest main before you open it.

STEP 1. Kaggle -> New Notebook -> File -> Import Notebook -> upload
        scripts/direk_kaggle_gear253b.ipynb

STEP 2. Settings -> Accelerator -> GPU T4 x2
        Settings -> Internet -> ON   (the tunnel download needs it)

STEP 3. Cell 2 must print the GPU name. If it prints "WALANG GPU", stop and
        report that exact line. Do not continue.

STEP 4. Cell 3 installs dependencies. It now pins transformers below 5. Expect:
          transformers 4.5x.x | torch <whatever Kaggle ships>
        If you see a RuntimeError naming transformers 5.x, the session had a
        stale wheel: Factory reset the session and Run all again.
        Do not "fix" it by installing transformers latest.

STEP 5. Run all. Then report these four facts, copied verbatim, nothing else:
        a) the line starting "transformers " from cell 3
        b) the line starting "Model loaded" from cell 4
        c) the line starting "Worker UP" from cell 7
        d) the line starting "KAGGLE_PILOT_URL:" from cell 8

STEP 6. Cell 10 runs the smoke test against the public tunnel. It must end with
        "SMOKE TEST PASSED". If it does not, report the last 20 lines of output.

RULES
- Never claim success without pasting the actual output line.
- Never edit the notebook to make an error disappear. Report the error.
- If a cell fails, report: cell number, exception type, full message.
- The URL in step 5d changes every run unless CF_TUNNEL_TOKEN is set as a
  Kaggle secret. That is expected; do not try to make it permanent.
- Do not paste any token, key, or secret into this chat.
```

---

## ORDER 02 — Colab (dataset at LoRA)

```
Kaggle is the brain. Colab is the storage and the LoRA trainer. They do not talk
to each other over HTTP; they meet through Google Drive. Do not invent an HTTP
link between them.

STEP 1. Mount Drive first, in its own cell, before anything else:
          from google.colab import drive
          drive.mount('/content/drive')
        Report the exact mount message.

STEP 2. Report which path already exists:
          /content/drive/MyDrive/direk/dataset/
          /content/drive/MyDrive/direk/output/
        Use `!ls -la` and paste the real listing. If neither exists, say so.

STEP 3. Train only if step 2 shows a dataset. Report:
        a) the dataset file count and total size
        b) the training command you used
        c) the exact path of the .safetensors it produced
        d) whether output/manifest.json was written

STEP 4. Do not attempt to download the LoRA to a Windows path. The app handles
        the copy itself through COMFYUI_LORAS_DIR (src/direk/comfyui.ts:70).
        Your job ends at the file existing in Drive.

RULES
- Paste real command output. Never summarise as "done".
- If Drive is not mounted, nothing else is valid. Report and stop.
```

---

## Paano ka magre-report pabalik

Pagkatapos ng bawat order, ipasok dito ang **hilaw na output**, hindi buod:

```
ORDER: 01 / 02
CELL: <numero>
STATUS: ok | fail
OUTPUT:
<incoll ang aktwal na linya>
```

## Ano ang tinatanggap kong sagot

Ang tanging patunay na gumagana ang Kaggle ay ang linyang ito, galing sa cell 7:

```
Worker UP pagkalipas ng Ns: {'ok': True, 'model': 'Qwen/Qwen2.5-3B-Instruct',
'persona': 'Direk', 'model_ready': True}
```

Kung wala iyon, wala pang koneksyon. Huwag nang mag-claim.

## Ang huling hakbang ay sa akin

Kapag may `KAGGLE_PILOT_URL`, ibigay mo sa akin. Ako ang mag-test mula sa labas
bago mo ilagay sa Render. Hindi ko papayagang i-set mo iyon nang hindi ko pa
nasusubukang tumawag dito.
