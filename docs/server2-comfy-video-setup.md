# ComfyUI video on Server-2 (Wan 2.2 TI2V 5B)

How to put the Wan 2.2 text-to-video workflow on Server-2 (Windows 11 + WSL Ubuntu +
AMD Radeon RX 9070 16 GB, ROCm) and prove a real render.

Video is ComfyUI-only. There is no slideshow, gradient, zoom or filter fallback.
When ComfyUI cannot render, the API answers 503 `AI_UNAVAILABLE` with the exact
cause. The only proof of video is a job record from Server-2 ComfyUI whose
`backend` is `comfyui`.

The sandbox ComfyUI (CPU, no GPU, no models) is **not** proof of video. It only
checks that the workflow graph is structurally valid.

## Model choice: Wan 2.2 TI2V 5B (fits 16 GB)

Wan 2.2 TI2V **5B** at fp16 is ~10 GB and needs a 16 GB card for a short clip at
704x480; it fits the RX 9070 with room for the 6.7 GB text encoder held on CPU.
The 14B variants do not fit 16 GB without heavy offload. LTX-Video 2B was the
fallback if 5B did not fit; it was not needed.

The workflow `workflows/video_api.json` is the official ComfyUI template
`video_wan2_2_5B_ti2v`, exported to API format, with placeholders filled by the
app: `__PROMPT__`, `__NEGATIVE__`, `__SEED__`, `__WIDTH__`, `__HEIGHT__`,
`__FRAMES__`. `__CHECKPOINT__` is supported by the builder but this graph uses
`UNETLoader`, not a checkpoint loader, so it is not used.

Nodes (all core, no custom node): `UNETLoader`, `CLIPLoader`, `VAELoader`,
`CLIPTextEncode` (x2), `ModelSamplingSD3`, `Wan22ImageToVideoLatent`, `KSampler`,
`VAEDecode`, `CreateVideo`, `SaveVideo`.

## 1. Model files and exact sizes

Download these three. A file that is a few KB is a bad link or a truncated
download, not a model.

| File | Folder | Exact bytes |
| --- | --- | --- |
| `wan2.2_ti2v_5B_fp16.safetensors` | `models/diffusion_models/` | `9999658848` |
| `umt5_xxl_fp8_e4m3fn_scaled.safetensors` | `models/text_encoders/` | `6735906897` |
| `wan2.2_vae.safetensors` | `models/vae/` | `1409400960` |

Source: [Comfy-Org/Wan_2.2_ComfyUI_Repackaged](https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged)
and [Comfy-Org/Wan_2.1_ComfyUI_repackaged](https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged)
(the text encoder). Tutorial: <https://docs.comfy.org/tutorials/video/wan/wan2_2>.

Assuming ComfyUI is at `~/isa_movie/ComfyUI` in WSL:

```powershell
# 1. Diffusion model (~10 GB)
wsl bash -c "curl -L -o ~/isa_movie/ComfyUI/models/diffusion_models/wan2.2_ti2v_5B_fp16.safetensors https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/diffusion_models/wan2.2_ti2v_5B_fp16.safetensors"
wsl bash -c "stat -c '%s %n' ~/isa_movie/ComfyUI/models/diffusion_models/wan2.2_ti2v_5B_fp16.safetensors"

# 2. Text encoder (~6.7 GB)
wsl bash -c "curl -L -o ~/isa_movie/ComfyUI/models/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors"
wsl bash -c "stat -c '%s %n' ~/isa_movie/ComfyUI/models/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors"

# 3. VAE (~1.4 GB)
wsl bash -c "curl -L -o ~/isa_movie/ComfyUI/models/vae/wan2.2_vae.safetensors https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/vae/wan2.2_vae.safetensors"
wsl bash -c "stat -c '%s %n' ~/isa_movie/ComfyUI/models/vae/wan2.2_vae.safetensors"
```

A download is not finished until the reported size equals the exact bytes above.
To resume a broken download, add `-C -` to the same `curl` command.

## 2. App environment (.env on Server-2)

```env
COMFYUI_URL=http://127.0.0.1:8188
COMFYUI_VIDEO_WORKFLOW=C:\movie\wan22_video_api.json
# COMFYUI_TIMEOUT_MS=600000
```

Do not set `COMFYUI_DISABLE`. Copy `workflows/video_api.json` from the repo to the
path in `COMFYUI_VIDEO_WORKFLOW`.

## 3. Check the whole chain

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\server2-check.ps1
```

It writes `docs/evidence/server2-check.txt` and exits non-zero if any check fails.

## 4. Proof sequence (stop at the first failure)

1. `GET {COMFYUI_URL}/system_stats` -> HTTP 200, `devices[0].type` is `cuda`.
2. `GET {COMFYUI_URL}/object_info/UNETLoader` (and `CLIPLoader`, `VAELoader`) ->
   the three model names appear.
3. `POST {COMFYUI_URL}/prompt` with the filled workflow -> `prompt_id`.
4. `GET {COMFYUI_URL}/history/<prompt_id>` -> `outputs` carries a video
   (`gifs` or `videos`).
5. `GET {APP_URL}/api/direk/video/backend` -> `ready: true`, `engine: "comfyui"`.
6. `POST {APP_URL}/api/pilot/video/generate` -> `item.backend == "comfyui"`.

## 5. Job record to return

Media record (`POST /api/pilot/video/generate`):

```json
{ "status": "success",
  "item": { "id": "VID-...", "type": "video", "url": "data:video/mp4;base64,...",
            "model": "comfyui", "backend": "comfyui", "details": "comfyui render" } }
```

Movie job (`GET /api/direk/jobs`):

```json
{ "id": "FILM-<uuid>", "status": "done", "percent": 100, "backend": "comfyui",
  "asset": { "name": "...mp4", "bytes": 123456, "kind": "video" } }
```

Scene job (`GET /api/direk/feature/scenes`):

```json
{ "id": "FILM-<uuid>-S01", "scene_number": 1, "status": "rendered",
  "video_path": "...mp4", "backend": "comfyui" }
```

## 6. Release gate

Do not cut an APK release until a Server-2 job record with `backend: "comfyui"`
and a moving video is in hand. If Server-2 is unreachable the API returns 503
`AI_UNAVAILABLE` with the exact cause; there is no fallback.
