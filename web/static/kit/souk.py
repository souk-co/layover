#!/usr/bin/env python3
"""Souk host connector (Python 3.11+; wallet and chain commands need eth-account).

  login <url> <email> [code]       save a person credential
  logout                         revoke and forget this credential
  list                           list joined Souks
  templates                      list available templates
  create --template X [--name N]
  create --program DIR [--name N]
  revise SOUK DIR                 install a new program revision
  guide|program|chain|inbox <souk>  read Souk information; chain lists
                                 my wallet and contracts with ABIs
  send <souk> '<json arguments>'  text, thread?, kind?, files?; plain text sends text
  answer <souk> <question> <value>  JSON, or plain text such as approve
  read <souk> <thread>
  invite <souk> <email> <role,...>
  wait <souk> [seconds]           wait for inbox changes
  wallet --key-file F [--previous-key-file P]
                                 sign locally and bind my wallet; P is the
                                 bound wallet's key when replacing it
  keygen --key-file F            create a new wallet key file (0600)
  fund <souk>                    Dev only: test ETH and TestUSD for my wallet
  tx <souk> CONTRACT METHOD [ARG...] --key-file F [--rpc URL]
                                 sign and send one call to a contract from
                                 souk_chain (or TestUSD); ARG is an integer,
                                 0x-address, 0x-bytes32 or text:<s> (keccak);
                                 --rpc is for a Souk outside Dev
  id TEXT                        keccak(TEXT) as a bytes32 id
  mcp                            serve the host tools over stdio, plus souk_wait

Each tool also accepts its full name and a JSON argument object.
SOUK_HOME selects the credential directory; SOUK_URL/SOUK_TOKEN override it.
files[].path attaches a visible file inside SOUK_FILES_DIR (default: the current directory).
An event_id acknowledges receipt, not settlement. Unknown writes are never retried.
"""

import argparse
import base64
import json
import mimetypes
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

CREDENTIAL = (
    Path(os.environ.get("SOUK_HOME", Path.home() / ".config/souk")) / "credential.json"
)
TIMEOUT = 60
WAIT_LIMIT = 600
TOOLS = {
    "souk_" + name
    for name in (
        "wallet_challenge",
        "wallet",
        "logout",
        "list",
        "templates",
        "create",
        "revise",
        "guide",
        "program",
        "chain",
        "inbox",
        "send",
        "answer",
        "read",
        "invite",
    )
}
WRITES = {
    "souk_wallet_challenge",
    "souk_wallet",
    "souk_send",
    "souk_answer",
    "souk_invite",
    "souk_create",
    "souk_revise",
}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    # Following one would send the bearer token wherever the redirect points.
    def redirect_request(self, *args):
        return None


class SoukError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(f"HTTP {status}: {message}" if status else message)
        self.status = status


def credential() -> tuple[str, str]:
    saved = json.loads(CREDENTIAL.read_text()) if CREDENTIAL.exists() else {}
    url = os.environ.get("SOUK_URL") or saved.get("url")
    token = os.environ.get("SOUK_TOKEN") or saved.get("token")
    if not url or not token:
        raise SoukError(0, "Not signed in. Run: account login EMAIL (buyers, per SKILL.md) or souk.py login <url> <email> (hosts, per HOSTING.md)")
    return url.rstrip("/"), token


def http(
    method: str,
    url: str,
    body: Any = None,
    headers: dict[str, str] | None = None,
) -> tuple[int, Any, Any]:
    request = urllib.request.Request(
        url,
        method=method,
        data=None if body is None else json.dumps(body).encode(),
        headers={"Content-Type": "application/json", **(headers or {})},
    )
    # Reads retry a dropped connection; commands are never resent.
    attempts = 3 if method == "GET" else 1
    try:
        for attempt in range(attempts):
            try:
                with urllib.request.build_opener(NoRedirect).open(
                    request, timeout=TIMEOUT
                ) as response:
                    return (
                        response.status,
                        json.loads(response.read() or b"null"),
                        response.headers,
                    )
            except urllib.error.HTTPError:
                raise
            except (urllib.error.URLError, ConnectionError):
                if attempt == attempts - 1:
                    raise
                time.sleep(2 * (attempt + 1))
        raise AssertionError("unreachable")
    except urllib.error.HTTPError as error:
        if 300 <= error.code < 400:
            raise SoukError(error.code, "redirect refused; use the final URL") from None
        payload = json.loads(error.read() or b"null")
        message = (payload or {}).get("error") or error.reason
        if isinstance(message, dict):
            message = message.get("message", error.reason)
        if error.code == 401:
            message = f"{message}; sign in again with: account login EMAIL (buyers, per SKILL.md) or souk.py login <url> <email> (hosts, per HOSTING.md)"
        raise SoukError(error.code, str(message)) from None


