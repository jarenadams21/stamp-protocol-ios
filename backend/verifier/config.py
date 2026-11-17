"""Environment-only configuration for the pinned upstream application."""

import os
import re

_master_key = os.environ.get("MASTER_KEY", "")
if not re.fullmatch(r"[0-9a-fA-F]{32}", _master_key):
    raise RuntimeError("MASTER_KEY must be configured as exactly 16 hex-encoded bytes.")

MASTER_KEY = bytes.fromhex(_master_key)
DERIVE_MODE = os.environ.get("DERIVE_MODE", "legacy")
if DERIVE_MODE != "legacy":
    raise RuntimeError("This service requires app-compatible DERIVE_MODE=legacy.")

ENC_PICC_DATA_PARAM = "picc_data"
ENC_FILE_DATA_PARAM = "enc"
UID_PARAM = "uid"
CTR_PARAM = "ctr"
SDMMAC_PARAM = "cmac"
REQUIRE_LRP = False
