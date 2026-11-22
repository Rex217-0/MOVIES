# Audit ng MOVIE CREATOR — 2026-11-22

Lahat ng numero dito ay galing sa aktwal na pagtakbo sa container na ito, hindi sa haka-haka.
Commit: `d387d86`. Node v24.22.2, npm 12.2.2, Python 3.13.15.

## 1. Build at kalidad

| Check | Utos | Resulta |
|---|---|---|
| Typecheck | `npm run lint` (`tsc --noEmit`) | **PASS** (exit 0, walang error) |
| Build | `npm run build` (`vite build`) | **PASS** — 1677 modules, 376 kB JS / 105 kB gzip |
| Tests | `npm test` | **PASS — 402/402**, 0 fail, 53.6s |

## 2. Totoong serbisyo (local, PORT=3312)

| Endpoint | Code | Sukat | Content-Type |
|---|---|---|---|
| `/healthz` | 200 | 25 B | `application/json` |
| `/api/direk/status` | 200 | 2217 B | json |
| `/api/direk/system-map` | 200 | 5452 B | json |
| `/api/direk/feature/pilot` | 200 | 355 B | json |
| `/android` | 200 | 1316 B | text/html |
| `/` | 200 | 1903 B | text/html |

**Bilang ng routes sa `server.ts`: 69.**

## 3. End-to-end: may tunay na MP4 ba?

Nag-post ng trabaho, hinintay, at sinuri ang file gamit ang MP4 box parser (walang ffprobe sa container):

```
POST /api/direk/movie  {"brief":"isang bata na naglalakad sa ulan","minutes":1}
 -> 202 {"status":"accepted","job":"MOV-1795358104704"}
 -> Shots 52% -> Credits 86% -> Tapos 100% done
```

Output: `assets/2026-11-22T14-36-06-837Z_isang-maikling-pelikula.mp4`

- `ftypisom`, 3,041,008 bytes
- `moov` > `mvhd`: **duration 60.00 s** (timescale 1000)
- 2 `trak`: video **avc1** (H.264) + audio **mp4a** (AAC)
- `mdat` 2,974,561 bytes

**Konklusyon: totoo ang MP4.** 60 segundo, H.264 + AAC. Hindi placeholder.

## 4. Ang hindi maganda — tapat na listahan

### 4.1 Walang AI engine sa ngayon
`GET /api/direk/feature/pilot`:
```json
{"configured": false, "reachable": false, "url": "",
 "local": {"url":"http://127.0.0.1:11434","model":"qwen2.5:7b","reachable":false},
 "preferred": "none"}
```
`preferred: "none"` — walang Kaggle, walang Ollama. Kaya gumagana ang pipeline sa
**fallback**: walang stock footage, `Pollinations 402`, gradient background.

Ebidensya mula sa log:
```
[MOVIE] Walang stock footage (Wikimedia Commons: walang tugmang video ...)
[MOVIE] Walang image backend (Pollinations returned 402) — gradient na lang
```
Katugma: `assets/` ay may **22 mp4 at 130 json, ZERO na image.** Ang video ay
totoo, pero ang *nilalaman* ay gradient + text, hindi generated na eksena.

### 4.2 Nawawala ang trabaho kapag nag-restart
Despues ng restart: `jobs: 0`. **Walang persistence** — walang `writeFile`/`readFile`
para sa jobs. Nasa memory lang.

Sa Render free: nag-spin down pagkatapos ng 15 min idle, at ephemeral ang disk.
Kaya sa production, **nawawala ang job at ang MP4** kapag nag-restart o nag-redeploy.

### 4.3 Walang R2 / S3 / object storage
Grep sa buong `src/`, `server.ts`, `package.json`: **zero** na `R2_`, `r2.`, `@aws-sdk`,
`s3`. Ang `assets.ts` ay nagsusulat sa local disk lamang
(`DIREK_ASSETS_DIR` o `cwd/assets`). Walang storage SDK sa dependencies.

**Ibig sabihin: kahit anong gawin sa Cloudflare R2 dashboard, walang code na
gagamit nito.** Kailangan pa ng integration code bago magamit ang R2.

### 4.4 Ang system map ay nagpapakita ng "active" na hindi koneksyon
`src/direk/systemMap.ts`:
- Kaggle → `probe('https://www.kaggle.com/')` — ang **public home page**, hindi ang worker
- Colab → `probe('https://colab.research.google.com/')`
- GitHub → `probe('https://api.github.com/')`
- Manus → `probe('https://manus.im/')`

Kaya "active" ang Kaggle/Colab/GitHub/Manus sa mapa **kahit walang naka-configure na
token o worker** — sapat na na bukas ang public website. Ito ay "naabot ang provider,"
hindi "konektado tayo." May comment na ito sa code, pero madaling misread ang berde.

### 4.5 Dependencies
`npm audit --omit=dev`: **12 vulnerabilities (8 moderate, 4 high)**.
Ang 4 high ay **isang kadena lang**: `@grpc/grpc-js` → `@firebase/firestore` →
`firebase`. Fix ay `npm audit fix --force` (breaking, firebase major bump).

Outdated majors (hindi pa bug): express 4→5, firebase 12→13, firebase-admin 12→14,
dotenv 17→18, lucide-react 0.546→1.77.

## 5. Live deployment

`https://movies-627p.onrender.com`:
- `/healthz` → **200** (25 B)
- `/android` → **200** (1230 B)
- `/api/direk/feature/pilot` → **401** — tama, may auth. Kailangan ng bearer token.

## 6. Buod

**Totoo ang build at totoo ang MP4.** 402 tests pass, malinis ang typecheck,
nagre-render ng 60s H.264+AAC.

**Pero:** walang AI engine na naka-wire (`preferred: none`), kaya gradient ang
visual. Walang job persistence, kaya nawawala ang trabaho sa restart. Walang
R2/S3 code, kaya hindi magagamit ang R2 kahit naka-set up ang bucket.

Ang tatlong ito ang totoong kulang bago maging "ganap na app."
