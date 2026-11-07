"""Shipped enrollment policies must validate and match the guest's measured price floors.

Run offline with: python -m pytest -q host/test/test_profiles.py
"""

import ast
import importlib.util
import json
import subprocess
import sys
from pathlib import Path
from types import ModuleType

import pytest

ROOT = Path(__file__).resolve().parents[2]


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def validate_policy(monkeypatch):
    # Only the unused Souk event/action imports are stubbed. Run the actual
    # enrollment validator and its helpers, without needing a Souk host checkout.
    source = ROOT / "amin/souk.py"
    sdk = ModuleType("souk")

    def unused_sdk_call(*args, **kwargs):
        raise AssertionError("profile validation must not call the Souk SDK")

    for statement in ast.parse(source.read_text()).body:
        if isinstance(statement, ast.ImportFrom) and statement.module == "souk":
            for symbol in statement.names:
                setattr(sdk, symbol.name, unused_sdk_call)
    with monkeypatch.context() as context:
        context.setitem(sys.modules, "souk", sdk)
        return load_module("layover_profile_validator", source).policy


@pytest.fixture
def guest_environment(tmp_path, monkeypatch):
    monkeypatch.setenv("LAYOVER_ENV", "live")
    pack = load_module("layover_profile_guest_pack", ROOT / "guest/pack.py")
    # Minimal local release inputs exercise manifest(), without building a VM.
    base = tmp_path / "base"
    base.mkdir()
    (base / "metadata.json").write_text(json.dumps({"cmdline": "dstack.rootfs_hash=" + "00" * 32}))
    for filename in ("initramfs.cpio.gz", "Image", "rootfs.squashfs.verity", "sha256sum.txt"):
        (base / filename).write_bytes(b"offline fixture")
    starter = tmp_path / "starter.json"
    starter.write_text(json.dumps({"base_vm": {}, "limits": {}}))
    manifest = json.loads(pack.manifest(starter, base, "sha256:" + "11" * 32, "22" * 32, "profile-test"))
    return json.loads(manifest["docker_compose_file"])["services"]["agent"]["environment"]


@pytest.mark.parametrize("name", ["desktop", "laptop"])
def test_profile_enrolls_at_guest_price_floors(name, validate_policy, guest_environment):
    # join.sh sources these files and passes POLICY verbatim for enrollment.
    raw = subprocess.check_output(
        ["bash", "-eu", "-c", 'source "$1"; printf "%s\\n" "$POLICY"', "profile-test",
         str(ROOT / "host/profiles" / f"{name}.env")],
        text=True,
    )
    configured = json.loads(raw)
    parsed = validate_policy(configured)
    assert not any(key.endswith("_per_hour") for key in configured)
    assert parsed["floor_shared_per_gb"] == int(guest_environment["LEASE_FLOOR_SHARED"])
    assert parsed["floor_exclusive_per_gb"] == int(guest_environment["LEASE_FLOOR_PRICE_CHECK"])
