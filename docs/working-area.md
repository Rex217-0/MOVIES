# Working area — saan tatakbo ang MOVIE CREATOR

Sino ang gumagawa ng ano, saang makina, at anong port. Lahat ng nasa ibaba ay
galing sa code sa `main` at sa mga published package index — may source sa bawat
claim. Walang hula.

## 1. Tatlong makina, tatlong trabaho

| Makina | Specs | Trabaho | Estado |
|---|---|---|---|
| **Render** (Singapore, free) | 0.1 CPU / 512 MB, ephemeral disk | Coordinator. 69 routes, auth, UI, job queue. **Hindi nagre-render.** | ✅ Live |
| **Server-2** (iyong PC) | RX 9070 16 GB, Ryzen 7 7800X3D, 64 GB DDR5, Win 11 | GPU worker. ComfyUI, Wan 2.2, Ollama, ffmpeg. | ⚠️ Wala pang ComfyUI code path na naka-wire |
| **Kaggle / Colab** | Libreng T4 | LoRA training, batch render | ⚠️ `preferred: none` |

Ang Render ay **coordinator lang**. Ang `docs/worker-mesh.md` ay may registry at
placement logic na verified end-to-end. Pero **wala pang worker na naka-register.**

## 2. Server-2 — working area ng ComfyUI

### 2.1 Env vars na aktwal na binabasa ng code

Mula sa `src/direk/comfyui.ts` (header comment, lines 1–22) at `src/direk/llm.ts`:

| Variable | Default | Para saan |
|---|---|---|
| `COMFYUI_URL` | `http://127.0.0.1:8188` | ComfyUI base URL (`comfyui.ts:97`) |
| `COMFYUI_CHECKPOINT` | `sd_xl_base_1.0.safetensors` | Image model (`comfyui.ts:164`) |
| `COMFYUI_VIDEO_CHECKPOINT` | — | Video model |
| `COMFYUI_WORKFLOW` | — | Custom workflow JSON (API format) |
| `COMFYUI_VIDEO_WORKFLOW` | — | Custom video workflow |
| `COMFYUI_TIMEOUT_MS` | `180000` | Per-image timeout |
| `COMFYUI_LORAS_DIR` | `./comfy_loras` | Kung saan ipinapasa ang trained LoRA |
| `COMFYUI_DISABLE` | — | `1` = huwag gamitin |
| `COMFYUI_SKIP_QUALITY` | — | Laktawan ang quality check |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | Ollama (`llm.ts:26`) |
| `OLLAMA_MODEL` | `qwen2.5:7b` | Text model (`llm.ts:30`) |
| `LOCAL_OLLAMA_URL` | — | Alias ng `OLLAMA_URL` |
| `OLLAMA_DISABLE` | — | `1` = huwag gamitin |
| `DIREK_ASSETS_DIR` | `cwd/assets` | Kung saan nagsusulat ng MP4 (`assets.ts:35`) |

**Ports:** ComfyUI **8188**, Ollama **11434**, ang app mismo **3000** (`PORT`).

### 2.2 ⚠️ `qwen2.5:3b` — kailangang i-set, hindi default

Sabi mo "si direk qwen 2.5 3b." **Totoo iyon, pero kailangang i-set:**

```bat
set OLLAMA_MODEL=qwen2.5:3b
ollama pull qwen2.5:3b
```

Ang default ay `qwen2.5:7b`. Kung hindi mo i-set, hahanapin ng app ang 7B.

May **tunay na test** para dito (`src/direk/llm.test.ts:148`), at ang comment sa
line 149 ay nagsasabi mismo: *"Boss Rex has only qwen2.5:3b pulled. The app
default asks for qwen2.5:7b."* Ang `qwen2.5:3b` at `qwen2.5:7b` ay **hindi**
magkatulad — sinasadya, para hindi magsinungaling ang status kapag 3B lang ang
naka-pull. Kaya alam na ng code ang setup mo; kailangan lang i-set ang env var.

### 2.3 ✅ Kaya ba ng RX 9070 ang ComfyUI sa Windows 11?

**Oo — verified, hindi hula:**

1. ComfyUI `README.md` line 93: *"for NVIDIA, **AMD ROCm on Linux and Windows**..."*
2. ComfyUI `docs/installation.md` line 110: may seksyong **"AMD GPUs (Windows, ROCm 10.0)"**
3. Line 125 ng parehong doc: **RX 9070 → `device-gfx1201`**, RDNA 4
4. ComfyUI `model_management.py` lines 535/538: may `gfx1200`/`gfx1201` handling
   (FP8 ops at PyTorch attention sa ROCm ≥ 7.0)
