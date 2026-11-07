"""Exercise deploy packaging with stub transport; never reads credentials or deploys."""
import contextlib
import io
import json
import os
from pathlib import Path
import runpy
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).with_name("deploy.py")

class Response(io.BytesIO):
    def __init__(self, obj):
        super().__init__(json.dumps(obj).encode())

class DeploymentTest(unittest.TestCase):
    def package(self, pot_file=None):
        manifests = []
        def request(req, **kwargs):
            if not isinstance(req, str) and req.get_method() == "POST":
                body = req.data.split(b"\r\n\r\n", 1)[1].split(b"\r\n--", 1)[0]
                manifest = json.loads(body)
                manifests.append(manifest)
                return Response(dict(mode="attested", isolation="container", dstack_env=manifest["dstack_env"]))
            return Response(dict(address="public-wallet", admission_signer="public-signer"))
        def command(args, **kwargs):
            return "fixture-ref\n" if args[0] == "git" else b"// fixture bundle"
        env = {"TEE_DAEMON_TOKEN": "dummy-admin-token"}
        if pot_file:
            env["POT_KEY_FILE"] = str(pot_file)
        stdout = io.StringIO()
        with patch.dict(os.environ, env, clear=True), patch("urllib.request.urlopen", request), patch("subprocess.check_output", command), contextlib.redirect_stdout(stdout):
            runpy.run_path(str(SCRIPT), run_name="__main__")
        self.assertNotIn("dummy-admin-token", stdout.getvalue())
        self.assertEqual(manifests[0]["name"], "layover-accounts")
        self.assertEqual(manifests[0]["dstack_env"], {"ACCOUNTS_SEED": "accounts-seed-v1"})
        return manifests[0], stdout.getvalue()

    def test_redeploy_omits_env_to_preserve_stored_pot_and_configuration(self):
        manifest, _ = self.package()
        self.assertNotIn("env", manifest)

    def test_explicit_initial_pot_is_packaged_without_printing_or_changing_seed(self):
        with tempfile.TemporaryDirectory() as directory:
            key = "ab" * 32
            path = Path(directory) / "fixture.key"
            path.write_text(key)
            manifest, output = self.package(path)
        self.assertEqual(manifest["env"]["POT_KEY"], key)
        self.assertNotIn(key, output)

if __name__ == "__main__":
    unittest.main()
