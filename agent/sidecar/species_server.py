"""Local species identification sidecar (BioCLIP 2.5 Huge + OWLv2 bird detector).

GET /health -> {"ok": true, "model": "bioclip-2.5"}
POST /species?region=<name> (JPEG body) -> raw candidates for the Node agent, which decides what to keep:
  {"model", "whole": [[common, scientific, class, score] x3], "boxes": [{"box": [x0,y0,x1,y1] (fractions),
   "det", "kind": "bird", "preds": [[common, scientific, class, score] x3]}]}
Listens on 127.0.0.1 only. The caller sends an already EXIF-rotated image (about 1600 px on the long side).

The candidate species are limited to the region's list (built by `build-species-regions`, files in
SPECIES_REGIONS_DIR): birds, mammals and amphibians GBIF has records for there, plus every reptile.
Whole frame is matched against all of those, each detected bird box against birds only.

Memory: the model runs in fp16 (about 2 GB instead of 3.9 GB). The species text embeddings are computed once
per region with the model's own text encoder and cached next to the region list, so later starts only load them.
"""
import os

# An expired Hugging Face login on the machine makes the hub answer 401 for public repos: go anonymous.
os.environ.setdefault("HF_HUB_DISABLE_IMPLICIT_TOKEN", "1")

import io
import json
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Lock
from urllib.parse import parse_qs, urlparse

import numpy as np
import open_clip
import torch
import torch.nn.functional as F
from huggingface_hub import hf_hub_download
from PIL import Image
from torchvision.ops import nms
from transformers import Owlv2ForObjectDetection, Owlv2Processor

MODEL = "bioclip-2.5"
MODEL_ID = "hf-hub:imageomics/bioclip-2.5-vith14"
# The TreeOfLife taxonomy list ([[kingdom..genus, epithet], common name] per species); only names, no embeddings.
LABELS_REPO, LABELS_FILE = "imageomics/TreeOfLife-200M", "embeddings/txt_emb_species.json"
LAND_CLASSES = ("Aves", "Mammalia", "Amphibia")
# In this taxonomy list the third slot of a reptile is its order, not "Reptilia".
REPTILE_ORDERS = {"Squamata", "Testudines", "Crocodylia", "Rhynchocephalia"}
CACHE_VERSION = 2
MAX_BYTES = 50 * 1024 * 1024
PORT = int(os.environ.get("PIXDEX_SPECIES_SIDECAR_PORT", "8800"))
HERE = os.path.dirname(os.path.abspath(__file__))
REGIONS_DIR = os.environ.get("SPECIES_REGIONS_DIR", os.path.join(HERE, "..", ".index-state", "species-regions"))
DETECTOR = "google/owlv2-base-patch16-ensemble"
THRESH, MAX_BOXES, MIN_AREA, NMS_IOU = 0.15, 5, 0.003, 0.6

device = "mps" if torch.backends.mps.is_available() else "cpu"
dtype = torch.float16
lock = Lock()  # one inference at a time

model, _, preprocess = open_clip.create_model_and_transforms(MODEL_ID)
model = model.to(device).to(dtype).eval()
tokenizer = open_clip.get_tokenizer(MODEL_ID)
logit_scale = float(model.logit_scale.exp())


def load_cached_first(cls):
    """Load from the Hugging Face cache when the weights are already there (works offline), else download."""
    try:
        return cls.from_pretrained(DETECTOR, local_files_only=True)
    except OSError:
        return cls.from_pretrained(DETECTOR)


processor = load_cached_first(Owlv2Processor)
detector = load_cached_first(Owlv2ForObjectDetection).eval()

_labels = None  # [(common, scientific, class, taxonomic text)], parsed once and only if a region cache is missing
_regions = {}  # region -> {"emb": tensor [N, D] fp32 on device, "meta": [...], "bird": index tensor}


def load_labels():
    global _labels
    if _labels is None:
        path = hf_hub_download(LABELS_REPO, LABELS_FILE, repo_type="dataset")
        with open(path, encoding="utf-8") as f:
            raw = json.load(f)
        _labels = []
        for taxa, common in raw:
            if len(taxa) < 7 or not taxa[5] or not taxa[6]:
                continue
            cls = "Reptilia" if taxa[2] in REPTILE_ORDERS else taxa[2]
            if cls not in LAND_CLASSES and cls != "Reptilia":
                continue
            tax_text = " ".join(t for t in taxa if t)
            _labels.append((common, f"{taxa[5]} {taxa[6]}", cls, tax_text))
        del raw
    return _labels


