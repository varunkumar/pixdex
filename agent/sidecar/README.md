# Face sidecar

Local HTTP service that detects faces and computes embeddings with InsightFace
(`buffalo_l`). The Node agent calls it during indexing. It uses only the Python
standard library `http.server` (no web framework).

## Setup

Needs Python 3.11 or 3.12 with pip (the pinned `insightface` builds a small C extension, so
the Xcode command line tools must be installed). No virtualenv: from the repo root,

```sh
pip install -r agent/sidecar/requirements.txt
```

This installs into that Python, so use one you are happy to add `numpy`, `onnxruntime`,
`opencv-python-headless` and `insightface` to.

The first run downloads the `buffalo_l` weights to `~/.insightface/models/`.

## Run

```sh
python3 agent/sidecar/server.py
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

# Species sidecar

A second local HTTP service, `species_server.py`, identifies the species in a photo with
[BioCLIP 2.5 Huge](https://huggingface.co/imageomics/bioclip-2.5-vith14) (whole frame) and an OWLv2 bird
detector (each bird, so a second bird or a myna on a deer is found). The Node agent calls it during indexing and
from `backfill-species`. Like the face sidecar it uses only the standard library `http.server`, listens on
`127.0.0.1` only and runs one inference at a time. It is separate so its heavy dependencies (torch) never
clash with the face sidecar's.

It is built to share the machine with Ollama and the face sidecar: the model runs in fp16 (about 2 GB of weights,
about 3 GB resident in total; the official weights are 3.9 GB fp32 and there is no official quantised build).

## Setup

Python 3.11 or 3.12, no virtualenv (this installs into that Python and may upgrade its `torch`):

```sh
pip install -r agent/sidecar/requirements-species.txt
cd agent && npm run dev -- build-species-regions   # species lists per region, from GBIF (only region names are sent)
```

The first run downloads the BioCLIP 2.5 weights (3.9 GB) and the OWLv2 weights to the Hugging Face cache (later runs
work offline), then builds each region's species text embeddings once (a few minutes: the model's text encoder
runs over the region's species and every reptile) and caches them next to the region list as
`<region>.bioclip-2.5.v2.npz`. The build also asks GBIF for older names of species the model's taxonomy lists
under a former name (for example `Ardea ibis`, found as `Bubulcus ibis`); only species names are sent. If GBIF
is unreachable the embeddings are used for that run but not cached. Embeddings for every `*.json` region are
built or loaded before the server starts listening, so the first photo is not a multi-minute request.

An expired Hugging Face login on the machine makes the hub answer 401 for public repos; the sidecar goes
anonymous (`HF_HUB_DISABLE_IMPLICIT_TOKEN`). Regions are defined in `agent/species/regions.json` (`IN` and
`IN-KA` to start; each photo's region comes from its EXIF position or its album name, else the default). Without a
list for a photo's region the sidecar answers 400 and tells you to build it.

## Run

```sh
python3 agent/sidecar/species_server.py
```

Port from `PIXDEX_SPECIES_SIDECAR_PORT` (default `8800`); lists from `SPECIES_REGIONS_DIR` (default
`agent/.index-state/species-regions`). Then set `SPECIES_SIDECAR_URL=http://127.0.0.1:8800` in `agent/.env`.
About 3 seconds per photo on this Mac.

## Endpoints

- `GET /health` returns `{"ok": true, "model": "bioclip-2.5"}`. The model name is stored on each photo, so
  photos scanned with another model are scanned again by `backfill-species`.
- `POST /species?region=<name>` with a JPEG body (already EXIF-rotated, about 1600 px) returns
  `{"model", "whole": [[common, scientific, class, score] x3], "boxes": [{"box": [x0, y0, x1, y1], "det", "kind": "bird", "preds": [...]}]}`.
  Raw candidates only: the agent's `decideSpecies` (`agent/src/species/decide.ts`) chooses what to keep. Its 0.5
  thresholds were tuned on BioCLIP 2 scores, not re-tuned for 2.5.

## Licence

BioCLIP 2.5 is MIT; OWLv2 has its own licence. Check both before any use beyond personal.
