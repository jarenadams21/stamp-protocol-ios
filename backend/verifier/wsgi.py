"""API-only wrapper; all SDM verification stays in the pinned upstream code."""

import logging
import os
import sys

logging.disable(logging.CRITICAL)
sys.path.append(os.environ.get("SDM_UPSTREAM_DIR", "/opt/sdm-upstream"))

from flask import Flask
from app import sdm_api_info_tt

app = Flask(__name__)
app.add_url_rule("/api/tagtt", view_func=sdm_api_info_tt, methods=["GET"])


@app.get("/healthz")
def health():
    return {"status": "ok"}