def http_json(url):
    with urllib.request.urlopen(url, timeout=30) as r:
        return json.load(r)


def gbif_synonyms(name):
    """Older names of a GBIF species (the taxonomy list the model knows predates some renames, e.g. Ardea ibis
    was Bubulcus ibis). Only the species name is sent to GBIF. Returns (names, ok)."""
    try:
        match = http_json("https://api.gbif.org/v1/species/match?kingdom=Animalia&name=" + urllib.parse.quote(name))
        key = match.get("acceptedUsageKey") or match.get("usageKey")
        if not key:
            return [], True
        accepted = http_json(f"https://api.gbif.org/v1/species/{key}")
        found = http_json(f"https://api.gbif.org/v1/species/{key}/synonyms?limit=100")
        names = []
        # The accepted name itself matters most: its own record is not in its synonym list.
        for canonical in [accepted.get("canonicalName")] + [r.get("canonicalName") for r in found.get("results", [])]:
            parts = (canonical or "").split()
            if len(parts) >= 2:
                names.append(f"{parts[0]} {parts[1]}")
        return names, True
    except Exception:
        return [], False


def encode_texts(texts):
    out = []
    for i in range(0, len(texts), 128):
        tokens = tokenizer(texts[i:i + 128]).to(device)
        with torch.no_grad():
            out.append(F.normalize(model.encode_text(tokens).float(), dim=-1).cpu())
    return torch.cat(out)


def cache_path(region):
    return os.path.join(REGIONS_DIR, f"{region}.{MODEL}.v{CACHE_VERSION}.npz")


def build_region_data(region):
    """Text embeddings of the region's species, computed with the model's text encoder.
    Returns (embeddings, meta, complete); complete is False when a GBIF lookup failed (then it is not cached)."""
    path = os.path.join(REGIONS_DIR, f"{region}.json")
    try:
        with open(path) as f:
            species = set(json.load(f)["species"])
    except (OSError, ValueError, KeyError):
        raise LookupError(f"no species list for region {region}: run build-species-regions")
    labels = load_labels()
    by_name = {l[1]: l for l in labels if l[2] in LAND_CLASSES}
    missing = sorted(species - by_name.keys())
    with ThreadPoolExecutor(8) as pool:
        looked_up = list(pool.map(gbif_synonyms, missing))
    complete = all(ok for _, ok in looked_up)
    wanted = {n for n in species if n in by_name}
    renamed = 0
    for names, _ in looked_up:
        hits = [n for n in names if n in by_name]
        wanted.update(hits)
        renamed += bool(hits)
    rows = [l for l in labels if l[2] == "Reptilia" or l[1] in wanted]
    print(f"{MODEL} text embeddings for region {region}: {len(species)} listed species, {len(species) - len(missing)} exact, "
          f"{renamed} found under an older name, {len(missing) - renamed} not in the model's taxonomy; "
          f"{len(rows)} candidates incl. reptiles", flush=True)
    # The same text the published BioCLIP 2 species embeddings were closest to: "a photo of <taxonomy> <common name>."
    texts = [f"a photo of {tax} {common}." if common else f"a photo of {tax}." for common, _, _, tax in rows]
    emb = encode_texts(texts).half().numpy()
    meta = [[common or sci, sci, cls] for common, sci, cls, _ in rows]
    return emb, meta, complete


def get_region(region):
    if region in _regions:
        return _regions[region]
    if os.path.exists(cache_path(region)):
        data = np.load(cache_path(region), allow_pickle=False)
        emb, meta = data["emb"], json.loads(str(data["meta"]))
    else:
        emb, meta, complete = build_region_data(region)
        if complete:
            tmp = cache_path(region) + ".tmp.npz"
            np.savez(tmp, emb=emb, meta=np.array(json.dumps(meta)))
            os.replace(tmp, cache_path(region))
        else:
            print(f"region {region}: GBIF was not fully reachable, not caching (it will be rebuilt on the next start)", flush=True)
    bird = torch.tensor([i for i, m in enumerate(meta) if m[2] == "Aves"], dtype=torch.long, device=device)
    _regions[region] = {"emb": torch.from_numpy(emb).float().to(device), "meta": meta, "bird": bird}
    return _regions[region]


