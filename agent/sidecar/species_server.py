"""Local species identification sidecar (BioCLIP 2 + OWLv2 bird detector).

GET /health -> {"ok": true, "model": "bioclip-2"}
POST /species?region=<name> (JPEG body) -> raw candidates for the Node agent, which decides what to keep:
  {"model", "whole": [[common, scientific, class, score] x3], "boxes": [{"box": [x0,y0,x1,y1] (fractions),
   "det", "kind": "bird", "preds": [[common, scientific, class, score] x3]}]}
Listens on 127.0.0.1 only. The caller sends an already EXIF-rotated image (about 1600 px on the long side).

The candidate species are limited to the region's list (built by `build-species-regions`, files in
SPECIES_REGIONS_DIR): birds, mammals and amphibians GBIF has records for there, plus every reptile.
Whole frame is matched against all of those, each detected bird box against birds only.
"""
import io
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Lock
from urllib.parse import parse_qs, urlparse

import torch
from bioclip import Rank, TreeOfLifeClassifier
from PIL import Image
from torchvision.ops import nms
from transformers import Owlv2ForObjectDetection, Owlv2Processor

MODEL = "bioclip-2"
MAX_BYTES = 50 * 1024 * 1024
PORT = int(os.environ.get("PIXDEX_SPECIES_SIDECAR_PORT", "8800"))
HERE = os.path.dirname(os.path.abspath(__file__))
REGIONS_DIR = os.environ.get("SPECIES_REGIONS_DIR", os.path.join(HERE, "..", ".index-state", "species-regions"))
DETECTOR = "google/owlv2-base-patch16-ensemble"
THRESH, MAX_BOXES, MIN_AREA, NMS_IOU = 0.15, 5, 0.003, 0.6

device = "mps" if torch.backends.mps.is_available() else "cpu"
classifier = TreeOfLifeClassifier(device=device)
labels = classifier.get_label_data()


def load_cached_first(cls):
    """Load from the Hugging Face cache when the weights are already there, so a flaky or offline
    hub (it can answer 401 for an optional file) does not stop the sidecar; download otherwise."""
    try:
        return cls.from_pretrained(DETECTOR, local_files_only=True)
    except OSError:
        return cls.from_pretrained(DETECTOR)


processor = load_cached_first(Owlv2Processor)
detector = load_cached_first(Owlv2ForObjectDetection).eval()
lock = Lock()  # one inference at a time
_subsets = {}  # (region, "whole"|"bird") -> (embeddings, names)


def region_subset(region, kind):
    """The classifier's embeddings restricted to this region's species (cached after the first use)."""
    key = (region, kind)
    if key in _subsets:
        return _subsets[key]
    path = os.path.join(REGIONS_DIR, f"{region}.json")
    try:
        with open(path) as f:
            species = set(json.load(f)["species"])
    except (OSError, ValueError, KeyError):
        raise LookupError(f"no species list for region {region}: run build-species-regions")
    in_region = labels["species"].isin(species)
    if kind == "bird":
        mask = (labels["class"] == "Aves") & in_region
    else:
        mask = (labels["class"].isin(["Aves", "Mammalia", "Amphibia"]) & in_region) | (labels["class"] == "Reptilia")
    classifier.apply_filter([bool(x) for x in mask.values])
    _subsets[key] = (classifier._subset_txt_embeddings, classifier._subset_txt_names)
    return _subsets[key]


def predict(image, region, kind):
    emb, names = region_subset(region, kind)
    classifier._subset_txt_embeddings, classifier._subset_txt_names = emb, names
    result = classifier.predict([image], Rank.SPECIES, k=3)
    return [[r["common_name"], r["species"], r["class"], round(r["score"], 3)] for r in result]


def bird_boxes(image):
    w, h = image.size
    side = max(w, h)  # the detector pads to a square
    inputs = processor(text=[["a bird"]], images=image, return_tensors="pt")
    with torch.no_grad():
        out = detector(**inputs)
    res = processor.post_process_object_detection(out, threshold=THRESH, target_sizes=torch.tensor([[side, side]]))[0]
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
                self._send(200, identify(image, region))
        except LookupError as e:
            self._send(400, {"error": str(e)})
        except Exception as e:
            self._send(500, {"error": f"identification failed: {e}"})


if __name__ == "__main__":
    print(f"pixdex species sidecar on http://127.0.0.1:{PORT}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
