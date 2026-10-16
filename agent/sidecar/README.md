# Face sidecar

Local HTTP service that detects faces and computes embeddings with InsightFace
(`buffalo_l`). The Node agent calls it during indexing. It uses only the Python
standard library `http.server` (no web framework).

## Setup

Requires [uv](https://docs.astral.sh/uv/). From the repo root:

```sh
uv venv --python 3.12 agent/sidecar/.venv
uv pip install -p agent/sidecar/.venv/bin/python -r agent/sidecar/requirements.txt
```

The first run downloads the `buffalo_l` weights to `~/.insightface/models/`.

## Run

```sh
agent/sidecar/.venv/bin/python agent/sidecar/server.py
```

Listens on `127.0.0.1` only (never exposed on the network). Port comes from
`PIXDEX_SIDECAR_PORT` (default `8799`). CoreML is used when available, with a
CPU fallback.

## Endpoints

- `GET /health` returns `{"ok": true, "model": "buffalo_l"}`.
- `POST /faces` with a JPEG as the raw body returns
  `{"model", "width", "height", "faces": [{"bbox": [x1, y1, x2, y2], "detScore", "embedding"}]}`.
  `bbox` is in pixels of the image received; `width`/`height` are that image's
  size. `embedding` is base64 of 512 little-endian float32 values,
  L2-normalised (2732 characters). An undecodable body returns 400.

EXIF orientation is not applied: send an already rotated image. Downscaling
large originals (for example to 1280px on the long side) before posting is
faster.

Quick check:

```sh
curl -s localhost:8799/health
curl -s --data-binary @photo.jpg localhost:8799/faces \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d['faces']), len(d['faces'][0]['embedding']))"
```

## Licence

The InsightFace pretrained weights are licensed for non-commercial research
use only. This sidecar is for personal use only.