5. Ang Windows wheel ay **talagang umiiral**. Sinubukan ko:

```
pip download --platform win_amd64 --python-version 3.13 \
  --index-url https://stable.repo.amd.com/rocm/whl-next/ amd-torch-device-gfx1201
→ amd_torch_device_gfx1201-2.15.0+rocm10.2.0-cp313-cp313-win_amd64.whl (50.7 MB)
```

**Requirements:** Windows 11, current AMD driver, **64-bit Python 3.13**,
at `pip install --index-url https://stable.repo.amd.com/rocm/whl-next/ "torch[device-gfx1201]==2.13.0+rocm10.0.0" ...`
Hindi kailangan ng hiwalay na HIP SDK.

### 2.4 ⚠️ 16 GB at Wan 2.2 — sapat, pero may kondisyon

| File | Laki |
|---|---|
| `wan2.2_ti2v_5B_fp16.safetensors` | **9,536 MB** |
| `umt5_xxl_fp8_e4m3fn_scaled.safetensors` | 6,423 MB |
| `wan2.2_vae.safetensors` | 1,344 MB |

**Ang totoong sinasabi ng Wan 2.2 README (line 234):**

> "This command can run on a GPU with at least **24GB VRAM** (e.g, RTX 4090)."

**Iyon ay para sa 1280×704 sa official repo na may `--offload_model True --t5_cpu`.**

**Pero line 26:**
> "...can also run on **consumer-grade graphics cards like 4090**."

**Kaya tama ka — kaya ng 16 GB**, pero:
- Ang **9.5 GB na fp16 model** ay kasya sa 16 GB
- Ang **6.4 GB na text encoder** ay kailangang i-CPU offload (`--t5_cpu` equivalent)
- Sa ComfyUI, awtomatikong nag-o-offload kapag kulang ang VRAM, **pero mabagal**
- Ang 720p ay **24 fps**, at ang 5B ay **TI2V** (text+image to video)

**Hindi ko masasabi kung ilang segundo per frame sa RX 9070** — wala pang
benchmark na nailathala para sa gfx1201 sa Wan 2.2. **Hindi ako mag-iimbento
ng numero.** Susukatin natin iyon sa unang run.

## 3. Ano ang KULANG — tapat na listahan

Mula sa `docs/AUDIT.md` (commit `0893fe0`), na-measure hindi hinula:

1. **`preferred: "none"`** — walang AI engine. Kaya `Pollinations 402` at
   **gradient** ang visual. `assets/` = 22 mp4, 130 json, **zero image**.
2. **Walang job persistence** — restart → `jobs: 0`. Sa Render free (15-min
   spin-down, ephemeral disk), **nawawala ang MP4**.
3. **Walang R2/S3 code** — `grep R2_|@aws-sdk|s3` = **zero**. Kahit naka-set up
   ang bucket, walang gumagamit.

**Ang #3 ang pinakamalaking butas** — at iyon ang inaasahan mong tapos na.

## 4. Ang tamang pagkakasunod-sunod

**Hakbang 1 — patayin ang gradient (Server-2).** ComfyUI sa 8188 gamit ang
`device-gfx1201` torch, tapos `COMFYUI_URL=http://127.0.0.1:8188`. Kapag naka-wire
ito, tunay nang eksena ang laman ng MP4 — hindi gradient.

**Hakbang 2 — R2.** Para hindi mawala ang MP4 sa restart.

**Hakbang 3 — worker registration.** Para makita ng Render coordinator ang
Server-2 sa `worker-mesh`.

Ang Hakbang 1 ang pinakamabilis na makikita ang epekto: **berde ang Comfy
node sa system map, at may tunay na eksena ang video.**

## 5. Bakit mahalaga ito

Ang 16 GB VRAM + 8-core X3D + 64 GB RAM ay **seryosong makina** para sa 5B
video model. Ang Render free tier ay 512 MB — **hindi kayang mag-render**. Kaya
ang split ay tama: Render = utak/koordinator, Server-2 = kamay/manggagawa.

Ang problema ngayon ay **hindi hardware.** Malakas ang Server-2. Ang kulang ay
**ang code path na mag-uugnay** sa dalawa.
