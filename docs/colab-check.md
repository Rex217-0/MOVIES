# Pagsusuri ng Colab notebook mo — laban sa tunay na inaasahan ng app

Sinuri ko ang notebook JSON na ipinadala mo, laban sa code sa `main`.
Bawat punto ay may ebidensya mula sa **output na nakalakip** o sa **linya ng code**.

**Buod: gumagana ang GPU at totoo ang download. Pero hindi ito makakapag-train,
at kung makapag-train man, hindi magagamit ng app ang resulta.**

---

## ✅ Ano ang TAMA — totoo, nakita ko sa output

| Bagay | Ebidensya |
|---|---|
| T4 GPU, 15 GB | `Tesla T4`, `15360MiB`, driver 580.82.07, CUDA 13.0 |
| sd-scripts naka-install | `Building editable for library ... done` |
| SD 1.5 base model, tunay | `Size: 3.97 GB (4,265,146,304 bytes)` |
| Drive naka-mount | `Mounted at /content/drive` |
| Training args tama | `fp16` (tama sa T4), `AdamW8bit`, `gradient_checkpointing`, `sdpa` |

Tama ang `fp16` — **hindi** `bf16`, dahil walang bf16 ang T4. Maganda iyon.

---

## ❌ PROBLEMA 1 — Walang larawan. Hindi makakapag-train.

Tatlong cell ang sinubukan (28, 29, 30), kasama ang **dalawang beses na re-mount**:

```
📁 Folder: 10_my_concept/
   📸 Images Found: 0
   ⚠️ Babala: Walang nakitang larawan sa folder na ito!
```

Katapusan ng cell 30, pagkatapos ng `flush_and_unmount()` + `mount()`:
```
📁 Subfolder: 10_my_concept/
   📸 Images detected: 0
```

**Hindi ito Drive cache bug.** Walang laman talaga ang folder. Nasa **iyong Drive**
ang problema, hindi sa notebook. Kailangang i-upload ang mga larawan.

---

## ❌ PROBLEMA 2 — `base_model.safetensors.zip` ay HINDI modelo

Ito ang pinakamalaking pagkalito sa notebook. Tingnan ang tunay na laman:

```
base_model (1).safetensors.zip → ['marvel.csv', 'marvel_clean.csv', 'marvel_reviews.csv']
base_model (2).safetensors.zip → ['BollywoodActorRanking.csv', 'BollywoodDirectorRanking.csv', ...]
base_model (3).safetensors.zip → ['imdb_movie_dataset.csv']
base_model (4).safetensors.zip → ['imdb_movie_dataset.csv']
base_model (5).safetensors.zip → ['imdb_movie_dataset.csv']
base_model.safetensors.zip     → 0.17 MB
```

**Mga CSV dataset iyon, pinangalanang "base_model.safetensors.zip".**
May nag-rename ng CSV files para magmukhang modelo. Laki pa lang: **0.17 MB**
laban sa tunay na **3.97 GB**.

**Mabuti at hindi ito ang ginamit.** Ang cell 24 ang tunay na nag-download
ng SD 1.5 mula HuggingFace. Iyon ang tama.

⚠️ **Pero may panganib:** ang cell 18 (`42784ff7`) ay nag-eextract ng
`base_model.safetensors.zip` papasok sa `models/`. Tandaan: **4 files** ang laman
ng unang zip pero **3 lang** ang nakita (`file_list[:3]`). **Hindi natin alam
ang pangalan ng ika-4.** Kung `base_model.safetensors` iyon, mako-overwrite nito
ang tunay na modelo — pero **0.17 MB lang** ang buong zip, kaya imposibleng
tunay na modelo iyon.

Sa order ng notebook mo, **nauna** ang cell 18 (execution 18) kaysa download
(execution 24), kaya ligtas ka **ngayon**. Pero delikado ang setup: isang
pagkakamali sa order at mapapalitan ang 3.97 GB na modelo ng basura.

**Payo: i-delete ang 5 maling zip na iyon.**

---

## ❌ PROBLEMA 3 — MALING BASE MODEL. Ito ang pinakamahalaga.

| Saan | Base model |
|---|---|
| **Notebook mo** (cell 24) | **SD 1.5** — `v1-5-pruned-emaonly.safetensors`, 3.97 GB |
| **App: ComfyUI** (`comfyui.ts:164`) | **SDXL** — `sd_xl_base_1.0.safetensors` |
| **App: Colab trainer** (`colabTrainer.ts:345`) | **SDXL** — `stabilityai/stable-diffusion-xl-base-1.0` |

**Ang LoRA ng SD 1.5 ay HINDI magagamit sa SDXL.** Magkaibang arkitektura:
768 vs 2048 na cross-attention dim, magkaibang UNet blocks.