def json_or_text(value: str, key: str | None = None) -> Any:
    """A JSON argument, or plain text: `answer … approve` and `send S hello` both work."""
    if not value.strip():
        raise ValueError("empty argument")
    try:
        parsed = json.loads(value)
    except ValueError:
        return value if key is None else {key: value}
    if key is None:
        return parsed
    return parsed if isinstance(parsed, dict) else {key: value}


def api(method: str, path: str, body: Any = None) -> Any:
    url, token = credential()
    return http(method, url + path, body, {"Authorization": "Bearer " + token})[1]


def login(url, email, code=None):
    url = url.rstrip("/")
    pending = CREDENTIAL.with_name("pending.json")
    saved = json.loads(pending.read_text()) if pending.exists() else {}
    if code is not None and (saved.get("url"), saved.get("email")) == (url, email):
        # The mailed code belongs to the request that sent it, not to a new one.
        challenge = saved["challenge_id"]
    else:
        challenge = http("POST", url + "/api/auth/code", {"email": email})[1][
            "challenge_id"
        ]
    if code is None:
        if not sys.stdin.isatty():
            # Agents cannot answer a prompt: they rerun with the code instead.
            write_private(
                pending, {"url": url, "email": email, "challenge_id": challenge}
            )
            return {"code_sent": email, "next": f"souk.py login {url} {email} <code>"}
        print(f"A sign-in code was sent to {email}.", file=sys.stderr)
        code = input("Code: ").strip()
    result = http(
        "POST",
        url + "/api/auth/verify",
        {"challenge_id": challenge, "code": code},
    )[1]
    write_private(CREDENTIAL, {"url": url, "email": email, "token": result["token"]})
    pending.unlink(missing_ok=True)
    return {"signed_in": email, "person": result["person"], "url": url}