def predict(image, region, kind):
    r = get_region(region)
    with torch.no_grad():
        pixels = preprocess(image).unsqueeze(0).to(device).to(dtype)
        feat = F.normalize(model.encode_image(pixels).float(), dim=-1)
        emb = r["emb"] if kind == "whole" else r["emb"][r["bird"]]
        probs = (logit_scale * feat @ emb.T).softmax(dim=-1)[0]
        top = probs.topk(min(3, probs.shape[0]))
    out = []
    for p, i in zip(top.values.tolist(), top.indices.tolist()):
        common, sci, cls = r["meta"][i if kind == "whole" else int(r["bird"][i])]
        out.append([common, sci, cls, round(p, 3)])
    return out


def bird_boxes(image):
    w, h = image.size
    side = max(w, h)  # the detector pads to a square
    inputs = processor(text=[["a bird"]], images=image, return_tensors="pt")
    with torch.no_grad():
        out = detector(**inputs)
    # On the image processor: transformers 5 removed the method from the processor itself.
    res = processor.image_processor.post_process_object_detection(out, threshold=THRESH, target_sizes=torch.tensor([[side, side]]))[0]
    if len(res["scores"]) == 0:
        return []
    boxes = res["boxes"].clone()
    boxes[:, 0::2] = boxes[:, 0::2].clamp(0, w)
    boxes[:, 1::2] = boxes[:, 1::2].clamp(0, h)
    found = []
    for i in nms(boxes, res["scores"], NMS_IOU).tolist()[:MAX_BOXES]:
        x0, y0, x1, y1 = [float(v) for v in boxes[i]]
        if (x1 - x0) * (y1 - y0) / (w * h) < MIN_AREA:
            continue
        found.append(((x0, y0, x1, y1), float(res["scores"][i])))
    return found


def identify(image, region):
    w, h = image.size
    boxes = []
    for (x0, y0, x1, y1), score in bird_boxes(image):
        pad = 0.1 * max(x1 - x0, y1 - y0)
        crop = image.crop((int(max(0, x0 - pad)), int(max(0, y0 - pad)), int(min(w, x1 + pad)), int(min(h, y1 + pad))))
        boxes.append({
            "box": [round(x0 / w, 4), round(y0 / h, 4), round(x1 / w, 4), round(y1 / h, 4)],
            "det": round(score, 2),
            "kind": "bird",
            "preds": predict(crop, region, "bird"),
        })
    return {"model": MODEL, "whole": predict(image, region, "whole"), "boxes": boxes}


class Handler(BaseHTTPRequestHandler):
    def _send(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/health":
            self._send(200, {"ok": True, "model": MODEL})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        url = urlparse(self.path)
        if url.path != "/species":
            return self._send(404, {"error": "not found"})
        region = (parse_qs(url.query).get("region") or [""])[0]
        if not region or not region.replace("-", "").isalnum():
            return self._send(400, {"error": "region is required (letters, digits and dashes)"})
        try:
            length = int(self.headers.get("Content-Length", ""))
        except ValueError:
            length = 0
        if length <= 0:
            return self._send(400, {"error": "missing or invalid Content-Length"})
        if length > MAX_BYTES:
            return self._send(413, {"error": "body too large"})
        raw = self.rfile.read(length)
        try:
            image = Image.open(io.BytesIO(raw)).convert("RGB")
        except Exception:
            return self._send(400, {"error": "invalid image"})
        try:
            with lock:
                result = identify(image, region)
            self._send(200, result)
        except LookupError as e:
            self._send(400, {"error": str(e)})
        except Exception as e:
            self._send(500, {"error": f"identification failed: {e}"})


def warm_up():
    """Build or load every region's embeddings before serving, so the first photo is not a multi-minute request."""
    if not os.path.isdir(REGIONS_DIR):
        return
    for name in sorted(os.listdir(REGIONS_DIR)):
        if name.endswith(".json"):
            get_region(name[: -len(".json")])


if __name__ == "__main__":
    warm_up()
    print(f"pixdex species sidecar ({MODEL}, {device}, fp16) on http://127.0.0.1:{PORT}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
