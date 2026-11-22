# Server-2 — Verified Hardware Specifications

The physical machine where Movie Creator is deployed 24/7.

| Component | Specification |
| --- | --- |
| OS | Windows 11 (Version 10.0.26300) |
| CPU | AMD Ryzen 7 7800X3D (8 Cores, 16 Threads) |
| Base Speed | 4.20 GHz |
| Cache | L1: 512 KB · L2: 8.0 MB · L3: 96.0 MB |
| RAM | 64.0 GB DDR5 (4800 MT/s) |
| GPU | AMD Radeon RX 9070 |
| VRAM | 16.0 GB Dedicated Memory |
| Storage | 500+ GB Free Space on C: Drive |

## Deployment mandate

The Movie Creator App is designed to run on this physical machine. All heavy
video rendering must be offloaded to Server-2's local ComfyUI, never to a
sandbox or a cloud container.

ComfyUI runs inside WSL Ubuntu on this host and listens on
`http://127.0.0.1:8188`. Its three Wan 2.2 TI2V 5B model files must be present
at the exact byte sizes listed in
[`docs/server2-comfy-video-setup.md`](docs/server2-comfy-video-setup.md).

Verify the whole chain on the host before trusting any render:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\server2-check.ps1
```

## Reaching ComfyUI from outside the host

Two cases, and they are not interchangeable:

1. **App runs on Server-2 itself** (the 24/7 case). Set
   `COMFYUI_URL=http://127.0.0.1:8188`. Nothing is exposed to the internet.
   This is the recommended deployment.
2. **App runs on Render** and must reach Server-2. `127.0.0.1` on Render is the
   Render container, not Server-2, so it can never work. The Tailscale address
   (`100.122.147.65`) is also not routable from Render: `100.64.0.0/10` is a
   carrier-grade NAT range with no public route, so Render has no path into the
   tailnet. A public tunnel is the only option, and it must be opened on
   purpose:

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\scripts\tunnel.ps1 -Port 8188 -IAcceptExposure
   ```

   Then paste the printed `https://*.trycloudflare.com` URL into Render's
   `COMFYUI_URL`. ComfyUI has no authentication, so that URL is a public GPU.
   Re-open it with `-IAcceptExposure` only when you accept that exposure, and
   prefer case 1.
