import json
from pathlib import Path

FIXTURES = json.loads((Path(__file__).parent / "fixtures.json").read_text())


async def handle(method, path, headers, body, env):
    if method == "GET" and path in FIXTURES:
        return 200, {"Content-Type": "application/json"}, json.dumps(FIXTURES[path]).encode()
    return 404, {"Content-Type": "application/json"}, b'{"error": "not found"}'
