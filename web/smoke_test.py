"""Exercise smoke readiness without importing its live, state-changing journey."""
import ast
import contextlib
import io
from pathlib import Path
import unittest
from unittest.mock import Mock


class MarketReadiness(unittest.TestCase):
    def run_wait(self, call):
        tree = ast.parse(Path(__file__).with_name("smoke.py").read_text())
        nodes = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in ("call", "wait_for_market")]
        namespace = {"time": Mock(monotonic=Mock(side_effect=[10, 27]))}
        exec(compile(ast.Module(body=nodes, type_ignores=[]), "smoke.py", "exec"), namespace)
        namespace["call"] = call
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            namespace["wait_for_market"]()
        return output.getvalue()

    def test_cold_read_reports_elapsed_time_and_status(self):
        call = Mock(return_value=(200, {}))
        output = self.run_wait(call)
        call.assert_called_once_with("market", timeout=60)
        self.assertIn("up to 60 s", output)
        self.assertIn("17.0 s: HTTP 200", output)

    def test_failure_is_not_retried(self):
        call = Mock(return_value=(502, {"error": "broker unavailable"}))
        with self.assertRaises(AssertionError):
            self.run_wait(call)
        call.assert_called_once_with("market", timeout=60)

    def test_timeout_is_not_retried(self):
        call = Mock(side_effect=TimeoutError("cold read expired"))
        with self.assertRaises(TimeoutError):
            self.run_wait(call)
        call.assert_called_once_with("market", timeout=60)


if __name__ == "__main__":
    unittest.main()