def write_private(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_suffix(".tmp")
    # Set permissions before writing the bearer secret.
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        os.fchmod(f.fileno(), 0o600)
        json.dump(value, f)
    temporary.replace(path)


def attachment(name):
    # Any message can tell an agent what to attach, so the connector reads only visible
    # files inside its files folder: never ~/.ssh, its own credentials or /proc.
    root = Path(os.environ.get("SOUK_FILES_DIR") or os.getcwd()).resolve()
    path = (root / name).resolve()
    if (
        root == Path(root.anchor)
        or not path.is_relative_to(root)
        or any(part.startswith(".") for part in path.relative_to(root).parts)
        or not path.is_file()
    ):
        raise ValueError(
            f"files[].path must name a visible file inside {root}; "
            "set SOUK_FILES_DIR to choose the folder"
        )
    return path


def call_tool(name, args):
    if name not in TOOLS or not isinstance(args, dict):
        raise ValueError("Unknown tool or invalid arguments")
    args = dict(args)
    if name == "souk_send" and "files" in args:
        args["files"] = [
            {
                "filename": Path(file["path"]).name,
                "mime_type": file.get("mime_type")
                or mimetypes.guess_type(file["path"])[0]
                or "application/octet-stream",
                "data_base64": base64.b64encode(
                    attachment(file["path"]).read_bytes()
                ).decode("ascii"),
            }
            if "path" in file
            else file
            for file in args["files"]
        ]
    try:
        return api("POST", "/api/" + name, args)
    except OSError as error:
        if name not in WRITES:
            raise
        return {
            "outcome": "unknown",
            "error": str(error),
            "next": "Read souk_list, souk_program or souk_inbox to reconcile; do not automatically resend.",
        }


def wait(souk_id, timeout=120):
    before = call_tool("souk_inbox", {"souk_id": souk_id})
    deadline = time.monotonic() + max(1, min(timeout, WAIT_LIMIT))
    while time.monotonic() < deadline:
        time.sleep(min(3, max(0, deadline - time.monotonic())))
        current = call_tool("souk_inbox", {"souk_id": souk_id})
        if current != before:
            return {"changed": True, "updates": current}
    return {"changed": False, "updates": before}


# Waiting is local: the connector polls the inbox, so an MCP-only agent can wait for a
# reply or card without polling souk_inbox itself.
WAIT_TOOL = {
    "name": "souk_wait",
    "description": "Wait until my souk_inbox changes (a reply, post or card arrives), "
    "up to `seconds` (default 60); returns the inbox and whether it changed",
    "inputSchema": {
        "type": "object",
        "properties": {"souk_id": {"type": "string"}, "seconds": {"type": "integer"}},
        "required": ["souk_id"],
    },
}


def handle(message):
    if (
        not isinstance(message, dict)
        or message.get("jsonrpc") != "2.0"
        or not isinstance(message.get("method"), str)
    ):
        return {
            "jsonrpc": "2.0",
            "id": None,
            "error": {"code": -32600, "message": "Invalid Request"},
        }
    if "id" not in message:
        return None
    reply = {"jsonrpc": "2.0", "id": message["id"]}
    try:
        if message["method"] == "tools/list":
            listed = api("POST", "/mcp", message)
            listed.get("result", {}).get("tools", []).append(WAIT_TOOL)
            return listed
        if message["method"] != "tools/call":
            return api("POST", "/mcp", message)
        params = message.get("params", {})
        arguments = params.get("arguments", {})
        value = (
            wait(arguments["souk_id"], int(arguments.get("seconds", 60)))
            if params["name"] == "souk_wait"
            else call_tool(params["name"], arguments)
        )
        return reply | {
            "result": {
                "content": [
                    {
                        "type": "text",
                        "text": value if isinstance(value, str) else json.dumps(value),
                    }
                ]
            }
        }
    except (SoukError, OSError, KeyError, ValueError, TypeError) as error:
        return reply | {
            "result": {
                "isError": True,
                "content": [{"type": "text", "text": str(error)}],
            }
        }


def serve_mcp():
    for line in sys.stdin:
        if not line.strip():
            continue
        try:
            reply = handle(json.loads(line))
        except json.JSONDecodeError:
            reply = {
                "jsonrpc": "2.0",
                "id": None,
                "error": {"code": -32700, "message": "Invalid JSON"},
            }
        if reply is not None:
            print(json.dumps(reply), flush=True)


def signature(item):
    return item["name"] + "(" + ",".join(x["type"] for x in item["inputs"]) + ")"


def argument(kind, text):
    from eth_utils import keccak, to_checksum_address

    try:
        if kind.startswith(("uint", "int")):
            return int(text, 0)
        if kind == "address":
            return to_checksum_address(text)
        if kind == "bytes32":
            value = (
                keccak(text=text[5:])
                if text.startswith("text:")
                else bytes.fromhex(text.removeprefix("0x"))
            )
            if len(value) == 32:
                return value
    except ValueError:
        pass
    raise ValueError(
        f"cannot read {text!r} as {kind}; use an integer, a 0x address,"
        " 0x plus 64 hex digits, or text:<string>"
    )


def plain(kind, value):
    from eth_utils import to_checksum_address

    if kind == "address":
        return to_checksum_address(value)
    return "0x" + value.hex() if isinstance(value, bytes) else value


def events(contracts, logs):
    from eth_abi import decode
    from eth_utils import keccak

    decoded = []
    for log in logs:
        for name, contract in contracts.items():
            if contract["address"].lower() != log["address"].lower():
                continue
            for item in contract["abi"]:
                if item["type"] != "event" or log["topics"][0].lower() != (
                    "0x" + keccak(text=signature(item)).hex()
                ):
                    continue
                indexed = iter(log["topics"][1:])
                data = iter(
                    decode(
                        [x["type"] for x in item["inputs"] if not x["indexed"]],
                        bytes.fromhex(log["data"][2:]),
                    )
                )
                decoded.append(
                    {
                        "contract": name,
                        "event": item["name"],
                        "args": {
                            x["name"]: plain(
                                x["type"],
                                decode([x["type"]], bytes.fromhex(next(indexed)[2:]))[0]
                                if x["indexed"]
                                else next(data),
                            )
                            for x in item["inputs"]
                        },
                    }
                )
    return decoded


def transact(souk_id, contract, method, values, key_file, rpc_url=None):
    from eth_abi import encode
    from eth_account import Account
    from eth_utils import keccak, to_checksum_address

    chain = call_tool("souk_chain", {"souk_id": souk_id})
    contracts = chain["contracts"]
    account = Account.from_key(Path(key_file).read_text().strip())
    # The program knows people only by their bound wallets.
    if (chain["wallet"] or "").lower() != account.address.lower():
        raise SoukError(
            0,
            f"{account.address} is not your bound wallet;"
            f" run: souk.py wallet --key-file {key_file}",
        )
    if contract not in contracts:
        raise SoukError(0, f"{contract} is not one of {sorted(contracts)}")
    item = next(
        (
            x
            for x in contracts[contract]["abi"]
            if x["type"] == "function"
            and x["name"] == method
            and len(x["inputs"]) == len(values)
        ),
        None,
    )
    if item is None:
        raise SoukError(0, f"{contract} has no {method} taking {len(values)} arguments")
    data = (
        "0x"
        + (
            keccak(text=signature(item))[:4]
            + encode(
                [x["type"] for x in item["inputs"]],
                [argument(x["type"], v) for x, v in zip(item["inputs"], values)],
            )
        ).hex()
    )
    errors = {
        "0x" + keccak(text=signature(x))[:4].hex(): x["name"]
        for c in contracts.values()
        for x in c["abi"]
        if x["type"] == "error"
    }

    def rpc(name, *params):
        body = {"jsonrpc": "2.0", "id": 1, "method": name, "params": list(params)}
        reply = (
            http("POST", rpc_url, body)[1]
            if rpc_url
            else api("POST", "/api/dev/chain", body)
        )
        if "error" in reply:
            error = reply["error"]
            data = str(error.get("data") or "")
            reason = errors.get(data[:10], error.get("message", error))
            raise SoukError(0, f"{contract}.{method}: {reason}")
        return reply["result"]

    if int(rpc("eth_chainId"), 16) != chain["chain_id"]:
        raise SoukError(0, "the RPC is not on this Souk's chain")
    tx = {
        "to": to_checksum_address(contracts[contract]["address"]),
        "data": data,
        "value": 0,
        "chainId": chain["chain_id"],
        "nonce": int(rpc("eth_getTransactionCount", account.address, "pending"), 16),
        "gasPrice": int(rpc("eth_gasPrice"), 16),
    }
    estimate = {"from": account.address, "to": tx["to"], "data": data}
    tx["gas"] = int(rpc("eth_estimateGas", estimate), 16) * 12 // 10
    signed = account.sign_transaction(tx)
    tx_hash = "0x" + signed.hash.hex()
    try:
        rpc("eth_sendRawTransaction", "0x" + signed.raw_transaction.hex())
    except (SoukError, OSError) as error:
        if getattr(error, "status", None) == 0:
            raise  # the node answered and refused it
        # A lost reply may still have been broadcast: resending could pay twice.
        raise SoukError(
            0, f"outcome unknown for {tx_hash}: {error}; check it, do not resend"
        ) from None
    deadline = time.monotonic() + WAIT_LIMIT
    while (receipt := rpc("eth_getTransactionReceipt", tx_hash)) is None:
        if time.monotonic() > deadline:
            raise SoukError(0, f"no receipt yet for {tx_hash}; check it, do not resend")
        time.sleep(1)
    if int(receipt["status"], 16) != 1:
        raise SoukError(0, f"{contract}.{method} reverted in {tx_hash}")
    return {
        "tx_hash": tx_hash,
        "status": "success",
        "block": int(receipt["blockNumber"], 16),
        "events": events(contracts, receipt["logs"]),
    }


def read_bundle(directory):
    root = Path(directory)
    bundle = {"souk.py": (root / "souk.py").read_text()}
    for name in ("prompts", "tools"):
        for file in sorted((root / name).rglob("*")):
            if file.is_file() and file.suffix in {".md", ".py"}:
                bundle[file.relative_to(root).as_posix()] = file.read_text()
    return bundle


def main(argv):
    if not argv or argv[0] in {"help", "--help", "-h"}:
        print(__doc__)
        return 0
    command, *rest = argv
    try:
        if command == "mcp":
            serve_mcp()
            return 0
        if command == "login":
            result = login(*rest)
        elif command == "wallet":
            from eth_account import Account
            from eth_account.messages import encode_defunct

            parser = argparse.ArgumentParser(prog="souk wallet")
            parser.add_argument("--key-file", required=True)
            parser.add_argument("--previous-key-file")
            options = parser.parse_args(rest)
            account = Account.from_key(Path(options.key_file).read_text().strip())
            text = call_tool("souk_wallet_challenge", {})
            args = {
                "address": account.address,
                "signature": account.sign_message(
                    encode_defunct(text=text)
                ).signature.hex(),
            }
            if options.previous_key_file:
                previous = Account.from_key(
                    Path(options.previous_key_file).read_text().strip()
                )
                args["previous_signature"] = previous.sign_message(
                    encode_defunct(
                        text=f"{text}\nReplace with: {account.address.lower()}"
                    )
                ).signature.hex()
            result = call_tool("souk_wallet", args)
        elif command == "keygen":
            from eth_account import Account

            parser = argparse.ArgumentParser(prog="souk keygen")
            parser.add_argument("--key-file", required=True)
            options = parser.parse_args(rest)
            account = Account.create()
            # O_EXCL: an existing key file may control funds.
            fd = os.open(options.key_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "w") as f:
                f.write("0x" + bytes(account.key).hex())
            result = {"address": account.address, "key_file": options.key_file}
        elif command == "fund":
            wallet = call_tool("souk_chain", {"souk_id": rest[0]})["wallet"]
            if not wallet:
                raise SoukError(0, "Bind a wallet first: souk.py wallet --key-file F")
            result = api("POST", "/api/dev/faucet", {"address": wallet})
        elif command == "tx":
            parser = argparse.ArgumentParser(prog="souk tx")
            for name in ("souk", "contract", "method"):
                parser.add_argument(name)
            parser.add_argument("args", nargs="*")
            parser.add_argument("--key-file", required=True)
            parser.add_argument("--rpc")
            options = parser.parse_args(rest)
            result = transact(
                options.souk,
                options.contract,
                options.method,
                options.args,
                options.key_file,
                options.rpc,
            )
        elif command == "id":
            from eth_utils import keccak

            result = "0x" + keccak(text=rest[0]).hex()
        elif command == "logout":
            result = call_tool("souk_logout", {})
            if not os.environ.get("SOUK_TOKEN"):
                CREDENTIAL.unlink(missing_ok=True)
        elif command == "create":
            parser = argparse.ArgumentParser(prog="souk create")
            source = parser.add_mutually_exclusive_group(required=True)
            source.add_argument("--template")
            source.add_argument("--program")
            parser.add_argument("--name")
            options = parser.parse_args(rest)
            args = (
                {"template": options.template}
                if options.template is not None
                else {"bundle": read_bundle(options.program)}
            )
            if options.name is not None:
                args["name"] = options.name
            result = call_tool("souk_create", args)
        elif command == "revise":
            result = call_tool(
                "souk_revise", {"souk_id": rest[0], "bundle": read_bundle(rest[1])}
            )
        elif command == "wait":
            result = wait(rest[0], int(rest[1]) if len(rest) > 1 else 120)
        elif command in TOOLS:
            result = call_tool(command, json.loads(rest[0]) if rest else {})
        else:
            args = (
                {}
                if command in {"list", "souks", "templates"}
                else {"souk_id": rest[0]}
            )
            if command == "send":
                args.update(json_or_text(rest[1], "text"))
            elif command == "answer":
                args.update(question_id=rest[1], value=json_or_text(rest[2]))
            elif command == "read":
                args["thread_id"] = rest[1]
            elif command == "invite":
                args.update(email_or_person=rest[1], roles=rest[2].split(","))
            result = call_tool(
                "souk_" + ("list" if command == "souks" else command), args
            )
        print(
            result
            if isinstance(result, str)
            else json.dumps(result, ensure_ascii=False, indent=1)
        )
        return 0
    except (SoukError, OSError, IndexError, KeyError, ValueError, TypeError) as error:
        print(f"souk: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