**Kahit maging perpekto ang training mo, itatapon ito ng ComfyUI** — o mas malala,
magre-render ng basura. Ito ang dahilan kung bakit mahalaga ang pag-check na ito.

**Dalawang solusyon:**
- **A** — i-set ang `KOHYA_BASE_MODEL=runwayml/stable-diffusion-v1-5` at
  `COMFYUI_CHECKPOINT=v1-5-pruned-emaonly.safetensors` (panatilihin ang SD 1.5)
- **B** — mag-train sa SDXL (baguhin ang cell 24 pahingi ng
  `stabilityai/stable-diffusion-xl-base-1.0`), para tumugma sa default ng app

**Rekomendasyon ko: B.** SDXL ang default ng app, at mas maganda ang kalidad
para sa pelikula. Pero mas malaki ang SDXL (~6.9 GB) at mas mabigat sa T4.

---

## ❌ PROBLEMA 4 — Hindi magkausap ang notebook at ang app

Inaasahan ng app ang **structured na folder** (`colabTrainer.ts:149-154`):

```
LORA_TRAINING/jobs/<job_id>/
  job.json       ← app ang nagsusulat (config + dataset path)
  dataset/       ← app ang nagsusulat (images + captions)
  status.json    ← NOTEBOOK ang nagsusulat (state, epoch, progress)
  cancel.flag    ← app ang nagsusulat (para huminto)
  output/        ← notebook ang nagsusulat ng .safetensors
  manifest.json  ← notebook ang nagsusulat (name, size, sha256)
```

Ang notebook mo ay gumagamit ng **flat na folder**, at **wala kahit isang**
`status.json` / `manifest.json` / `job.json`:

```
LORA_TRAINING/
  datasets/   models/   output/
```

**Resulta:** mag-po-poll ang app ng `status.json`, at ayon sa `colabTrainer.ts:182`
— *"A missing file reads as QUEUED"*. Kaya **QUEUED habang-buhay**, kahit
tapos na ang training. At walang `manifest.json` = **walang sha256** =
hindi ma-verify ng app ang download (`colabTrainer.ts:13`).

---

## ❌ PROBLEMA 5 — Maling pangalan ng secret

| Notebook mo | Inaasahan ng repo |
|---|---|
| `GH_TOKEN` | **`GITHUB_TOKEN`** |
| — | `HF_TOKEN` |
| — | `SD_SCRIPTS_REPO` (opsyonal) |

May **tamang notebook na sa repo**: **`scripts/colab_lora_train.ipynb`** (12 cells).
Iyon ang gumagamit ng `GITHUB_TOKEN`, `HF_TOKEN`, at nagsusulat ng
`status.json` + `manifest.json` na may sha256.

**Iyon ang dapat mong gamitin — hindi ang notebook na ipinadala mo.**

---

## ⚠️ BABALA SA SEGURIDAD — may live token ka sa output

```
haba: 93 | simula: github_pat_
```

`github_pat_` = **fine-grained personal access token**, 93 characters.
Hindi lumabas ang buong value (mabuti), pero kumpirmado na **may live token**
sa Colab Secrets mo.

**Payo:**
1. Huwag kailanman i-print ang token, kahit ang haba. I-delete ang cell 2.
2. Kung na-share mo ang notebook na may output, **i-revoke** ang token sa
   GitHub → Settings → Developer settings → Fine-grained tokens.
3. Ang token ay dapat **read-only** sa isang repo lang, hindi `all repos`.

---

## ✅ Ang tamang hakbang

**1. Gamitin ang tamang notebook.**
`scripts/colab_lora_train.ipynb` — may `status.json`, `manifest.json`, sha256,
at tamang pangalan ng secret.

**2. Mag-upload ng larawan.** Walang training na mangyayari sa 0 images.
Kailangan ng **15–30 larawan** bawat konsepto. Ang folder ay dapat
`LORA_TRAINING/jobs/<job_id>/dataset/` — **hindi** `datasets/10_my_concept/`.

**3. I-delete ang 5 maling `base_model*.zip`** (CSV iyon, hindi modelo).

**4. Pumili ng base model at gawing pareho sa app.** Kung SDXL ang app,
SDXL ang i-train. Kung SD 1.5, i-set ang `KOHYA_BASE_MODEL` **at**
`COMFYUI_CHECKPOINT` nang magkatugma.

**5. I-set ang `GITHUB_TOKEN`**, hindi `GH_TOKEN`. Read-only, isang repo lang.

---

## Ang totoong estado, sa isang pangungusap

**Gumagana ang T4 at totoo ang 3.97 GB na SD 1.5 download, pero walang
training data, mali ang base model para sa app, at walang `status.json`/
`manifest.json` — kaya kahit makatapos ito, hindi ito makikita o magagamit
ng MOVIE CREATOR.**

Ang kulang ay hindi hardware. **Ang kulang ay pagkakasundo sa protocol at
sa base model.**
