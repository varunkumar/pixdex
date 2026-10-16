"""Local face detection + embedding sidecar (InsightFace buffalo_l).

GET /health -> {"ok": true, "model": "buffalo_l"}
POST /faces (JPEG body) -> faces with pixel bbox and base64 float32 embedding.
Listens on 127.0.0.1 only. The caller sends an already EXIF-rotated image.
"""
import base64
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Lock

import cv2
import numpy as np
from insightface.app import FaceAnalysis

MODEL = "buffalo_l"
PORT = int(os.environ.get("PIXDEX_SIDECAR_PORT", "8799"))

app = FaceAnalysis(name=MODEL, providers=["CoreMLExecutionProvider", "CPUExecutionProvider"])
app.prepare(ctx_id=0, det_size=(640, 640))
lock = Lock()  # one inference at a time


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
        if self.path != "/faces":
            return self._send(404, {"error": "not found"})
        raw = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        img = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR)
        if img is None:
            return self._send(400, {"error": "invalid image"})
        with lock:
            found = app.get(img)
        faces = [
            {
                "bbox": [float(v) for v in f.bbox],
                "detScore": float(f.det_score),
                "embedding": base64.b64encode(f.normed_embedding.astype("<f4").tobytes()).decode(),
            }
            for f in found
        ]
        h, w = img.shape[:2]
        self._send(200, {"model": MODEL, "width": w, "height": h, "faces": faces})


if __name__ == "__main__":
    print(f"pixdex face sidecar on http://127.0.0.1:{PORT}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
