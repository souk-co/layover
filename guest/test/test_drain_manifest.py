"""Lightweight manifest wiring: no image build, VM launch, or dependency installation."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("guest_pack", Path(__file__).parents[1] / "pack.py")
pack = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(pack)

class DrainManifest(unittest.TestCase):
    def test_optional_challenge_is_scoped_to_agent_and_private_output_is_packaged(self):
        with tempfile.TemporaryDirectory() as directory:
            starter = Path(directory) / "starter.json"
            starter.write_text(json.dumps(dict(base_vm={}, limits={})))
            with patch.object(pack, "base_vm", return_value={}):
                manifest = json.loads(pack.manifest(starter, Path(directory), "sha256:" + "11" * 32, "22" * 32, "fixture"))
        challenge = [item for item in manifest["allowed_envs"] if item["name"] == "DRAIN_PREFLIGHT_CHALLENGE"]
        self.assertEqual(challenge, [dict(name="DRAIN_PREFLIGHT_CHALLENGE", audience="workload", services=["agent"])])
        self.assertNotIn("DRAIN_PREFLIGHT_CHALLENGE", manifest["required_envs"])
        compose = json.loads(manifest["docker_compose_file"])
        self.assertNotIn("DRAIN_PREFLIGHT_CHALLENGE", compose["services"]["agent"]["environment"])
        self.assertEqual(compose["services"]["agent"]["command"], ["/opt/resip/agent.mjs"])
        self.assertIn(dict(name="drain-checkpoint", path="/workspace/artifacts/drain-checkpoint"), manifest["outputs"]["artifacts"])
        self.assertIn(dict(name="guest-key", path="/workspace/artifacts/guest-key"), manifest["outputs"]["artifacts"])
        docker = (Path(__file__).parents[1] / "Dockerfile").read_text()
        self.assertIn("drain-preflight.mjs", docker)

if __name__ == "__main__": unittest.main()
