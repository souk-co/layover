"""DSMACK=<dsmack checkout> WEB=<copy of the web branch> python3 -m pytest couch/dsmack/preflight_test.py
Today's two packs (2026-11-06): the first carried brokerKey in PAYMENTS_CONFIG and left workload.img in disk/."""
import json, os, shutil, subprocess, sys
from pathlib import Path
import pytest

HERE = Path(__file__).resolve().parent
DATA = HERE.parent / "testdata"


def preflight(tmp_path, manifest, image):
    (tmp_path / image).parent.mkdir(parents=True, exist_ok=True)
    (tmp_path / image).write_bytes(b"")
    shutil.copy(DATA / manifest, tmp_path / "compose-manifest.json")
    (tmp_path / "operator.json").write_text(json.dumps({"guest": {"mem_mib": 4096, "vcpus": 1}}))
    return subprocess.run([sys.executable, HERE / "preflight.py", tmp_path, tmp_path / "operator.json", os.environ["DSMACK"], os.environ["WEB"]],
                          capture_output=True, text=True)


def test_brokerkey_manifest_is_refused_by_the_guest_decoder(tmp_path):
    r = preflight(tmp_path, "repin-20261106-brokerkey.json", "disk/workload.img")
    assert r.returncode != 0 and 'unknown field "brokerKey"' in r.stderr, r


def test_image_left_in_disk_is_refused_by_the_pool(tmp_path):
    r = preflight(tmp_path, "repin-20261106b.json", "disk/workload.img")
    assert r.returncode != 0 and "FileNotFoundError" in r.stderr and "workload.img" in r.stderr, r


def test_good_pack_passes(tmp_path):
    r = preflight(tmp_path, "repin-20261106b.json", "workload.img")
    assert r.returncode == 0, r
    assert "kit files served and mirrored" in r.stdout
